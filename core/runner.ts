// The runner: when the person says something, a headless Claude answers. It
// has no hands but the command line (see agent-intro.md), so everything it
// does is a command, and everything it changes is a proposal. One conversation
// per game, resumed from message to message.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH } from './code.ts';
import type { CommandDef } from './commands.ts';
import type { Event } from './events.ts';
import { ROOT, type Host } from './host.ts';
import { entityView } from '../ecs/inspect.ts';

/**
 * What the agent may do. Always: the engine's commands (the `tandem` command line) and reading the project. In its
 * working copy, on top of that: change the project's files (not tandem's own folder and not the drawings: those go
 * through commands, where they are proposals and can be locked), run what the project says may be run (its tests,
 * its type check, its builds), and see what it changed.
 */
/**
 * What the agent may run in its working copy: what tandem was told (the project's tests, its check, its builds),
 * and, without being told, the project's tests. It writes the code and the tests there; a test it may not run is
 * a change it cannot stand behind, and the first test of a project would otherwise wait for a setup to be accepted.
 */
export function runnable(project: Host['project']): string[] {
  const told = [project.config.test, project.config.check, project.config.art?.build, ...(project.config.run ?? [])].filter((c): c is string => !!c);
  const own = existsSync(join(project.root, 'package.json')) ? ['npm test', 'npm run test', 'node --test'] : [];
  return [...new Set([...told, ...own])];
}

/** Looking around from the command line: none of these writes anything. */
const LOOKING = ['ls', 'grep', 'cat', 'head', 'tail', 'wc'];

/**
 * What runs a script from the agent's scratchpad. A script can do anything the agent's own tests can, which the
 * agent also writes and runs: so this gives it nothing it did not have, only a quicker way to make a change in many
 * places. What is typed straight into the command line (`node -e`, a heredoc) stays refused: a script is a file,
 * written first, which the conversation shows.
 */
export const SCRIPTS = ['node', 'node --test', 'python3'];

/** Whether what the project depends on is installed with npm: then the agent may install it in its working copy. */
const installs = (project: Host['project']) => existsSync(join(project.root, 'package.json'));

export function tools(host: Host): { allow: string[]; deny: string[] } {
  const { project } = host;
  // The pictures it takes are outside its working copy; a path from the root is written with two slashes.
  // (GitHub's command line, in every project: the repository of the project, its issues and pull requests are the agent's to work with.)
  const allow = ['Bash(tandem run:*)', 'Bash(tandem list:*)', 'Bash(gh:*)', ...LOOKING.map((c) => `Bash(${c}:*)`), 'Read', 'Glob', 'Grep', `Read(/${project.dirs.looks}/**)`, `Read(/${host.dirs.files}/**)`];
  const deny: string[] = [];
  if (host.code) {
    allow.push(...project.editable.flatMap((p) => [`Edit(${p})`, `Write(${p})`]));
    for (const cmd of runnable(project)) allow.push(`Bash(${cmd}:*)`);
    // Its scratchpad: what it writes there is its own to run, and never part of the change set.
    allow.push(`Edit(${SCRATCH}/**)`, `Write(${SCRATCH}/**)`, ...SCRIPTS.map((c) => `Bash(${c} ${SCRATCH}/:*)`));
    // Exactly this, with nothing after it: a dependency is added in package.json, which is in the change set.
    if (installs(project)) allow.push('Bash(npm install)', 'Bash(npm ci)');
    // Tandem's own build of the drawings: it writes sprite sheets in a folder of the copy, from the drawings as they are.
    allow.push('Bash(tandem export:*)');
    allow.push('Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)');
    deny.push(...['.tandem/**', 'art/**', 'depth/**'].flatMap((p) => [`Edit(${p})`, `Write(${p})`]));
  }
  return { allow, deny };
}

/**
 * What the agent did with one of its tools, in a few words for the conversation: what it read, searched for,
 * changed or ran. A tandem command that changes something is not said here: what it changed says so itself (a
 * proposal, a tap on the page, a question).
 */
