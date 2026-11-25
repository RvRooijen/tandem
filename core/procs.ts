// The agent and the drawing workers are started by the process that looks after the core (core/start.ts), not by
// the core itself: the core starts again after code is accepted, and they go on meanwhile. The core asks for them
// over its IPC channel and hears what they write and when they end; a core started again takes up the ones that
// are still there. Without someone looking after it (the tests, `node core/server.ts`) the core starts them itself.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** What the core needs of a process it started: what it writes, when it ends, and stopping it. */
export interface Proc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  on(event: 'close', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  kill(): unknown;
}

export interface ProcStart { cwd: string; env: NodeJS.ProcessEnv; input: string }

type ToHost =
  | { proc: 'start'; id: string; cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; input: string }
  | { proc: 'kill'; id: string }
  | { proc: 'attach'; id: string }
  | { proc: 'detach' };

type ToCore =
  | { proc: 'out' | 'err'; id: string; data: string }
  | { proc: 'exit'; id: string; code: number | null }
  | { proc: 'error'; id: string; message: string }
  | { proc: 'detached' };

function launch(cmd: string, args: string[], o: ProcStart): ChildProcess {
  const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin!.on('error', () => { /* it went before it read it; its exit says why */ });
  p.stdin!.end(o.input);
  return p;
}

// --- In the core ---

// (TANDEM_PROCS is there, empty or not, when what started the core can do this: one from before it could not.)
const supervised = !!process.env.TANDEM_SUPERVISED && process.env.TANDEM_PROCS !== undefined && typeof process.send === 'function';
/** What the one before this core left running (or ended since, with what it wrote waiting). */
const offered = new Set((process.env.TANDEM_PROCS ?? '').split(',').filter(Boolean));
const remotes = new Map<string, Remote>();
let detached = false, onDetached: (() => void) | undefined;
/** Done when the core lets go of its processes, after the last of what they wrote has come in: their state is saved here. */
export const onDetach: (() => void)[] = [];

class Remote extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  id: string;
  constructor(id: string) { super(); this.id = id; }
  kill() { if (!detached) tell({ proc: 'kill', id: this.id }); }
}

function tell(m: ToHost) { if (process.connected) process.send!(m); }

if (supervised) {
  process.on('message', (m: ToCore) => {
    if (!m || typeof m !== 'object' || !('proc' in m)) return;
    if (m.proc === 'detached') return onDetached?.();
    const r = remotes.get(m.id);
    if (!r) return;
    if (m.proc === 'out') r.stdout.emit('data', m.data);
    else if (m.proc === 'err') r.stderr.emit('data', m.data);
    else if (m.proc === 'error') r.emit('error', new Error(m.message));
    else if (m.proc === 'exit') { remotes.delete(m.id); r.emit('close', m.code); }
  });
}

export function startProc(id: string, cmd: string, args: string[], o: ProcStart): Proc {
  if (!supervised) return launch(cmd, args, o) as unknown as Proc;
  const r = new Remote(id);
  remotes.set(id, r);
  tell({ proc: 'start', id, cmd, args, cwd: o.cwd, env: o.env, input: o.input });
  return r;
}

/** The process by this id that was running when this core started, taken up again; what it wrote meanwhile follows. */
export function runningProc(id: string): Proc | undefined {
  if (!supervised || !offered.delete(id)) return undefined;
  const r = new Remote(id);
  remotes.set(id, r);
  tell({ proc: 'attach', id });
  return r;
}

/**
 * Let go of the processes before the core ends to start again: they go on, and the next core takes them up. What
 * they wrote before the host heard this has come in when it answers; after that it waits for the next core.
 */
export function detach(): Promise<void> {
  if (!supervised || detached) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => {
      if (detached) return;
      detached = true;
      for (const fn of onDetach) { try { fn(); } catch { /* the rest still saves */ } }
      done();
    };
    onDetached = finish;
    tell({ proc: 'detach' });
    setTimeout(finish, 3000).unref?.();
  });
}

