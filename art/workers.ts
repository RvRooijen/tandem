// Drawing workers: a headless Claude per piece of drawing work, with
// pixeldraw's way of working (art/GUIDE.md): silhouette first, then colour, in
// rounds of edit, render, look. A worker draws in its own workspace and can
// change only the drawings it was asked about. When a run ends, what it
// changed becomes a proposal with a picture before and after; the person
// approves the silhouette, gives feedback, accepts or rejects.
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventLog } from '../core/events.ts';
import type { Proposals } from '../core/proposals.ts';
import type { Workspaces } from './workspace.ts';

const GUIDE = fileURLToPath(new URL('./GUIDE.md', import.meta.url));

/** A string of a tool call that is still being typed: as much of it as has arrived. (pixeldraw's.) */
function partialString(json: string, key: string): { value: string; done: boolean } | null {
  const start = json.match(new RegExp(`"${key}"\\s*:\\s*"`));
  if (!start) return null;
  let raw = json.slice(start.index! + start[0].length);
  const end = raw.search(/(?<!\\)(?:\\\\)*"/);
  const done = end >= 0;
  if (done) raw = raw.slice(0, raw.slice(end).indexOf('"') + end);
  // Drop a trailing incomplete escape sequence
  for (let cut = 0; cut <= 6; cut++) {
    try { return { value: JSON.parse(`"${raw.slice(0, raw.length - cut)}"`), done }; } catch { /* a shorter one */ }
  }
  return null;
}

export interface Worker {
  id: string;
  /** The drawings it may change; the first is the one it was asked about. */
  names: string[];
  title: string;
  by: string;
  session?: string;
  /** The phase its last run finished: after silhouette it waits for approval, after color for acceptance. */
  phase: 'silhouette' | 'color';
  state: 'running' | 'waiting' | 'stopped' | 'failed';
  /** What it is doing right now, or what it said last. */
  doing: string;
  said: string;
  started: number;
}

// What only a worker needs to hear; the way of working itself is in the guide.
const NOTE = `You work in your own workspace: a copy of the game's drawings, paths like art/<name>.txt are relative to it. Only when the person accepts do your changes go into the game. So just work in the files it is about.
As <name> in event.js calls, always use the name of the file you are working on at that moment (without art/ and .txt).

Work the way the guide describes (phases, rounds with round and feedback events, drawing by hand). Work on your own and don't ask questions: at the end of a phase send \`node scripts/event.js phase <name> <silhouette|color>\` and stop with a short summary, then the person gives feedback.`;

export interface WorkersOptions {
  spaces: Workspaces;
  events: EventLog;
  proposals: Proposals;
  /** A new file for a picture, and the address the page gets it from. */
  newLookFile(): { file: string; url: string };
}

export function createWorkers(o: WorkersOptions) {
  const { spaces, events, proposals } = o;
  const runs = new Map<string, ChildProcess>();
  const stopped = new Set<string>();

  /** The workers that are drawing right now, as they are this moment; the others are read from their file. */
  const active = new Map<string, Worker>();
  const file = (id: string) => join(spaces.dir(id), 'worker.json');
  const get = (id: string): Worker | undefined => {
    if (active.has(id)) return active.get(id);
    try { return JSON.parse(readFileSync(file(id), 'utf8')) as Worker; } catch { return undefined; }
  };
  const save = (w: Worker) => writeFileSync(file(w.id), JSON.stringify(w, null, 2));
  const cast = (w: Worker) => events.cast({ type: 'art.status', worker: w.id, name: w.names[0], state: w.state, phase: w.phase, doing: w.doing });

  // A worker that was running when the engine stopped is not running any more.
  for (const id of spaces.list()) {
    const w = get(id);
    if (w?.state === 'running') { w.state = 'stopped'; w.doing = 'stopped when the engine did'; save(w); }
  }

  /** Its changes as one round of proposals, each with a picture before and after. */
  async function propose(w: Worker) {
    for (const c of spaces.changes(w.id)) {
      if (!w.names.includes(c.name)) continue;
      const pictures: { before?: string; after?: string; depth?: string } = {};
      try {
        const after = o.newLookFile();
        copyFileSync(await spaces.render(w.id, `art/${c.name}.txt`), after.file);
        pictures.after = after.url;
        if (c.before.text !== undefined) {
          // The drawing as it was, rendered in a workspace of its own.
          spaces.ensure('_before', true);
          const before = o.newLookFile();
          copyFileSync(await spaces.render('_before', `art/${c.name}.txt`), before.file);
          pictures.before = before.url;
        }
      } catch (e) {
        w.said = `${w.said}\n(It could not be rendered: ${e instanceof Error ? e.message : e})`.trim();
      }
      const after = { text: c.after.text!, ...(c.after.depth !== undefined && { depth: c.after.depth }) };
      const before = c.before.text !== undefined ? { text: c.before.text, ...(c.before.depth !== undefined && { depth: c.before.depth }) } : undefined;
      const p = proposals.add({ round: w.id, by: `agent:${w.id}`, kind: 'drawing', path: c.name, before, after, note: w.said });
      events.add({ type: 'proposal', by: `agent:${w.id}`, round: w.id, id: p.id, kind: 'drawing', path: c.name, worker: w.id, phase: w.phase, pictures, note: w.said, isNew: c.before.text === undefined });
    }
  }

  function run(w: Worker, prompt: string) {
    w.state = 'running'; w.doing = 'starting'; w.said = '';
    active.set(w.id, w);
    save(w); cast(w);
    const edit = w.names.flatMap((n) => [`Edit(art/${n}.txt)`, `Write(art/${n}.txt)`, `Edit(depth/${n}.txt)`, `Write(depth/${n}.txt)`]);
    const proc = spawn(process.env.CLAUDE_BIN ?? 'claude', [
      '-p', prompt, '--append-system-prompt', readFileSync(GUIDE, 'utf8'),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', process.env.TANDEM_ART_MODEL ?? process.env.TANDEM_MODEL ?? 'claude-fable-5-2', '--effort', process.env.TANDEM_ART_EFFORT ?? 'high',
      ...(w.session ? ['--resume', w.session] : []),
      // Only what is listed: reading the workspace, changing the drawings asked about, rendering and reporting.
      '--permission-mode', 'default', '--allowedTools',
      'Read(art/**)', 'Read(depth/**)', 'Read(out/**)', 'Read(scratch/**)', 'Edit(scratch/**)', 'Write(scratch/**)', ...edit,
      'Bash(node scripts/render.js:*)', 'Bash(node scripts/event.js:*)', 'Bash(node scripts/scratch.js:*)',
    ], { cwd: spaces.dir(w.id), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PIXEL_WORKER: w.id } });
    runs.set(w.id, proc);
    let buf = '', err = '', failed = '', lastCast = 0;
    const timer = setTimeout(() => { failed = 'it took more than forty minutes and was stopped'; proc.kill(); }, 40 * 60_000);
    const doing = (text: string) => {
      w.doing = text;
      if (Date.now() - lastCast > 400) { lastCast = Date.now(); cast(w); }
    };
    // Write and Edit calls on a drawing are told as they are typed: the file as it will be with what has arrived
    // so far, so whoever watches sees it being drawn. (The way pixeldraw's viewer is fed.)
    const blocks: Record<number, { name: string; json: string; base?: string }> = {};
    let lastDraft = 0;
    const draft = (block: { name: string; json: string; base?: string }, force = false) => {
      const now = Date.now();
      if (!force && now - lastDraft < 300) return;
      const m = block.json.match(/"file_path"\s*:\s*"[^"]*\/(art|depth)\/([\w-]+)\.txt"/);
      if (!m) return;
      let text: string | undefined;
      if (block.name === 'Write') text = partialString(block.json, 'content')?.value;
      else {
        const from = partialString(block.json, 'old_string'), to = partialString(block.json, 'new_string');
        if (!from?.done || !to) return;
        const path = join(spaces.dir(w.id), m[1], `${m[2]}.txt`);
        block.base ??= existsSync(path) ? readFileSync(path, 'utf8') : '';
        if (!block.base.includes(from.value)) return;
        text = block.base.replace(from.value, () => to.value);
      }
      if (text === undefined) return;
      lastDraft = now;
      events.cast({ type: 'art.draft', worker: w.id, name: m[2], depth: m[1] === 'depth', text });
    };

    proc.stderr!.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.stdout!.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.session_id) w.session = msg.session_id;
        if (msg.type === 'stream_event') {
          const e = msg.event;
          if (e?.type === 'content_block_start') {
            const kind = e.content_block?.type;
            if (kind === 'thinking') doing('thinking');
            else if (kind === 'text') doing('writing');
            else if (kind === 'tool_use' && (e.content_block.name === 'Write' || e.content_block.name === 'Edit')) blocks[e.index] = { name: e.content_block.name, json: '' };
          } else if (e?.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && blocks[e.index]) {
            blocks[e.index].json += e.delta.partial_json;
            draft(blocks[e.index]);
          } else if (e?.type === 'content_block_stop' && blocks[e.index]) {
            draft(blocks[e.index], true);
            delete blocks[e.index];
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text.trim()) w.said = block.text.trim();
            if (block.type === 'tool_use') {
              const path = String(block.input?.file_path ?? ''), cmd = String(block.input?.command ?? '');
              const art = path.match(/\/(art|depth)\/([\w-]+)\.txt$/);
              doing(block.name === 'Write' ? `draws ${art?.[2] ?? 'a file'}` : block.name === 'Edit' ? `changes ${art?.[2] ?? 'a file'}`
                : block.name === 'Read' ? (/\.png$/.test(path) ? 'looks at a render' : `reads ${art?.[2] ?? 'a file'}`)
                : cmd.includes('render.js') ? 'renders' : cmd.includes('event.js') ? 'reports' : 'runs a check');
            }
          }
        } else if (msg.type === 'result' && msg.is_error) failed = String(msg.result ?? msg.subtype ?? 'it failed');
      }
    });
    proc.on('error', (e) => { failed = `claude could not be started: ${e.message}`; });
    proc.on('close', async (code) => {
      clearTimeout(timer);
      runs.delete(w.id);
      active.delete(w.id);
      if (!spaces.exists(w.id)) return;                        // closed while it ran
      const wasStopped = stopped.delete(w.id);
      if (wasStopped) { w.state = 'stopped'; w.doing = 'stopped'; }
      else if (failed || code !== 0) { w.state = 'failed'; w.doing = failed || err.trim().split('\n').pop() || `claude ended with code ${code}`; }
      else { w.state = 'waiting'; w.doing = w.phase === 'silhouette' ? 'silhouette done: approve, or another round?' : 'done: accept, or another round?'; }
      try { await propose(w); } catch (e) { w.doing = `could not make a proposal of it: ${e instanceof Error ? e.message : e}`; w.state = 'failed'; }
      save(w); cast(w);
      events.add({ type: 'art.round', by: `agent:${w.id}`, worker: w.id, name: w.names[0], state: w.state, phase: w.phase, text: w.state === 'failed' ? `The worker failed: ${w.doing}` : w.said });
    });
  }

  return {
    get,
    list: () => spaces.list().map(get).filter(Boolean) as Worker[],
    busy: (id: string) => runs.has(id),

    /** Start a worker on a drawing: a new one, or a change to one there is. */
    start(input: { name: string; message: string; isNew: boolean; by: string; edit?: string[] }): Worker {
      const id = `w${Date.now().toString(36)}`;
      spaces.ensure(id, true);
      const w: Worker = { id, names: [input.name, ...(input.edit ?? [])], title: input.name, by: input.by, phase: 'color', state: 'running', doing: '', said: '', started: Date.now() };
      const ask = input.isNew
        ? `The user wants a new project art/${input.name}.txt: "${input.message}"`
        : `The user gives feedback on art/${input.name}.txt: "${input.message}"\n\nChange that drawing based on the feedback, within the current phase.`;
      const more = input.edit?.length ? `\n\nThis work also covers ${input.edit.map((n) => `art/${n}.txt`).join(', ')}: you may change those too (with their depth maps in depth/), render each to check.` : '';
      run(w, `${ask}${more}\n\n${NOTE}`);
      return w;
    },

    /** Feedback, or an answer: another round. */
    tell(id: string, message: string) {
      const w = get(id);
      if (!w) throw new Error(`there is no worker ${id}`);
      if (runs.has(id)) throw new Error(`${id} is still drawing; wait for its round, or stop it`);
      run(w, `The user gives feedback on art/${w.names[0]}.txt: "${message}"\n\nChange that drawing based on the feedback, within the current phase.`);
    },

    /** The silhouette is good: it is kept as the depth map, and the worker goes on with colour. */
    approve(id: string, message?: string) {
      const w = get(id);
      if (!w) throw new Error(`there is no worker ${id}`);
      if (runs.has(id)) throw new Error(`${id} is still drawing`);
      if (w.phase !== 'silhouette') throw new Error(`${id} is not waiting with a silhouette; it is in the ${w.phase} phase`);
      const root = spaces.dir(id);
      const done = w.names.filter((n) => existsSync(join(root, 'art', `${n}.txt`)));
      for (const n of done) copyFileSync(join(root, 'art', `${n}.txt`), join(root, 'depth', `${n}.txt`));
      const files = done.map((n) => `art/${n}.txt`).join(', '), depths = done.map((n) => `depth/${n}.txt`).join(', ');
      w.phase = 'color';
      run(w, `The user approves phase "silhouette" of ${files}.${message ? ` Their feedback: "${message}"` : ''} Go on with phase color. Your silhouette with its depth tones was kept as ${depths}; render it (node scripts/render.js ${depths.split(', ')[0]}) to check in the color phase what is in front and what behind, and change it when a part moves, changes depth or the contour changes a lot.`);
    },

    /** What the worker reports while it works (see art/scripts/bus.js). */
    note(id: string, type: string, name: string, message: string) {
      const w = get(id);
      if (!w) return;
      if (type === 'phase') { w.phase = /^sil/.test(message.trim()) ? 'silhouette' : 'color'; save(w); return; }
      if (['round', 'feedback', 'plan', 'step', 'done'].includes(type)) { w.doing = `${type}${message ? `: ${message}` : ''}`.slice(0, 200); cast(w); }
      void name;
    },

    stop(id: string) {
      const proc = runs.get(id);
      if (!proc) return false;
      stopped.add(id);
      proc.kill();
      return true;
    },

    /** Done with it: its workspace goes. What it proposed is decided by whoever closes it. */
    close(id: string) {
      runs.get(id)?.kill();
      runs.delete(id);
      active.delete(id);
      spaces.remove(id);
    },

    stopAll() { for (const proc of runs.values()) proc.kill(); },
  };
}

export type Workers = ReturnType<typeof createWorkers>;