export function didWith(host: Host, name: string, input: Record<string, unknown>): string | undefined {
  const roots = [host.code?.work, host.project.root].filter((r): r is string => !!r);
  const short = (path: unknown) => {
    const p = String(path ?? '');
    if (p.startsWith(host.dirs.looks) || p.startsWith(host.dirs.files)) return 'a picture';
    const root = roots.find((r) => p === r || p.startsWith(`${r}/`));
    return root ? p.slice(root.length + 1) || 'the project' : p;
  };
  const cut = (text: unknown, max: number) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
  if (name === 'Read') return /\.(png|jpe?g|gif|webp)$/i.test(String(input.file_path)) ? `looked at ${short(input.file_path)}` : `read ${short(input.file_path)}`;
  if (name === 'Grep') return `searched for "${cut(input.pattern, 60)}"${input.path && short(input.path) !== 'the project' ? ` in ${short(input.path)}` : ''}`;
  if (name === 'Glob') return `looked for files like ${cut(input.pattern, 60)}`;
  if (name === 'Edit') return `changed ${short(input.file_path)}`;
  if (name === 'Write') return `wrote ${short(input.file_path)}`;
  if (name === 'Bash') {
    const cmd = String(input.command ?? '');
    const m = cmd.match(/\btandem\s+run\s+([\w.]+)/);
    if (m) return host.registry.get(m[1])?.kind === 'write' ? undefined : `ran ${m[1]}`;
    return `ran \`${cut(cmd, 100)}\``;
  }
  return `used ${name}`;
}

/** What a tool answered, cut to what fits in the conversation: the end of what a command printed, the start of anything else. */
export function outOf(name: string, content: unknown): string {
  const text = (Array.isArray(content) ? content.map((c) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '(a picture)' : '')).join('\n') : String(content ?? '')).replace(/\r/g, '').replace(/\s+$/, '');
  const lines = text.split('\n');
  const MOST = 24;
  const kept = lines.length <= MOST ? lines : name === 'Bash' ? [`… (${lines.length - MOST} lines before this)`, ...lines.slice(-MOST)] : [...lines.slice(0, MOST), `… (${lines.length - MOST} more lines)`];
  return kept.map((l) => (l.length > 240 ? `${l.slice(0, 239)}…` : l)).join('\n');
}

/**
 * What a change to a file was, as the lines that went and the lines that came: what the tool itself answers ("the
 * file has been updated") says nothing. Cut to what fits in the conversation.
 */
export function changeOf(name: string, input: Record<string, unknown>): string | undefined {
  const MOST = 40;
  const mark = (text: unknown, sign: string) => (text === undefined || text === '' ? [] : String(text).replace(/\r/g, '').split('\n').map((l) => `${sign}${l.length > 240 ? `${l.slice(0, 239)}…` : l}`));
  const lines = name === 'Edit' ? [...mark(input.old_string, '-'), ...mark(input.new_string, '+')] : name === 'Write' ? mark(input.content, '+') : [];
  if (!lines.length) return undefined;
  return (lines.length <= MOST ? lines : [...lines.slice(0, MOST), `… (${lines.length - MOST} more lines)`]).join('\n');
}

