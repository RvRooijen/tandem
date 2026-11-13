// The runner: when the person says something, a headless Claude answers. It
// has no hands but the command line (see agent-intro.md), so everything it
// does is a command, and everything it changes is a proposal. One conversation
// per game, resumed from message to message.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandDef } from './commands.ts';
import type { Event } from './events.ts';
import { ROOT, type Host } from './host.ts';
import { entityView } from '../ecs/inspect.ts';

const TOOLS = [
  'Bash(node core/cli.ts:*)',
  'Read(core/**)', 'Read(ecs/**)', 'Read(playtest/**)', 'Read(shell/**)', 'Read(games/**)', 'Read(docs/**)', 'Read(*.md)',
  'Glob', 'Grep',
];

export interface AgentStatus {
  busy: boolean; doing: string; text: string; waiting: number; session: boolean; off: boolean;
  /** How big the conversation is, in tokens, and where it starts over by itself. */
  context: number; limit: number;
}

/** Past this many tokens the next message starts a new conversation. */
const CONTEXT_LIMIT = Number(process.env.TANDEM_CONTEXT_LIMIT) || 800_000;

export function createRunner(host: Host) {
  const file = join(host.dirs.data, 'agent.json');
  let session: string | undefined;
  // The context of the last request the agent made: what the next message starts from.
  let context = 0;
  try {
    const kept = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    session = kept.session;
    context = session ? Number(kept.context) || 0 : 0;
  } catch { /* start a new conversation */ }
  const off = process.env.TANDEM_AGENT === 'off';
  const queue: Event[] = [];
  let child: ChildProcess | undefined;
  let busy = false, doing = '', text = '', stopped = false, forgotten = false;
  let lastCast = 0;

  const status = (): AgentStatus => ({ busy, doing, text: text.slice(-600), waiting: queue.length, session: !!session, off, context: session ? context : 0, limit: CONTEXT_LIMIT });
  function cast(force = false) {
    const now = Date.now();
    if (!force && now - lastCast < 250) return;
    lastCast = now;
    host.events.cast({ type: 'agent.status', ...status() });
  }
  const beat = setInterval(() => { if (busy) cast(true); }, 5000);
  beat.unref?.();

  const keep = () => writeFileSync(file, JSON.stringify({ session, context: session ? context : 0 }, null, 2));
  const forget = () => { session = undefined; context = 0; keep(); };

  function intro(): string {
    const list = host.registry.list().map((c) => {
      const input = Object.entries(c.input).map(([k, t]) => `${k}: ${t}`).join(', ');
      const may = c.agent === 'yes' ? '' : c.agent === 'no' ? ' [the person only]' : ' [from you: a proposal]';
      return `- ${c.name}${may}: ${c.about}${input ? ` Takes { ${input} }.` : ''}`;
    }).join('\n');
    return `${readFileSync(join(ROOT, 'core/agent-intro.md'), 'utf8')}\n## The game\n\n${host.game.name} (${host.game.id}). Its content is under games/${host.game.id}/content, its concepts under games/${host.game.id}/concepts; you may read the code under games/${host.game.id}/src to understand a rule.\n\n## The commands\n\n${list}\n`;
  }

  /** What a message points at, written out, so the agent does not have to go and fetch it. */
  function expand(refs: unknown): string {
    if (!Array.isArray(refs) || !refs.length) return '';
    const out: string[] = [];
    for (const ref of refs.map(String)) {
      const [kind, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
      try {
        if (kind === 'concept') {
          const c = host.concepts.get(rest);
          if (c) out.push(`Concept "${c.name}" (${c.id}, ${c.firmness}):\n${c.text || '(no description yet)'}`);
        } else if (kind === 'record') {
          const r = host.records.get(rest);
          if (r) out.push(`Record ${rest}: ${JSON.stringify(r)}`);
        } else if (kind === 'entity') {
          const e = entityView(host.world(), host.game, Number(rest));
          out.push(e ? `Entity ${rest} in the world being played: ${JSON.stringify(e.components)}` : `Entity ${rest} (no longer there)`);
        } else if (kind === 'drawing') {
          out.push(`Drawing ${rest}: one of the game's drawings, made in pixeldraw. See it with art.look.`);
        } else if (kind === 'point') {
          out.push(`A point in the game's world: ${rest} (world units)`);
        } else out.push(ref);
      } catch { out.push(ref); }
    }
    return out.length ? `\n\n[The message is about:]\n${out.join('\n\n')}` : '';
  }

  function run(ev: Event, retry = false) {
    busy = true; doing = 'starting'; text = '';
    cast(true);
    const round = `r${ev.n}`;
    const prompt = `${ev.text}${expand(ev.refs)}\n\n[This is round ${round}. Where the person is in the game: ${firstLine()}]`;
    const args = [
      '-p', prompt, '--append-system-prompt', intro(),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', process.env.TANDEM_MODEL ?? 'claude-fable-5-2', '--effort', process.env.TANDEM_EFFORT ?? 'medium',
      ...(session && !retry ? ['--resume', session] : []),
      // Only the tools below: the person's own default permission mode is not inherited.
      '--permission-mode', 'default', '--allowedTools', ...TOOLS,
    ];
    const proc = spawn(process.env.CLAUDE_BIN ?? 'claude', args, {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TANDEM_BY: 'agent:main', TANDEM_ROUND: round },
    });
    child = proc;
    let buf = '', err = '', said = 0, failed = '';
    const timer = setTimeout(() => { failed = 'it took more than fifteen minutes and was stopped'; proc.kill(); }, 15 * 60_000);
    const say = (t: string, extra: Record<string, unknown> = {}) => host.events.add({ type: 'message', by: 'agent', text: t, round, ...extra });

    proc.stderr!.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.stdout!.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.session_id && msg.session_id !== session) { session = msg.session_id; keep(); }
        if (msg.type === 'stream_event') {
          const e = msg.event;
          if (e.type === 'content_block_start') {
            const kind = e.content_block?.type;
            if (kind === 'thinking' || kind === 'redacted_thinking') doing = 'thinking';
            else if (kind === 'text') { doing = 'writing'; text = ''; }
            else if (kind === 'tool_use') doing = 'reaching for a tool';
            cast();
          } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            text += e.delta.text;
            cast();
          }
        } else if (msg.type === 'assistant') {
          const u = msg.message?.usage;
          const now = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0;
          if (now && now !== context) { context = now; keep(); cast(true); }
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text.trim()) { said++; text = ''; say(block.text.trim()); }
            if (block.type === 'tool_use') {
              const cmd = String(block.input?.command ?? '');
              const m = cmd.match(/core\/cli\.ts\s+run\s+([\w.]+)/);
              doing = m ? m[1] : block.name === 'Read' ? 'looking at a file' : block.name === 'Bash' ? 'the command line' : String(block.name).toLowerCase();
              cast(true);
            }
          }
        } else if (msg.type === 'result') {
          if (msg.is_error) failed = String(msg.result ?? msg.subtype ?? 'it failed');
          else if (!said && msg.result) say(String(msg.result).trim());
        }
      }
    });
    proc.on('error', (e) => { failed = `claude could not be started: ${e.message}`; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      child = undefined;
      if (forgotten) {
        // A new conversation was started while it was answering: this answer belongs to the old one, and so does its session.
        forgotten = stopped = false;
        forget();
      } else if (stopped) { stopped = false; say('(stopped)', { error: true }); }
      else if ((failed || code !== 0) && session && !retry && !said) {
        // Most often the conversation to resume is gone; start a new one, once.
        forget();
        return run(ev, true);
      } else if (failed || code !== 0) say(`That did not work: ${failed || err.trim().split('\n').pop() || `claude ended with code ${code}`}`, { error: true });
      if (session && context > CONTEXT_LIMIT) {
        say(`(The conversation reached ${Math.round(context / 1000)}k tokens; the next message starts a new one.)`);
        forget();
      }
      busy = false; doing = ''; text = '';
      cast(true);
      next();
    });
  }

  function firstLine() {
    try { return host.world().describe().split('\n').slice(0, 2).join(' '); } catch { return 'unknown'; }
  }

  function next() {
    if (busy || off) return;
    const ev = queue.shift();
    if (ev) run(ev);
  }

  const unsubscribe = host.events.subscribe((ev) => {
    if (ev.n > 0 && ev.type === 'chat.new') {
      // A new conversation: nothing is waiting any more, and nothing is remembered.
      queue.length = 0;
      forget();
      if (child) { forgotten = true; child.kill(); }
      return cast(true);
    }
    if (ev.n > 0 && ev.type === 'message' && ev.by === 'me') {
      if (off) return void host.events.cast({ type: 'agent.status', ...status() });
      queue.push(ev);
      cast(true);
      next();
    }
  });

  const commands: CommandDef[] = [
    {
      name: 'agent.status', kind: 'read',
      about: 'What the agent is doing right now: busy or not, with what, and how many messages are waiting.',
      run: () => status(),
    },
    {
      name: 'agent.stop', kind: 'write',
      about: 'Stop the agent in the middle of what it is doing. What it already proposed stays.',
      run() {
        queue.length = 0;
        if (child) { stopped = true; child.kill(); return { stopped: true }; }
        return { stopped: false };
      },
    },
    {
      name: 'agent.reset', kind: 'write',
      about: 'Start a new conversation with the agent: it forgets what was said, not what was made.',
      run() { forget(); cast(true); return { reset: true }; },
    },
  ];

  return { commands, status, stop() { unsubscribe(); clearInterval(beat); child?.kill(); } };
}