// --- In the process that looks after the core ---

interface Kept { proc: ChildProcess; partial: string; waiting: ToCore[]; listening: boolean; ended: boolean; offered: boolean }

/**
 * Starts and keeps the core's processes. `send` reaches the core that is running now. A core that let go (detach)
 * or ended has nothing sent to it; what comes meanwhile waits for the next core to take the process up.
 */
export function createProcHost() {
  const kept = new Map<string, Kept>();
  let send: ((m: ToCore) => void) | undefined;
  /** The core that runs now let go of its processes: they outlive it. */
  let letGo = false;

  const pass = (id: string, m: ToCore) => {
    const k = kept.get(id);
    if (!k) return;
    if (k.listening && send) send(m); else k.waiting.push(m);
    if (m.proc === 'exit' && k.listening && send) kept.delete(id);
  };

  function start(id: string, cmd: string, args: string[], o: ProcStart) {
    kept.get(id)?.proc.kill();
    let proc: ChildProcess;
    try { proc = launch(cmd, args, o); } catch (e) {
      send?.({ proc: 'error', id, message: e instanceof Error ? e.message : String(e) });
      send?.({ proc: 'exit', id, code: null });
      return;
    }
    const k: Kept = { proc, partial: '', waiting: [], listening: true, ended: false, offered: false };
    kept.set(id, k);
    // Whole lines only: a core that ends in the middle of one would leave the next a piece it cannot read.
    proc.stdout!.on('data', (d: Buffer) => {
      if (kept.get(id) !== k) return;
      const text = k.partial + d.toString();
      const end = text.lastIndexOf('\n');
      k.partial = text.slice(end + 1);
      if (end >= 0) pass(id, { proc: 'out', id, data: text.slice(0, end + 1) });
    });
    proc.stderr!.on('data', (d: Buffer) => { if (kept.get(id) === k) pass(id, { proc: 'err', id, data: d.toString() }); });
    proc.on('error', (e) => { if (kept.get(id) === k) pass(id, { proc: 'error', id, message: e.message }); });
    proc.on('close', (code) => {
      if (kept.get(id) !== k) return;
      k.ended = true;
      if (k.partial) pass(id, { proc: 'out', id, data: k.partial });
      pass(id, { proc: 'exit', id, code });
    });
  }

  return {
    /** A core starts: the ids of what it can take up, for its environment (TANDEM_PROCS). */
    offer(): string {
      for (const k of kept.values()) k.offered = true;
      return [...kept.keys()].join(',');
    },
    /** The core that runs now, and how to reach it. */
    connect(to: (m: ToCore) => void) { send = to; letGo = false; },
    message(m: ToHost) {
      if (!m || typeof m !== 'object' || !('proc' in m)) return false;
      if (m.proc === 'start') start(m.id, m.cmd, m.args, { cwd: m.cwd, env: m.env, input: m.input });
      else if (m.proc === 'kill') kept.get(m.id)?.proc.kill();
      else if (m.proc === 'detach') {
        for (const k of kept.values()) k.listening = false;
        letGo = true;
        send?.({ proc: 'detached' });
        send = undefined;
      } else if (m.proc === 'attach') {
        const k = kept.get(m.id);
        if (!k) { send?.({ proc: 'exit', id: m.id, code: null }); return true; }
        k.listening = true;
        for (const w of k.waiting.splice(0)) send?.(w);
        if (k.ended) kept.delete(m.id);
      }
      return true;
    },
    /**
     * The core ended. Without having let go (it crashed, or another project is opened), what it started stops
     * with it. Having let go, they go on; what had ended and was offered to it but not taken up is forgotten.
     */
    exited() {
      send = undefined;
      for (const [id, k] of kept) {
        if (!letGo) { k.proc.kill(); kept.delete(id); continue; }
        k.listening = false;
        if (k.ended && k.offered) kept.delete(id);
      }
    },
    stopAll() { for (const k of kept.values()) k.proc.kill(); kept.clear(); },
  };
}