/** How many lines a change to a file took out and put in. */
export function countOf(name: string, input: Record<string, unknown>): { added: number; removed: number } | undefined {
  const count = (text: unknown) => (text === undefined || text === '' ? 0 : String(text).replace(/\n$/, '').split('\n').length);
  return name === 'Edit' ? { added: count(input.new_string), removed: count(input.old_string) } : name === 'Write' ? { added: count(input.content), removed: 0 } : undefined;
}

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
  /** The commands this conversation was last told of: what tandem gained since is said at the next message. */
  let told: string[] | undefined;
  /** The message it is answering right now, kept so that a turn that was cut off (tandem started again) is taken up again. */
  let running: number | undefined;
  let cutOff = false;
  try {
    const kept = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    session = kept.session;
    context = session ? Number(kept.context) || 0 : 0;
    if (session && Array.isArray(kept.commands)) told = kept.commands.map(String);
    cutOff = typeof kept.running === 'number';
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

  const keep = () => writeFileSync(file, JSON.stringify({ session, context: session ? context : 0, ...(session && told && { commands: told }), ...(running !== undefined && { running }) }, null, 2));
  const forget = () => { session = undefined; context = 0; told = undefined; keep(); };

  /**
   * A conversation that goes on after tandem itself was changed does not look at its list of commands again: what
   * it could not do a moment ago it goes on believing it cannot. So what is new since it was last told is said
   * with the message.
   */
  function gained(): string {
    const list = host.registry.list().filter((c) => c.agent !== 'no');
    const fresh = session && told ? list.filter((c) => !told!.includes(c.name)) : [];
    told = list.map((c) => c.name);
    if (!fresh.length) return '';
    return ` Tandem itself was changed since your last turn, and you can now do what you could not before: ${fresh.map((c) => `${c.name} (${c.about.split(/(?<=[.:])\s/)[0]})`).join('; ')}. They are in your list of commands; if something you were stopped at is now possible this way, do it this way.`;
  }

  function intro(): string {
    const list = host.registry.list().map((c) => {
      const input = Object.entries(c.input).map(([k, t]) => `${k}: ${t}`).join(', ');
      const may = c.agent === 'yes' ? '' : c.agent === 'no' ? ' [the person only]' : ' [from you: a proposal]';
      return `- ${c.name}${may}: ${c.about}${input ? ` Takes { ${input} }.` : ''}`;
    }).join('\n');
    const { project } = host;
    const can = [
      project.config.test && `Its tests: \`${project.config.test}\`.`,
      project.config.check && `Its type check: \`${project.config.check}\`.`,
      project.config.art?.build && `The build of its drawings: \`${project.config.art.build}\`.`,
      ...(project.config.run ?? []).map((c) => `Also: \`${c}\`.`),
      ...runnable(project).filter((c) => ![project.config.test, project.config.check, project.config.art?.build, ...(project.config.run ?? [])].includes(c)).map((c) => `Its tests also as \`${c}\`.`),
      host.code && installs(project) && 'What it depends on: `npm install`, just so (a new dependency is written in package.json first); your copy then has a node_modules of its own.',
    ].filter(Boolean).join(' ');
    const about = [
      `${project.name}, in ${project.root}.`,
      host.game ? 'It offers a way to see inside it: the game.*, world.*, ecs.* and playtest.* commands.' : 'It does not offer a way to see inside it while it runs: there are no game.*, ecs.* or playtest.* commands here. You read its code, run its tests, and the person plays it.',
      project.pageCommand(0) ? 'It has a page the person plays in tandem; they can switch it to your working copy.' : 'It has no page set up in tandem (project.configure: page).',
      host.code ? `In your working copy you may run: ${can || 'nothing but the tandem commands; tandem was not told how its tests are run (project.configure: test, check, run)'}` : '',
      `GitHub's command line, \`gh\`, is yours to run, as the person is signed in to it${host.code ? `. You stand in your working copy, which is on a branch of its own: what is about the project's repository names the project's folder (\`gh repo create <name> --private --source=${project.root} --remote=origin --push\`)` : ''}. What cannot be undone or is seen by others (deleting a repository, making one public, closing or merging) you do only when the person asked for exactly that.`,
      host.code ? `And a script of your own from your scratchpad: ${SCRIPTS.map((c) => `\`${c} ${SCRATCH}/<file>\``).join(', ')}.` : '',
      `From the command line you can look around with ${LOOKING.join(', ')}, also strung together; anything else there is refused, so do not try it.`,
    ].filter(Boolean).join(' ');
    return `${readFileSync(join(ROOT, 'core/agent-intro.md'), 'utf8')}${host.code ? `\n${readFileSync(join(ROOT, 'core/agent-code.md'), 'utf8')}` : ''}\n## The project\n\n${about}\n\n## The commands\n\nRun one with \`tandem run <command> '<json input>'\`.\n\n${list}\n`;
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
          if (c) out.push(`Concept "${c.name}" (${c.id}, stage ${c.stage}${host.locks.has(`concept:${c.id}`) ? ', LOCKED' : ''}):\n${c.text || '(no description yet)'}`);
        } else if (kind === 'entity') {
          const e = host.game ? entityView(host.world(), host.game, Number(rest)) : undefined;
          out.push(e ? `Entity ${rest} in the world being played: ${JSON.stringify(e.components)}` : `Entity ${rest} (no longer there)`);
        } else if (kind === 'drawing') {
          out.push(`Drawing ${rest}${host.locks.has(`drawing:${rest}`) ? ' (LOCKED)' : ''}: one of the game's drawings, made in pixeldraw. See it with art.look.`);
        } else if (kind === 'thought') {
          const t = host.thoughts.get(rest);
          out.push(t ? `A loose thought of theirs (${t.id}), which is not part of any concept yet:\n${t.text}` : `A loose thought (${rest}) that is no longer there.`);
        } else if (kind === 'page') {
          const p = JSON.parse(rest) as { words?: string; near?: string; tag?: string; selector?: string; path?: string; three?: Record<string, any> };
          // A thing in a scene three.js draws: it has no words, so it is told by what it is and where.
          if (p.three) {
            const t = p.three, g = t.geometry ?? {}, m = t.material;
            const list = (a: unknown) => (Array.isArray(a) ? a.join(', ') : '?');
            out.push([
              `Something in the 3D scene on the project's page that the person pointed at${p.path ? ` (the page at ${p.path})` : ''}: a ${t.type ?? 'Mesh'}${t.name ? ` named "${t.name}"` : ' with no name'}.`,
              `Its geometry: ${g.type ?? '?'}${g.name ? ` "${g.name}"` : ''}${g.made ? ` made with ${JSON.stringify(g.made)}` : ''}, ${g.points ?? '?'} points; it is ${list(t.size)} large (x, y, z, as it stands in the scene).`,
              m ? `Its material: ${m.type ?? '?'}${m.name ? ` "${m.name}"` : ''}${m.color ? `, colour ${m.color}` : ''}${m.texture ? ', with a texture' : ''}${Array.isArray(m.uniforms) ? `, uniforms ${m.uniforms.join(', ')}` : ''}.` : '',
              `It is at ${list(t.position)} in the scene, and they pointed at ${list(t.point)} on it.`,
              t.instance !== undefined ? `It is instance ${Number(t.instance) + 1} of ${t.instances} of an InstancedMesh.` : Number(t.of) > 1 ? `It is number ${t.index} of ${t.of} things like it in the scene (same geometry and material), counted in the order the scene holds them.` : 'Nothing else in the scene is like it.',
              `In the scene it hangs as: ${t.graph ?? '?'}.`,
              t.userData ? `Its userData: ${t.userData}.` : '',
              `It is drawn on a <canvas>${p.selector ? `, in the page as ${p.selector}` : ''}. Find where the code makes it by its name, geometry and material; a picture of it as it looked comes with the message when one could be made.`,
            ].filter(Boolean).join(' '));
            continue;
          }
          // What says nothing itself (a canvas, a picture) is told apart by what is written around it: which one
          // of the things the code draws there is meant.
          const near = p.near ? ` Around it on the page is written: "${p.near}"${p.words ? '' : '; it says nothing itself, so that is what tells which one they mean'}.` : p.words ? '' : ' Nothing is written on it or around it, so which of the things the code can show there they mean is not known from this: say which one you took it to be.';
          out.push(`Something on the project's page that the person pointed at${p.path ? ` (the page at ${p.path})` : ''}: a <${p.tag ?? '?'}>${p.words ? ` that says "${p.words}"` : ''}${p.selector ? `, in the page as ${p.selector}` : ''}.${near} Find it in the code by those words or that name.`);
        } else if (kind === 'point') {
          out.push(`A point in the project's world: ${rest} (world units)`);
        } else out.push(ref);
      } catch { out.push(ref); }
    }
    return out.length ? `\n\n[The message is about:]\n${out.join('\n\n')}` : '';
  }

  function run(ev: Event, retry = false) {
    busy = true; doing = 'starting'; text = '';
    cast(true);
    running = ev.n;
    keep();
    const round = `r${ev.n}`;
    // Its working copy first takes in whatever the project gained since it last worked.
    let copy = '';
    if (host.code) {
      try {
        const { conflicts } = host.code.sync();
        if (conflicts.length) copy = ` The project changed ${conflicts.join(', ')}, which your working copy changed too, so your copy could not take the project's version in: look at both (git diff) and bring yours up to date before anything else.`;
      } catch (e) { copy = ` Your working copy could not be brought up to date (${e instanceof Error ? e.message.split('\n')[0] : e}); say so, and do not change code this round.`; }
    }
    const from = ev.by === 'engine' ? '[From the engine, not the person:] ' : '';
    const where = host.game ? ` Where the person is: ${firstLine()}` : '';
    // What the person shared with the message is on disk: the agent reads it, a picture like any picture.
    const shared = Array.isArray(ev.files) && ev.files.length
      ? `\n\n[The person shared ${ev.files.length === 1 ? 'a file' : 'files'} with this message; Read ${ev.files.length === 1 ? 'it' : 'them'} before you answer:]\n${(ev.files as { path: string; label: string; image: boolean }[]).map((f) => `- ${f.path} (${f.image ? 'a picture' : 'a file'}, "${f.label}")`).join('\n')}`
      : '';
    const prompt = `${from}${ev.text}${expand(ev.refs)}${shared}\n\n[This is round ${round}.${where}${copy}${gained()}]`;
    const may = tools(host);
    const args = [
      '-p', prompt, '--append-system-prompt', intro(),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', process.env.TANDEM_MODEL ?? 'claude-fable-5-2', '--effort', process.env.TANDEM_EFFORT ?? 'medium',
      ...(session && !retry ? ['--resume', session] : []),
      // Only the tools below: the person's own default permission mode is not inherited.
      '--permission-mode', 'default', '--allowedTools', ...may.allow, ...(may.deny.length ? ['--disallowedTools', ...may.deny] : []),
    ];
    const proc = spawn(process.env.CLAUDE_BIN ?? 'claude', args, {
      cwd: host.code?.work ?? host.project.root, stdio: ['ignore', 'pipe', 'pipe'],
      // `tandem` on its path is the engine's command line, talking to this core.
      env: { ...process.env, PATH: `${join(ROOT, 'bin')}:${process.env.PATH ?? ''}`, TANDEM_BY: 'agent:main', TANDEM_ROUND: round },
    });
    child = proc;
    let buf = '', err = '', said = 0, failed = '', lastSaid = '';
    /** What it is doing with a tool right now, by the id of the call: what the tool answers is said with it. */
    const calls = new Map<string, { tool: string; change?: string }>();
    let seen = 0;
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
            if (block.type === 'text' && block.text.trim()) { said++; text = ''; lastSaid = block.text.trim(); say(lastSaid); }
            if (block.type === 'tool_use') {
              const cmd = String(block.input?.command ?? '');
              const m = cmd.match(/\btandem\s+run\s+([\w.]+)/);
              doing = m ? m[1] : block.name === 'Read' ? 'looking at a file' : block.name === 'Bash' ? 'the command line' : String(block.name).toLowerCase();
              cast(true);
              // Everything it does is in the conversation, one line each; the page folds a run of them into one.
              const did = didWith(host, String(block.name), block.input ?? {});
              if (did) {
                // A picture it looks at (of the page, or one the person shared) is shown with it.
                const file = block.name === 'Read' ? String(block.input?.file_path ?? '') : '';
                const picture = [['looks', host.dirs.looks], ['files', host.dirs.files]].map(([kind, dir]) => (file.startsWith(`${dir}/`) && /\.(png|jpe?g|gif|webp)$/i.test(file) ? `/api/file/${kind}/${encodeURIComponent(file.slice(dir.length + 1))}` : '')).find(Boolean);
                if (block.id) calls.set(String(block.id), { tool: String(block.name), change: changeOf(String(block.name), block.input ?? {}) });
                host.events.add({ type: 'agent.did', by: 'agent', round, did, ...(block.id && { id: String(block.id) }), ...(picture && { picture }), ...countOf(String(block.name), block.input ?? {}) });
              }
            }
          }
        } else if (msg.type === 'user') {
          // What a tool answered: kept with what the agent did, so the conversation shows how it went.
          for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            const call = block?.type === 'tool_result' ? calls.get(String(block.tool_use_id)) : undefined;
            if (!call) continue;
            // A change that went in is said by its lines; one that did not, by what the tool said about it.
            const change = block.is_error ? undefined : call.change;
            calls.delete(String(block.tool_use_id));
            // A picture it was given (it read one, from anywhere) is kept, so the person sees what it saw.
            const image = Array.isArray(block.content) ? block.content.find((c: any) => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string') : undefined;
            let picture: string | undefined;
            if (image) {
              try {
                const name = `seen-${Date.now().toString(36)}-${++seen}.${/jpe?g/.test(String(image.source.media_type)) ? 'jpg' : /gif|webp/.exec(String(image.source.media_type))?.[0] ?? 'png'}`;
                writeFileSync(join(host.dirs.looks, name), Buffer.from(image.source.data, 'base64'));
                picture = `/api/file/looks/${name}`;
              } catch { /* shown without it */ }
            }
            host.events.add({ type: 'agent.out', by: 'agent', round, id: String(block.tool_use_id), out: change ?? outOf(call.tool, block.content), ...(change && { change: true }), ...(block.is_error && { error: true }), ...(picture && { picture }) });
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
      // What its working copy now differs from the project is the change set the person gets to play and decide.
      try { host.proposeCode('agent:main', lastSaid); } catch (e) { say(`(The working copy could not be compared with the project: ${e instanceof Error ? e.message.split('\n')[0] : e})`, { error: true }); }
      if (session && context > CONTEXT_LIMIT) {
        say(`(The conversation reached ${Math.round(context / 1000)}k tokens; the next message starts a new one.)`);
        forget();
      }
      host.turnOver();
      // The turn is over, however it went: there is nothing to take up again.
      running = undefined;
      keep();
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
    // The person speaks, or the engine has news for the agent (art was accepted: bring it into the game).
    if (ev.n > 0 && ev.type === 'message' && (ev.by === 'me' || ev.by === 'engine')) {
      if (off) return void host.events.cast({ type: 'agent.status', ...status() });
      queue.push(ev);
      // It is said to be at work at once, and the work is started a moment later: getting its working copy ready can
      // take seconds, and whoever sent the message (a tap on a button) should not wait for that to hear it was heard.
      if (!busy) {
        busy = true; doing = 'starting'; text = '';
        cast(true);
        setImmediate(() => { busy = false; next(); if (!busy) cast(true); });
      } else cast(true);
    }
  });

  // Tandem was started again in the middle of a turn (a change to tandem itself, another project opened and this
  // one again, a crash): the turn was cut off with it. The agent is told, and carries on where it was.
  if (cutOff && !off) {
    const resume = setTimeout(() => host.events.add({
      type: 'message', by: 'engine', kind: 'resume',
      text: 'Tandem was started again while you were in the middle of your turn, and the turn was cut off. Whatever you had already proposed or changed still stands: look at what is there (proposals.list, and your working copy if you were coding), then carry on from where you were and finish. Do not start over, and do not propose again what is already waiting.',
    }), 1200);
    resume.unref?.();
  }

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
