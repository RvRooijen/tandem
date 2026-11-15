// The host: one project, its stores, its worlds and every command, in one
// place. The server puts HTTP around it; the tests use it as it is. Nothing
// here knows about pages or agents beyond who is asking (`by`).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH, createCode, forConcepts, type Code, type FileChange } from './code.ts';
import { CommandError, createRegistry, isAgent, type By, type CommandDef, type Registry } from './commands.ts';
import { STAGES, createConcepts, type Concept, type Concepts } from './concepts.ts';
import { createEventLog, type EventLog } from './events.ts';
import type { GameModule, World } from './game.ts';
import { runJob, type JobSpec } from './jobs.ts';
import { createLocks, type Locks } from './locks.ts';
import { createThoughts, type Thoughts } from './thoughts.ts';
import { find, put, unfit, type Tweak, type TweakValue } from './tweaks.ts';
import { COPY_PORT, createPreview, type Preview } from './preview.ts';
import { innerPort } from './through.ts';
import { encodePng } from './png.ts';
import { SETUP, loadProject, prepare, type Project } from './project.ts';
import { createProposals, type Json, type Proposal, type Proposals, type RecordValue } from './proposals.ts';
import { createArt, type Art } from '../art/commands.ts';
import { ecsCommands } from '../ecs/inspect.ts';
import { compare, type Pacing } from '../playtest/pacing.ts';

/** Where the engine itself is. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A world on the host. `mine` mirrors the one the person is playing; the others are sandboxes anyone may play in. */
interface Room { world?: World; snapshot?: unknown; at: number }

export interface Host {
  project: Project;
  /** What lets the engine see inside the project, when the project offers it (its adapter). */
  game?: GameModule;
  registry: Registry;
  events: EventLog;
  proposals: Proposals;
  concepts: Concepts;
  /** What the person typed without saying where it belongs. */
  thoughts: Thoughts;
  locks: Locks;
  art: Art;
  /** The agent's working copy of the project, when there is a repository to make one in. */
  code?: Code;
  /** The page of the working copy, for playing it. */
  preview?: Preview;
  /** After the agent worked: what its copy differs from the project becomes (or stops being) a proposal. */
  proposeCode(by: By, note: string): void;
  /** What the person turned of the values the agent exposed, since the agent last heard: said once, at its next turn. */
  tweaked(): string;
  /**
   * The agent's turn is over: if it had the project's page (page.take), the person has it again. And if it left
   * values to turn without an example to judge them on, it is asked for one.
   */
  turnOver(): void;
  /** Things to stop before the core does. */
  onStop: (() => void)[];
  dirs: { project: string; data: string; looks: string; files: string };
  /** Run a command as somebody. */
  run(name: string, input: Record<string, unknown> | undefined, by: By, round?: string): Promise<unknown>;
  /** A world of the project; only with an adapter. */
  world(room?: string): World;
}

export interface HostOptions {
  /** The project's folder; the folder tandem was started in if not said. */
  project?: string;
  /** Where what is not kept in git goes (the event log, proposals, pictures); .tandem/data in the project if not said. */
  dataDir?: string;
  /** Tandem's own folder for the project (its concepts and locks), when it is not .tandem in it (a test's). */
  tandemDir?: string;
  /** The agent's working copy, when it is not the usual one (a test's); null for none. */
  code?: Code | null;
  /** Told what is being done while the host is made, step by step: on a slow disk that takes a while. */
  doing?: (what: string) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What npm writes beside a package.json when it installs. */
const LOCKFILE = 'package-lock.json';

export async function createHost(opts: HostOptions = {}): Promise<Host> {
  const project = loadProject(opts.project ?? process.env.TANDEM_PROJECT ?? process.cwd(), { data: opts.dataDir, tandem: opts.tandemDir });
  opts.doing?.('setting up its .tandem folder');
  prepare(project);
  const dataDir = project.dirs.data, looksDir = project.dirs.looks;

  // What the project offers to be seen inside by. Without it the engine still talks, keeps concepts and codes;
  // the commands that need it are simply not there.
  const adapter = project.config.adapter;
  const hasGame = !!adapter && existsSync(join(project.root, adapter));
  if (hasGame) opts.doing?.('loading its adapter');
  const game = (hasGame ? (await import(join(project.root, adapter!))).game : undefined) as GameModule;
  if (hasGame && !game) throw new Error(`${adapter} does not export \`game\``);

  opts.doing?.('reading what is kept there: the chat, the concepts, what was proposed');
  const registry = createRegistry();
  const events = createEventLog(join(dataDir, 'events.jsonl'));
  const proposals = createProposals(join(dataDir, 'proposals'));
  // The core can be cut off in the middle of a decision (it crashed, the machine went down): the proposal is
  // marked then, and the log never said so. It is said now, or its card would wait for ever.
  {
    const waits = new Map<string, string>();
    for (const e of events.since(0)) {
      if (e.type === 'proposal') waits.set(String(e.id), String(e.round));
      else if (e.type === 'proposal.decided') for (const [id, round] of waits) if (Array.isArray(e.ids) ? e.ids.includes(id) : round === String(e.round)) waits.delete(id);
    }
    const cut = proposals.list().filter((p) => p.status !== 'pending' && waits.get(p.id) === p.round);
    for (const round of new Set(cut.map((p) => p.round))) for (const status of ['accepted', 'rejected'] as const) {
      const set = cut.filter((p) => p.round === round && p.status === status);
      if (set.length) events.add({ type: 'proposal.decided', by: 'engine', round, status, count: set.length, ids: set.map((p) => p.id), left: proposals.list({ status: 'pending', round }).length, paths: set.map((p) => `${p.kind}:${p.path}`) });
    }
  }
  const concepts = createConcepts(project.dirs.concepts);
  const locks = createLocks(project.locksFile);
  const thoughts = createThoughts(join(project.dirs.tandem, 'thoughts.json'));
  const onStop: (() => void)[] = [];

  // Working files and project files: the agent codes in a copy of its own (code.ts), when the project is in a
  // repository. What the engine itself writes in the project (concepts, locks, accepted drawings) is committed by
  // it, so the copy can take it in; the person's own uncommitted work is theirs and is left alone.
  opts.doing?.('looking at its git repository');
  const candidate = opts.code === undefined && process.env.TANDEM_CODE !== 'off'
    ? createCode({ root: project.root, paths: ['.tandem/concepts', '.tandem/thoughts.json', '.tandem/locks.json', '.tandem/.gitignore', '.tandem/tandem.json', '.tandem/page.sh', 'art', 'depth'] }) : undefined;
  const code = opts.code ?? (candidate?.usable() ? candidate : undefined);
  // (Also for a project that has no page yet: the change set that gives it one is played from the copy.)
  const preview = code ? createPreview(() => project.at(code.work), join(dataDir, 'copy-page.log')) : undefined;
  /** Whether the working copy has a page to play: the project's own, or one its change set brings. */
  const copyPage = () => {
    try { return !!code && !!preview && (!!project.pageCommand(0) || (existsSync(code.work) && !!project.at(code.work).pageCommand(0))); } catch { return false; }
  };
  if (preview) onStop.push(() => preview.stop());
  /** The one round the working copy's change set is: there is one copy, so one change set at a time. */
  const CODE = 'code';

  // ------------------------------------------------------------ worlds

  const rooms = new Map<string, Room>();
  const mineFile = join(dataDir, 'mine.json');
  if (existsSync(mineFile)) {
    try { rooms.set('mine', { snapshot: JSON.parse(readFileSync(mineFile, 'utf8')), at: Date.now() }); } catch { /* a broken mirror is no mirror */ }
  }

  function build(snapshot: unknown): World {
    const w = game.createWorld(snapshot, { seed: 1 });
    w.step(0.05);                         // so that what is derived from the clock (day or night) is there
    return w;
  }

  function world(room = 'mine'): World {
    if (!hasGame) throw new CommandError('unsupported', 'this project does not offer a way to see inside it (no adapter in tandem.json)');
    let r = rooms.get(room);
    if (!r) {
      if (room !== 'mine') throw new CommandError('missing', `there is no room called ${room}; there are: ${[...rooms.keys()].join(', ') || 'none'}. Make one with world.fork`);
      r = { at: Date.now() };
      rooms.set('mine', r);
    }
    r.world ??= build(r.snapshot);
    return r.world;
  }

  /** The world being played is the person's own; on the host it is a mirror. Writing goes to a sandbox. */
  function sandboxOnly(room: string | undefined, _by: By) {
    if (!room || room === 'mine')
      throw new CommandError('permission', 'the world being played is only mirrored here and cannot be changed from outside. Make a sandbox with world.fork and name it as room');
  }

  /**
   * Start the core again, when something looks after it that will (core/start.ts): its game code is from when it
   * started. Never in the middle of a command: an accept that is still installing what the project needs is
   * finished first, or it would be cut off half done (the commit made, nothing said about it, nothing installed).
   */
  let again: number | undefined;
  function restart(code = 75) {
    if (!process.env.TANDEM_SUPERVISED) return;
    const first = again === undefined;
    // Asked for twice, the one that starts the project's page again too is the one that counts.
    if (again !== SETUP) again = code;
    if (!first) return;
    // (A moment after the last command, so that whoever asked still gets its answer; a command that came in that moment is waited for too.)
    const go = () => void registry.idle().then(() => setTimeout(() => {
      if (registry.running()) return go();
      for (const stop of onStop) stop();
      process.exit(again);
    }, 600));
    go();
  }

  /**
   * Something done on the project's page, on the person's own screen: asked of whatever screen has tandem open,
   * which does it in the frame and answers (page.answer). What changes the page is kept as something that happened.
   */
  const asked = new Map<string, (result: Record<string, unknown>) => void>();
  let asking = 0;
  /**
   * The agent may ask to have the page for a while (page.take), to try what it made itself; the person says yes or
   * not now. While it has it, what it does there comes back with a picture of the page, and the person's screen
   * says who is using it. It ends when the agent gives it back, its turn is over, the person takes it back, or
   * nothing was done on it for five minutes.
   */
  let held: { by: By; timer: ReturnType<typeof setTimeout> } | undefined;
  /** The person took the page back in the middle of this turn: the agent leaves it alone until it has asked again. */
  let takenBack = false;
  const taking = new Map<string, (allow: boolean) => void>();
  function hold(by: By) {
    clearTimeout(held?.timer);
    const timer = setTimeout(() => release('engine', 'nothing was done on it for five minutes'), 5 * 60_000);
    timer.unref?.();
    held = { by, timer };
  }
  function release(by: By, why?: string) {
    if (!held) return false;
    clearTimeout(held.timer);
    held = undefined;
    events.add({ type: 'page.released', by, ...(why && { why }) });
    return true;
  }
  // (What was open when tandem last stopped is over: nobody is waiting for the answer, nobody has the page.)
  {
    const open = new Set<string>();
    let has = false;
    for (const e of events.since(0)) {
      if (e.type === 'page.take') open.add(String(e.id));
      else if (e.type === 'page.taken') { open.delete(String(e.id)); if (e.allow) has = true; }
      else if (e.type === 'page.released') has = false;
    }
    for (const id of open) events.add({ type: 'page.taken', by: 'engine', id, allow: false });
    if (has) events.add({ type: 'page.released', by: 'engine', why: 'tandem was started again' });
  }
  let pictureN = 0;
  /** A picture the person's screen made of the page (a data URL), kept where the agent can read it. */
  function keepPicture(data: unknown): string | undefined {
    const m = typeof data === 'string' ? /^data:image\/(png|jpeg);base64,(.+)$/.exec(data) : null;
    if (!m) return undefined;
    const file = join(looksDir, `page-${Date.now().toString(36)}-${++pictureN}.${m[1] === 'png' ? 'png' : 'jpg'}`);
    writeFileSync(file, Buffer.from(m[2], 'base64'));
    return file;
  }
  async function onPage(by: By, what: Record<string, unknown>) {
    if (!project.pageCommand(0)) throw new CommandError('unsupported', 'this project has no page set up in tandem (project.configure: page)');
    if (takenBack && isAgent(by)) throw new CommandError('permission', 'the person took the page back, so leave it alone. If you still need it, ask again with page.take; otherwise say what you could not see');
    const mine = !!held && held.by === by;
    if (mine) { hold(by); what = { ...what, picture: true }; }
    const id = `a${Date.now().toString(36)}${++asking}`;
    const result = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      asked.set(id, resolve);
      events.cast({ type: 'page.ask', by, id, ...what });
      // Switching to the working copy can mean starting its page first.
      setTimeout(() => { if (asked.delete(id)) resolve(undefined); }, what.copy === true ? 90_000 : 45_000).unref?.();
    });
    if (!result) throw new CommandError('unavailable', 'the person\'s screen did not answer: tandem has to be open on their device for this. Ask them to open it, or go by the code');
    if (result.ok === false) throw new CommandError('failed', String(result.error ?? 'it did not work'));
    if (what.do !== 'look') events.add({ type: 'page.did', by, what: what.do, ...(what.at !== undefined && { at: what.at }), ...(what.x !== undefined && { at: `${what.x}, ${what.y}` }), ...(what.path !== undefined && { path: what.path }), did: result.did ?? '', showing: result.showing });
    const { ok: _ok, lines, image, size, ...rest } = result;
    const picture = mine ? keepPicture(image) : undefined;
    return {
      ...rest, page: Array.isArray(lines) ? lines.join('\n') : '',
      ...(picture ? { picture, ...(Array.isArray(size) && { size }) } : mine && { picture: 'none: this browser did not hand a picture of the page back, so go by the lines' }),
    };
  }

  /**
   * The project's own server, called the way another device would: without anything the person's browser keeps.
   * Only the address the project's page is served from (and what that page reaches through it), or the working
   * copy's. A visitor with a name keeps its cookies from one call to the next.
   */
  const visitors = new Map<string, Map<string, string>>();
  async function request(by: By, i: { method?: string; path: string; body?: unknown; headers?: unknown; as?: string; copy?: boolean }) {
    if (!(i.copy ? copyPage() : project.pageCommand(0))) throw new CommandError('unsupported', 'this project has no page set up in tandem (project.configure: page)');
    const method = (i.method ?? (i.body === undefined ? 'GET' : 'POST')).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new CommandError('input', 'method is GET, POST, PUT, PATCH, DELETE or HEAD');
    if (!i.path.startsWith('/') || i.path.startsWith('//')) throw new CommandError('input', 'path starts with /: only the project\'s own server is called, at the address its page is served from');
    if (i.headers !== undefined && (typeof i.headers !== 'object' || i.headers === null || Array.isArray(i.headers))) throw new CommandError('input', 'headers is an object of names and values');
    let port = innerPort(Number(process.env.TANDEM_PAGE_PORT ?? 5210));
    if (i.copy) {
      if (!preview) throw new CommandError('unsupported', 'there is no working copy with a page here');
      try { await preview.url(); } catch (e) { throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
      port = innerPort(COPY_PORT, true);
    }
    const who = i.as?.trim() || 'visitor';
    const jar = visitors.get(who) ?? new Map<string, string>();
    visitors.set(who, jar);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((i.headers ?? {}) as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
    let body: string | undefined;
    if (i.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = typeof i.body === 'string' ? i.body : JSON.stringify(i.body);
      if (typeof i.body !== 'string') headers['content-type'] ??= 'application/json';
    }
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let res: Response;
    try { res = await fetch(`http://127.0.0.1:${port}${i.path}`, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
    catch (e) { throw new CommandError('failed', `the project's server did not answer ${method} ${i.path}: ${e instanceof Error ? e.message : e}`); }
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const at = pair.indexOf('=');
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    // What changes something is kept as something that happened: the person sees what was done with their project.
    if (method !== 'GET' && method !== 'HEAD') events.add({ type: 'page.did', by, what: 'request', did: `sent ${method} ${i.path} to ${i.copy ? 'the working copy\'s' : 'the project\'s'} server as ${who}: ${res.status}`, showing: i.copy ? 'copy' : 'project' });
    return {
      status: res.status, type, as: who, ...(res.headers.get('location') && { location: res.headers.get('location') }),
      body: text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length - 8000} more characters)` : text,
    };
  }

  /**
   * An accepted change set that changed what the project depends on (its package.json): the agent's copy had that
   * installed, the project has not, so it is installed there too. How that went is said; it does not undo the accept.
   * The lockfile that installing writes there is the engine's own writing, so the engine commits it: left as it is,
   * it would look like work of the person's, and stand in the way of the next change set that has a lockfile.
   * (One the person was in the middle of changing themselves is theirs, and is left alone.)
   */
  function install(taken: FileChange[]): Promise<true | string | undefined> {
    if (!taken.some((f) => f.path === 'package.json') || !existsSync(join(project.root, 'package.json'))) return Promise.resolve(undefined);
    const ours = !!code?.settled(LOCKFILE);
    return new Promise((resolve) => {
      execFile(process.env.TANDEM_NPM ?? 'npm', ['install'], { cwd: project.root, timeout: 5 * 60_000 }, (err, _out, said) => {
        // (And the copy takes it in at once: a lockfile the agent then writes there changes this one, instead of clashing with it.)
        if (ours) try { if (code!.commitProject('What installing what the project depends on wrote', [LOCKFILE])) code!.sync(); } catch { /* it stays as it is, and is said when it stands in the way */ }
        resolve(err ? (String(said).trim().split('\n').filter((l) => /\berr\b/i.test(l)).slice(0, 2).join(' ') || err.message.split('\n')[0]).slice(0, 300) : true);
      });
    });
  }

  /**
   * Something was accepted: what the engine wrote in the project for it (a concept, a drawing, how it is run) is
   * committed, and the project's branch goes to its remote when it has one. How a push went is said; one that
   * does not go undoes nothing.
   */
  async function publish(by: By) {
    if (!code) return;
    try {
      code.commitProject('What was changed and accepted in tandem');
      const pushed = await code.push();
      if (pushed) events.add({ type: 'project.pushed', by, ok: pushed.ok, remote: pushed.remote, branch: pushed.branch, ...(pushed.says && { says: pushed.says }) });
    } catch (e) {
      events.add({ type: 'project.pushed', by, ok: false, remote: '', branch: '', says: (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300) });
    }
  }

  /** How the project is run, as tandem keeps it: in its own folder in the project, not among the project's files. */
  const SETUP_FIELDS = ['name', 'page', 'test', 'check', 'run', 'adapter', 'art', 'edit'] as const;
  function writeSetup(after: RecordValue) {
    mkdirSync(project.dirs.tandem, { recursive: true });
    const { script, ...fields } = after;
    const now: Record<string, unknown> = { ...project.config, ...fields };
    for (const k of Object.keys(now)) if (now[k] === null || now[k] === '') delete now[k];
    writeFileSync(project.configFile, JSON.stringify(now, null, 2) + '\n');
    if (typeof script === 'string') { if (script.trim()) writeFileSync(project.pageScript, script.endsWith('\n') ? script : script + '\n'); else rmSync(project.pageScript, { force: true }); }
    for (const k of Object.keys(project.config)) delete (project.config as Record<string, unknown>)[k];
    Object.assign(project.config, now);
  }

  /** What the agent says its change set does, in plain words: what the card says, and the commit. Gone when the set is decided. */
  const aboutFile = join(dataDir, 'code-about.txt');
  const about = (text?: string) => {
    if (text === undefined) return existsSync(aboutFile) ? readFileSync(aboutFile, 'utf8').trim() : '';
    if (text) writeFileSync(aboutFile, text.trim() + '\n'); else rmSync(aboutFile, { force: true });
    return text;
  };

  /**
   * The concepts the agent says its change set is for, when it is for any: what the card names, and what the commit
   * says under its message. Only concepts that are there; one that was removed since is not named any more.
   */
  const forFile = join(dataDir, 'code-for.json');
  const belongs = (ids?: string[]): string[] => {
    if (ids === undefined) {
      try { return existsSync(forFile) ? (JSON.parse(readFileSync(forFile, 'utf8')) as string[]).filter((id) => concepts.get(id)) : []; } catch { return []; }
    }
    if (ids.length) writeFileSync(forFile, JSON.stringify(ids) + '\n'); else rmSync(forFile, { force: true });
    return ids;
  };

  /**
   * Where the change set shows: the way from where the app opens to the place it can be seen (what a person would
   * tap and fill in), and the thing itself. When the person plays the copy they are taken there. Gone with the set.
   */
  type Step = { go: string } | { tap: string } | { fill: string; text: string };
  interface Show { steps: Step[]; at?: string; text?: string }
  const showFile = join(dataDir, 'code-show.json');
  const shown = (now?: Show | null): Show | undefined => {
    if (now === undefined) { try { return existsSync(showFile) ? JSON.parse(readFileSync(showFile, 'utf8')) as Show : undefined; } catch { return undefined; } }
    if (now) writeFileSync(showFile, JSON.stringify(now, null, 2) + '\n'); else rmSync(showFile, { force: true });
    return now ?? undefined;
  };

  /**
   * An example of the change set: a page of the working copy that shows it in exactly the case it is about (a toy
   * scene the agent made in its scratchpad, or a page the project has for it). The card offers it beside playing
   * the copy. Gone with the set, and not said while a page from the scratchpad is not there.
   */
  interface Example { path: string; text?: string }
  const exampleFile = join(dataDir, 'code-example.json');
  const example = (now?: Example | null): Example | undefined => {
    if (now === undefined) {
      try {
        const kept = existsSync(exampleFile) ? JSON.parse(readFileSync(exampleFile, 'utf8')) as Example : undefined;
        return kept && made(kept.path) ? kept : undefined;
      } catch { return undefined; }
    }
    if (now) writeFileSync(exampleFile, JSON.stringify(now, null, 2) + '\n'); else rmSync(exampleFile, { force: true });
    return now ?? undefined;
  };
  /**
   * The agent's turn ended with values for the person to turn and nothing to judge them on: it is asked for the
   * example, once for a change set. What it then does is its own: make one, or say why there is none.
   */
  const askedFile = join(dataDir, 'code-example-asked');
  function wantExample() {
    if (!code || !copyPage() || existsSync(askedFile) || example()) return;
    if (!proposals.list({ status: 'pending', round: CODE }).some((p) => p.kind === 'code')) return;
    const turn = tweaks();
    if (!turn.length) return;
    writeFileSync(askedFile, '');
    events.add({
      type: 'message', by: 'engine', kind: 'example',
      text: `Your change set gives the person ${turn.length === 1 ? 'a value' : 'values'} to turn (${turn.map((t) => t.label).join('; ')}), but no example to judge ${turn.length === 1 ? 'it' : 'them'} on: where the app opens, what ${turn.length === 1 ? 'it changes' : 'they change'} may be small, one among many, or not there yet. `
        + `Make the example now: a page in your scratchpad (${SCRATCH}/example.html) that loads the project's own code from your copy and shows the thing ${turn.length === 1 ? 'that value is' : 'those values are'} about large and by itself, then \`tandem run code.example '{"path":"/${SCRATCH}/example.html","text":"what it shows"}'\`. How an example is made is in your notes on code. `
        + 'Try what you can of it without the page (the pieces it uses, run with node from your scratchpad), and say what is unseen. Leave the change set itself as it is. If no such page can be made here, say why in a sentence and make none.',
    });
  }

  /** Whether the page of an example is there, as far as tandem can tell: one from the scratchpad is a file of the copy. */
  const made = (path: string) => !path.startsWith(`/${SCRATCH}/`) || (!!code && existsSync(join(code.work, decodeURIComponent(path.split(/[?#]/)[0]))));

  /**
   * The values of the change set that the person may turn themselves, as the agent exposed them (code.expose): on
   * the card each has a slider or a field, and turning one writes it in the working copy, where the copy's page
   * shows it. Only where each is, is kept: what it is now is read from the copy. Gone with the set.
   */
  const tweaksFile = join(dataDir, 'code-tweaks.json');
  const exposed = (now?: Tweak[] | null): Tweak[] => {
    if (now === undefined) { try { return existsSync(tweaksFile) ? JSON.parse(readFileSync(tweaksFile, 'utf8')) as Tweak[] : []; } catch { return []; } }
    if (now?.length) writeFileSync(tweaksFile, JSON.stringify(now, null, 2) + '\n'); else rmSync(tweaksFile, { force: true });
    return now ?? [];
  };
  /** An exposed value where it stands in the working copy; undefined when it is not written out there (any more). */
  const standing = (t: Pick<Tweak, 'file' | 'name'>) => {
    try {
      const source = readFileSync(join(code!.work, t.file), 'utf8');
      const found = find(source, t.name);
      return found.length === 1 ? { source, found: found[0], times: 1 } : { times: found.length };
    } catch { return undefined; }
  };
  /** The exposed values as the card shows them: what each is now, and what the agent had set when the person turned it. */
  const tweaks = () => exposed().flatMap((t) => {
    const at = standing(t);
    if (!at?.found) return [];
    const { was, set: _set, ...rest } = t;
    return [{ ...rest, kind: at.found.kind, value: at.found.value, ...(at.found.whole && t.step === undefined && { step: 1 }), ...(was !== at.found.value && { was }) }];
  });
  /** What the person turned, for the agent to hear at its next turn: from what it knew to what it is now. */
  interface Turned { label: string; file: string; name: string; from: TweakValue; to: TweakValue }
  const turnedFile = join(dataDir, 'code-tweaked.json');
  const turned = (now?: Turned[]): Turned[] => {
    if (now === undefined) { try { return existsSync(turnedFile) ? JSON.parse(readFileSync(turnedFile, 'utf8')) as Turned[] : []; } catch { return []; } }
    if (now.length) writeFileSync(turnedFile, JSON.stringify(now, null, 2) + '\n'); else rmSync(turnedFile, { force: true });
    return now;
  };
  function tweaked(): string {
    const list = turned();
    if (!list.length) return '';
    turned([]);
    const say = (v: TweakValue) => (typeof v === 'string' ? `"${v}"` : String(v));
    return ` On the card of your change set the person turned ${list.length === 1 ? 'a value' : 'values'} you exposed: ${list.map((t) => `${t.label} (${t.name} in ${t.file}) from ${say(t.from)} to ${say(t.to)}`).join('; ')}. Your working copy has ${list.length === 1 ? 'it' : 'them'} so. That is the person's choice: leave ${list.length === 1 ? 'it' : 'them'} as ${list.length === 1 ? 'it is' : 'they are'} unless they ask for something else.`;
  }
  /** Whether a file of the working copy is one the agent may change, and so one whose values can be exposed. */
  const editable = (file: string) => {
    const parts = file.split('/');
    if (!file || file.startsWith('/') || file.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) return false;
    const closed = ['.git', '.tandem', 'node_modules', SCRATCH, relative(project.root, project.dirs.art), relative(project.root, project.dirs.depth)];
    if (closed.some((dir) => file === dir || file.startsWith(`${dir}/`))) return false;
    const pattern = (glob: string) => new RegExp(`^${glob.replace(/^\.?\//, '').split('**/').map((a) => a.split('**').map((b) => b.split('*').map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')).join('(?:.*/)?')}$`);
    return project.editable.some((glob) => pattern(glob).test(file));
  };

  function proposeCode(by: By, said: string, how: { tweaked?: { file: string; name: string }; anew?: boolean } = {}) {
    if (!code) return;
    const files = code.changes();
    const open = proposals.list({ status: 'pending', round: CODE });
    // What it said the change is (code.describe). Its answer is not repeated on the card: it is in the chat, right above.
    const note = about();
    if (!files.length) {
      about('');
      belongs([]);
      shown(null);
      example(null);
      rmSync(askedFile, { force: true });
      exposed(null);
      turned([]);
      // The copy is the project again: whatever was proposed is no more.
      if (open.length) { proposals.decide(CODE, 'rejected'); events.add({ type: 'proposal.decided', by, round: CODE, status: 'rejected', count: open.length, paths: ['code:working copy'] }); }
      return;
    }
    // (The first line of its answer is kept for the commit, for when it did not say what the change is.)
    const of = belongs().map((id) => concepts.get(id)!);
    const after = { files: files as never, said: said.split('\n')[0].slice(0, 120), ...(of.length && { concepts: of.map((c) => c.id) }) };
    const p = proposals.add({ round: CODE, by, kind: 'code', path: 'working copy', after, note });
    // The whole list every time: a file the agent put back is not part of the change any more.
    p.after = after;
    const show = shown();
    const turn = tweaks();
    const toy = example();
    events.add({ type: 'proposal', by, round: CODE, id: p.id, kind: 'code', path: 'working copy', files, note, ...(copyPage() && { plays: true }), ...(show && { show }), ...(toy && { example: toy }), ...(turn.length && { tweaks: turn }), ...how, ...(of.length && { touches: of.map((c) => ({ id: c.id, name: c.name, stage: c.stage })) }) });
  }

  // ------------------------------------------------------------ helpers

  /** What the person shared in the chat is kept here; it is theirs, and not part of the project. */
  const filesDir = join(dataDir, 'files');
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
  /** A file that was attached, by the name it was kept under: where it is, for the page and for the agent. */
  function attached(name: string) {
    if (!/^[\w.\- ]+$/.test(name) || !existsSync(join(filesDir, name))) return undefined;
    return { name, label: name.replace(/^[a-z0-9]+-/, ''), path: join(filesDir, name), url: `/api/file/files/${encodeURIComponent(name)}`, image: IMAGE.test(name), size: statSync(join(filesDir, name)).size };
  }

  /** The working copy, made if there is none yet, with everything the project has. */
  function bringUp() {
    try { code!.sync(); } catch (e) { throw new CommandError('failed', `the working copy could not be made or brought up to date: ${(e instanceof Error ? e.message : String(e)).split('\n').slice(-2).join(' ')}`); }
  }

  /** A job in the project, or in the agent's working copy (which runs the project as the copy has it). */
  type Ask = JobSpec extends infer S ? S extends JobSpec ? Omit<S, 'adapter'> : never : never;
  const job = <T>(spec: Ask) => runJob<T>({ ...spec, adapter: adapter! } as JobSpec, { root: project.root }).catch((e: Error) => { throw new CommandError('failed', e.message); });
  function inCopy<T>(spec: Ask): Promise<T> {
    if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
    bringUp();
    return runJob<T>({ ...spec, adapter: adapter! } as JobSpec, { root: code.work }).catch((e: Error) => { throw new CommandError('failed', `in the working copy: ${e.message}`); });
  }

  let lookN = readdirSync(looksDir).length;
  function saveLook(pic: { w: number; h: number; px: Uint32Array }) {
    const name = `look-${Date.now().toString(36)}-${++lookN}.png`;
    writeFileSync(join(looksDir, name), encodePng(pic.px, pic.w, pic.h));
    return { file: join(looksDir, name), url: `/api/file/looks/${name}` };
  }
  const newLookFile = () => {
    const name = `look-${Date.now().toString(36)}-${++lookN}.png`;
    return { file: join(looksDir, name), url: `/api/file/looks/${name}` };
  };

  /** The loose thought a concept is made from or takes in, when one is named: it has to be there. */
  const asThought = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const t = thoughts.get(id);
    if (!t) throw new CommandError('missing', `there is no loose thought ${id}; see thoughts.list`);
    return t;
  };
  /** A thought that went into the document is no longer loose. */
  const placed = (id: string | undefined, by: By) => { if (id && thoughts.remove(id)) events.add({ type: 'thought.changed', by, id, what: 'placed' }); };

  /** The change set that waits to be decided, with the concepts it is for. */
  function waitingFor() {
    const p = proposals.list({ status: 'pending', round: CODE }).find((x) => x.kind === 'code');
    if (!p) return undefined;
    return { concepts: belongs(), says: p.note.split('\n')[0] || String(p.after.said ?? ''), files: Array.isArray(p.after.files) ? p.after.files.length : 0 };
  }

  function conceptBrief(c: Concept) {
    return { id: c.id, name: c.name, stage: c.stage, locked: locks.has(`concept:${c.id}`), summary: c.text.split('\n').find((l) => l.trim())?.slice(0, 140) ?? '', links: c.links, realised: c.realised };
  }

  /** A proposed concept as its card shows it, said again when the person changed it or added it: every screen follows. */
  function showConcept(p: Proposal) {
    const now = p.before ? concepts.get(p.path) : undefined;
    const of = p.thought ? thoughts.get(p.thought) : undefined;
    events.add({
      type: 'proposal', by: p.by, round: p.round, id: p.id, kind: 'concept', path: p.path, ...(p.before && { before: p.before }), after: p.after, note: p.note,
      ...(p.questions?.length && { questions: p.questions }), ...(of && { thought: of.text }),
      ...(now && { touches: [{ id: now.id, name: now.name, stage: now.stage }] }), ...(p.proposed && { edited: Object.keys(p.proposed) }),
    });
  }

  /** The fields of a concept as the person typed them on a card: a name that says something, a stage there is, lists that are lists. */
  function conceptFields(i: { name?: string; text?: string; stage?: string; links?: unknown; realised?: unknown }): RecordValue {
    if (i.name !== undefined && !i.name.trim()) throw new CommandError('input', 'a concept has a name');
    if (i.stage !== undefined && !STAGES.includes(i.stage as Concept['stage'])) throw new CommandError('input', `stage is one of ${STAGES.join(', ')}`);
    for (const k of ['links', 'realised'] as const) checkList(i[k], k);
    const out: RecordValue = {};
    for (const k of ['name', 'text', 'stage', 'links', 'realised'] as const) if (i[k] !== undefined) out[k] = (k === 'name' ? i.name!.trim() : i[k]) as Json;
    return out;
  }

  /**
   * Concepts of a round were accepted: the agent is told which, and what the person made different on the card
   * before accepting. What they changed or added goes along in full, so it works from their words and not its own.
   */
  function tellAccepted(round: string, set: Proposal[], left: number) {
    const say = (v: Json) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
    const theirs = set.filter((p) => !isAgent(p.by) || p.proposed);
    const lines = set.map((p) => {
      const name = `${String(p.after.name ?? concepts.get(p.path)?.name ?? p.path)} (${p.path})`;
      if (!isAgent(p.by)) return `- ${name}: the person added it to the round themselves.`;
      if (!p.proposed) return `- ${name}: as you proposed it.`;
      const how = Object.keys(p.proposed).map((k) => (k === 'name' || k === 'stage' ? `${k} ${p.proposed![k] === null ? '' : `${say(p.proposed![k])} → `}${say(p.after[k])}` : `its ${k}`));
      return `- ${name}: the person changed it before accepting: ${how.join(', ')}.`;
    });
    events.add({
      type: 'message', by: 'engine', kind: 'accepted', concepts: set.map((p) => p.path), changed: theirs.length,
      ...(theirs.length && { refs: theirs.map((p) => `concept:${p.path}`) }),
      text: `The person accepted ${set.length === 1 ? 'a concept' : `${set.length} concepts`} from your proposal of round ${round}${left ? ` (${left} of that round still ${left === 1 ? 'waits' : 'wait'})` : ''}:\n${lines.join('\n')}\n`
        + (theirs.length ? 'The document has them as the person made them, which is not everywhere what you proposed: go by what it says now, and do not propose your own version again. ' : '')
        + 'This is news, not a request: carry on with what was waiting for it, if anything was; otherwise a sentence that you have seen it is enough.',
    });
  }

  /**
   * What the agent writes is short: a concept is a sentence or two, and what says what a change set does is one.
   * Long, it is not read, and has to be kept true afterwards; what does not fit is more than one concept, and is
   * split into parts. Held to it here, because being asked was not enough; the person writes what they like.
   * (A concept that is long already may be changed, not grown.)
   */
  const wordsIn = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
  const CONCEPT_WORDS = 40, SAID_WORDS = 30;
  function brief(by: By, text: string | undefined, now = '') {
    if (!isAgent(by) || text === undefined) return;
    const n = wordsIn(text);
    if (n > CONCEPT_WORDS && n > wordsIn(now)) throw new CommandError('input', `that is ${n} words, and a concept is one sentence, two at most: ${CONCEPT_WORDS} words is the most there is. Write what it is, and nothing else. When there is more to say it is more than one thing: make each part a concept of its own under this one (links: part-of), as short as this. Leave out how it works step by step, facts and numbers (they are in the code), what is built first, and your doubts (ask those, or say them in your answer)`);
  }

  /** Questions for the person: a few, each short enough to answer in a field. */
  const asQuestions = (v: unknown): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((q) => typeof q !== 'string')) throw new CommandError('input', 'questions is a list of questions, each a sentence');
    const list = (v as string[]).map((q) => q.trim()).filter(Boolean);
    if (list.length > 5) throw new CommandError('input', 'at most five questions at a time: ask what changes what you would do');
    return list;
  };
  const checkList = (v: unknown, what: string) => {
    if (v !== undefined && !Array.isArray(v)) throw new CommandError('input', `${what} is a list`);
  };

  // ------------------------------------------------------------ the commands

  const core: CommandDef[] = [
    {
      name: 'commands.list', kind: 'read',
      about: 'Every command there is: its name, what it is for, what it takes, and whether the agent may use it.',
      run: () => registry.list(),
    },

    // ---- talking
    {
      name: 'chat.send', kind: 'write', agent: 'free',
      about: 'Say something in the conversation. refs is a list of things it is about: "concept:<id>", "thought:<id>" (a loose thought), "drawing:<name>", "entity:<id>", "point:<x>,<y>", "page:<json>" (something on the project\'s page: {words, near, tag, selector, path}; near is what is written around it; three, when it is a thing in a scene three.js draws there: what it is, its geometry and material, where it is). files is a list of what chat.attach gave back: photos and files that go with it.',
      input: { text: 'string', refs: 'json?', files: 'json?' },
      run(c, i) {
        checkList(i.refs, 'refs');
        checkList(i.files, 'files');
        // Only what was really put there with chat.attach goes along: a message cannot point the agent at any file.
        const files = ((i.files ?? []) as { name?: unknown }[]).map((f) => attached(String(f?.name ?? ''))).filter(Boolean);
        return events.add({ type: 'message', by: c.by, text: i.text, ...(i.refs?.length && { refs: i.refs }), ...(files.length && { files }), ...(c.round && { round: c.round }) });
      },
    },
    {
      name: 'chat.ask', kind: 'write', agent: 'free',
      about: 'Ask the person questions they answer in fields, in the chat: questions is a list (five at most), each a sentence. about is what they are about ("concept:<id>", "drawing:<name>"), if one thing. For questions about a concept you are proposing, give them with the concept instead (questions on concepts.create and concepts.update). Their answers come back as a message.',
      input: { questions: 'json', about: 'string?' },
      run(c, i) {
        const questions = asQuestions(i.questions) ?? [];
        if (!questions.length) throw new CommandError('input', 'ask at least one question');
        const id = `q${Date.now().toString(36)}${events.last()}`;
        events.add({ type: 'questions', by: c.by, id, questions, ...(i.about?.trim() && { about: i.about.trim() }), ...(c.round && { round: c.round }) });
        return { asked: id, says: 'the person answers in the chat; their answers come as a message' };
      },
    },
    {
      name: 'chat.answer', kind: 'write',
      about: 'The person\'s answers to questions the agent asked: to is what was asked (the id of the questions, or of the proposal they came with), answers a list in the order of the questions; one left empty is not answered. They go to the agent as a message.',
      input: { to: 'string', answers: 'json' },
      run(c, i) {
        if (!Array.isArray(i.answers)) throw new CommandError('input', 'answers is a list, in the order of the questions');
        const asked = events.since(0).filter((e) => e.type === 'questions').find((e) => e.id === i.to);
        const proposal = asked ? undefined : proposals.list().find((p) => p.id === i.to);
        const questions = (asked?.questions as string[] | undefined) ?? proposal?.questions;
        if (!questions?.length) throw new CommandError('missing', `nothing was asked as ${i.to}`);
        const answers = questions.map((_q, n) => String(i.answers[n] ?? '').trim());
        if (!answers.some(Boolean)) throw new CommandError('input', 'nothing was answered');
        const about = proposal ? `${proposal.kind}:${proposal.path}` : typeof asked?.about === 'string' ? asked.about : undefined;
        const what = proposal ? ` about the ${proposal.kind} ${String((proposal.after as { name?: string }).name ?? proposal.path)}` : '';
        // (With the questions as they were answered: the agent may change them afterwards, and those are asked anew.)
        events.add({ type: 'answered', by: c.by, to: i.to, questions, answers });
        const text = `My answers to your questions${what}:\n${questions.map((q, n) => (answers[n] ? `- ${q}\n  ${answers[n]}` : '')).filter(Boolean).join('\n')}`;
        // A concept that is still a proposal is not there to be pointed at; what it is called is in the words.
        const refs = about && !(proposal && proposal.status === 'pending' && !proposal.before) ? [about] : [];
        return events.add({ type: 'message', by: c.by, kind: 'answers', text, ...(refs.length && { refs }) });
      },
    },
    {
      name: 'chat.attach', kind: 'write',
      about: 'Put a photo or a file with the conversation, to send along with a message (chat.send: files). name is what it is called, data its contents in base64. Gives back where it is kept.',
      input: { name: 'string', data: 'string' },
      run(_c, i) {
        // Its own name, without whatever folder it came from.
        const clean = (i.name.split(/[\\/]/).pop() ?? '').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
        const name = `${Date.now().toString(36)}-${clean}`;
        let bytes: Buffer;
        try { bytes = Buffer.from(i.data, 'base64'); } catch { throw new CommandError('input', 'data is the file in base64'); }
        if (!bytes.length) throw new CommandError('input', 'the file is empty');
        mkdirSync(filesDir, { recursive: true });
        writeFileSync(join(filesDir, name), bytes);
        return attached(name);
      },
    },
    {
      name: 'chat.history', kind: 'read',
      about: 'The last messages of this conversation (limit defaults to 20). A conversation starts at the last chat.new.',
      input: { limit: 'number?' },
      run(_c, i) {
        const all = events.since(0);
        const from = all.map((e) => e.type).lastIndexOf('chat.new') + 1;
        return all.slice(from).filter((e) => e.type === 'message').slice(-(i.limit ?? 20)).map((e) => ({ n: e.n, by: e.by, text: e.text, refs: e.refs }));
      },
    },
    {
      name: 'chat.new', kind: 'write',
      about: 'Start a new conversation: the chat is cleared and the agent forgets what was said. What was made stays: concepts, drawings, code, and proposals that are still pending.',
      run: (c) => events.add({ type: 'chat.new', by: c.by }),
    },
    {
      name: 'project.init', kind: 'write',
      about: 'Set tandem up for a project that exists already: the agent reads it and proposes the concepts it is made of and how tandem runs it. note adds anything it should know. Only the person asks for this.',
      input: { note: 'string?' },
      run(c, i) {
        const text = readFileSync(join(ROOT, 'core/agent-init.md'), 'utf8').trim();
        // It is the engine that sets the agent to work; what the person added goes with it.
        events.add({ type: 'message', by: 'engine', kind: 'init', text: i.note?.trim() ? `${text}\n\nThe person adds: ${i.note.trim()}` : text, asked: c.by });
        return { asked: true, says: 'the agent is reading the project; what it proposes comes in the chat' };
      },
    },
    {
      name: 'project.remote', kind: 'read',
      about: 'Where the project is pushed after every accept: the address of its remote and the branch that goes there, or no address when it has none. Setting it is the person\'s, under Projects.',
      run: () => {
        const to = code?.remote();
        return { git: !!code, url: to?.url ?? null, ...(to && { remote: to.name, branch: to.branch }) };
      },
    },
    {
      name: 'project.setRemote', kind: 'write',
      about: 'Say where the project is pushed: url is the address of a repository that is there already (made empty on GitHub, say). It is the project\'s origin from then on, what is there now is pushed at once, and after every accept what was accepted. An empty url takes the remote away. Only the person does this.',
      input: { url: 'string' },
      async run(c, i) {
        if (!code) throw new CommandError('unsupported', 'the project is not in a git repository, so there is nothing to push');
        try { code.setRemote(i.url); } catch (e) { throw new CommandError('input', e instanceof Error ? e.message.split('\n')[0] : String(e)); }
        events.add({ type: 'remote.changed', by: c.by, url: i.url.trim() });
        if (!i.url.trim()) return { url: null };
        await publish(c.by);
        const said = events.since(0).at(-1)!;
        return { url: i.url.trim(), ...(said.type === 'project.pushed' && { pushed: !!said.ok, ...(typeof said.says === 'string' && { says: said.says }) }) };
      },
    },
    {
      name: 'project.setup', kind: 'read',
      about: 'How tandem runs this project, as it is written down now: the fields of its tandem.json, the script that starts its page if there is one, and where they are kept.',
      run: () => ({ config: project.config, script: existsSync(project.pageScript) ? readFileSync(project.pageScript, 'utf8') : null, kept: { config: project.configFile, script: project.pageScript } }),
    },
    {
      name: 'project.configure', kind: 'write', agent: 'proposes',
      about: 'Say how tandem runs this project. It is kept in tandem\'s own folder in the project (.tandem), not among the project\'s files. Fields, all optional: name; page (the command that starts its page, with {port} where the port goes; {project} is the project\'s folder, {tandem} tandem\'s folder in it); test and check (commands the agent may run); run (a list of more commands it may run); adapter; art ({build}); edit. script is the text of a shell script for when starting the page takes more than one command: it is kept as {tandem}/page.sh, so page is then "sh {tandem}/page.sh {port}". An empty value takes a field away. The agent\'s becomes a proposal.',
      input: { name: 'string?', page: 'string?', test: 'string?', check: 'string?', run: 'json?', adapter: 'string?', art: 'json?', edit: 'json?', script: 'string?', note: 'string?' },
      run(c, i) {
        if (i.page && !i.page.includes('{port}')) throw new CommandError('input', 'page needs {port} where the port goes: tandem starts the page on a port of its choosing, and a second time for the working copy');
        for (const k of ['run', 'edit'] as const) if (i[k] !== undefined && i[k] !== null && !(Array.isArray(i[k]) && (i[k] as unknown[]).every((x) => typeof x === 'string'))) throw new CommandError('input', `${k} is a list of strings`);
        const was: Record<string, unknown> = { ...project.config, script: existsSync(project.pageScript) ? readFileSync(project.pageScript, 'utf8') : undefined };
        const after: Record<string, unknown> = {};
        for (const k of [...SETUP_FIELDS, 'script'] as const) if (i[k] !== undefined && !same(i[k], was[k] ?? '')) after[k] = i[k];
        if (!Object.keys(after).length) return { changed: false };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          const before = Object.fromEntries(Object.keys(after).filter((k) => was[k] !== undefined).map((k) => [k, was[k]]));
          const p = proposals.add({ round, by: c.by, kind: 'setup', path: 'how it is run', ...(Object.keys(before).length && { before: before as RecordValue }), after: after as RecordValue, note: i.note ?? '' });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'setup', path: 'how it is run', before: p.before, after: p.after, note: p.note });
          return { proposed: p.id, round, says: 'it is the person\'s to accept; the project\'s page is started again with it when they do' };
        }
        writeSetup(after as RecordValue);
        events.add({ type: 'setup.changed', by: c.by, fields: Object.keys(after), restarting: !!process.env.TANDEM_SUPERVISED });
        restart(SETUP);
        return { changed: true };
      },
    },
    {
      name: 'events.since', kind: 'read',
      about: 'Everything that happened after event number n: messages, proposals, pictures, playtests.',
      input: { n: 'number' },
      run: (_c, i) => events.since(i.n),
    },

    // ---- locks
    {
      name: 'locks.list', kind: 'read',
      about: 'What is locked: things that are the person\'s alone. The agent cannot change a locked thing or propose a change to it, even when asked.',
      run: () => locks.list(),
    },
    {
      name: 'locks.set', kind: 'write',
      about: 'Lock or unlock something: ref is "concept:<id>" or "drawing:<name>". Only the person does this.',
      input: { ref: 'string', locked: 'boolean' },
      run(c, i) {
        if (locks.has(i.ref) === i.locked) return { locked: i.locked };
        locks.set(i.ref, i.locked);
        events.add({ type: 'lock.changed', by: c.by, ref: i.ref, locked: i.locked });
        return { locked: i.locked };
      },
    },

    // ---- proposals
    {
      name: 'proposals.list', kind: 'read',
      about: 'What has been proposed: all of it, or only what is pending, accepted or rejected.',
      input: { status: 'string?' },
      run: (_c, i) => proposals.list({ status: i.status }),
    },
    {
      name: 'proposals.edit', kind: 'write',
      about: 'Change a concept that is still a proposal, before deciding on it: its name, text, stage, links or realised, as the person wants them. Accepted, the concept is as they made it, and the agent is told what they changed. Only the person does this.',
      input: { id: 'string', name: 'string?', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?' },
      run(_c, i) {
        const p = proposals.list({ status: 'pending' }).find((x) => x.id === i.id);
        if (!p) throw new CommandError('missing', `no proposal ${i.id} is pending`);
        if (p.kind !== 'concept') throw new CommandError('unsupported', 'only a proposed concept can be changed before it is decided');
        const was = JSON.stringify(p.after);
        const now = concepts.get(p.path);
        proposals.edit(p.id, conceptFields(i), now && (now as unknown as RecordValue));
        if (JSON.stringify(p.after) === was) return { changed: false };
        showConcept(p);
        return { changed: true };
      },
    },
    {
      name: 'proposals.add', kind: 'write',
      about: 'Add a concept of the person\'s own to a round of proposed concepts that still waits: a name, and if they have them its text, stage, links and realised. It is decided with the rest of the round, and the agent is told of it when it is accepted. Only the person does this.',
      input: { round: 'string', name: 'string', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?' },
      run(c, i) {
        if (!proposals.list({ status: 'pending', round: i.round }).some((p) => p.kind === 'concept')) throw new CommandError('missing', `no concept is pending in round ${i.round}`);
        const fields = conceptFields(i);
        const cid = concepts.slug(i.name);
        if (concepts.get(cid) || proposals.list({ status: 'pending' }).some((p) => p.kind === 'concept' && p.path === cid)) throw new CommandError('exists', `there already is a concept ${cid}`);
        const p = proposals.add({ round: i.round, by: c.by, kind: 'concept', path: cid, after: { stage: 'idea', links: [], realised: [], text: '', ...fields }, note: '' });
        showConcept(p);
        return { proposed: p.id, id: cid, round: i.round };
      },
    },
    {
      name: 'proposals.decide', kind: 'write',
      about: 'Accept or reject a round of proposals: all that is pending in it, or only some (only: the ids of the proposals). Accepting makes the changes real.',
      input: { round: 'string', accept: 'boolean', only: 'json?' },
      async run(c, i) {
        const only = Array.isArray(i.only) && i.only.length ? (i.only as unknown[]).map(String) : undefined;
        const open = proposals.list({ status: 'pending', round: i.round });
        const pending = only ? open.filter((p) => only.includes(p.id)) : open;
        if (!pending.length) throw new CommandError('missing', only ? `none of those is pending in round ${i.round}` : `nothing is pending in round ${i.round}`);
        let taken: FileChange[] = [];
        if (i.accept) {
          if (pending.some((p) => p.kind === 'drawing')) art.acceptable(i.round);
          // The working copy goes into the project first: if it does not go in cleanly, nothing is accepted.
          if (code && pending.some((p) => p.kind === 'code')) {
            try {
              const p = pending.find((x) => x.kind === 'code')!;
              const said = p.note.split('\n')[0].slice(0, 120) || String(p.after.said ?? '') || 'Accepted from the working copy';
              // What the person turned before accepting is said under it: the agent's words are about what it had set.
              const say = (v: TweakValue) => (typeof v === 'string' ? `"${v}"` : String(v));
              const mine = tweaks().filter((t) => t.was !== undefined);
              const whole = mine.length ? `${said}\n\nSet by the person before accepting:\n${mine.map((t) => `- ${t.label}: ${say(t.value)}, where the agent had ${say(t.was!)} (${t.name} in ${t.file})`).join('\n')}` : said;
              taken = code.accept(forConcepts(whole, belongs()));
            }
            catch (e) { throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
          }
          await art.accepting(pending);
        } else if (code && pending.some((p) => p.kind === 'code')) code.reject();
        // (What the person turned and then accepted is in the project: the agent still hears of it. Rejected, it is gone.)
        if (pending.some((p) => p.kind === 'code')) { about(''); belongs([]); shown(null); example(null); rmSync(askedFile, { force: true }); exposed(null); if (!i.accept) turned([]); }
        const set = proposals.decide(i.round, i.accept ? 'accepted' : 'rejected', only);
        if (i.accept) {
          for (const p of set) {
            if (p.kind === 'concept') {
              const now = concepts.get(p.path);
              concepts.save({ id: p.path, name: p.path, stage: 'idea', links: [], realised: [], text: '', ...now, ...(p.after as Partial<Concept>) });
              placed(p.thought, c.by);
            }
            if (p.kind === 'setup') writeSetup(p.after);
          }
        }
        // What was not named is still waiting: the round is over when nothing of it is.
        const left = open.length - set.length;
        if (!left) art.decided(i.round);
        const setup = i.accept && set.some((p) => p.kind === 'setup');
        if (setup) events.add({ type: 'setup.changed', by: c.by, fields: set.filter((p) => p.kind === 'setup').flatMap((p) => Object.keys(p.after)), restarting: !!process.env.TANDEM_SUPERVISED });
        const installed = taken.length ? await install(taken) : undefined;
        if (taken.length) events.add({ type: 'code.changed', by: c.by, files: taken.map((f) => f.path), ...(installed !== undefined && { installed }), ...(installed === true && process.env.TANDEM_SUPERVISED && { restarting: true }) });
        // The core has the project's code in it as it was when it started: it starts again with the new code. When
        // how the project is run was changed, the project's page is started again too.
        // (And after an install: a page that is running does not find what was not there when it started.)
        if (setup || installed === true) restart(SETUP); else if (taken.length) restart();
        events.add({ type: 'proposal.decided', by: c.by, round: i.round, status: i.accept ? 'accepted' : 'rejected', count: set.length, ids: set.map((p) => p.id), left, paths: set.map((p) => `${p.kind}:${p.path}`) });
        // The agent hears what became of its concepts, and what the person made different in them.
        const made = set.filter((p) => p.kind === 'concept');
        if (i.accept && made.length) tellAccepted(i.round, made, left);
        // (Before the core starts again, if it does: a restart waits for this command to be done.)
        if (i.accept) await publish(c.by);
        return { decided: set.length, left };
      },
    },

    // ---- concepts: the layer the person works in
    {
      name: 'concepts.list', kind: 'read',
      about: 'Every concept: its name, its stage (idea, design, build, playtest), whether it is locked, its first line, how many changes to the project were made for it (changes), and whether one is waiting to be decided (waiting).',
      run() {
        const made = code?.history() ?? [];
        const waiting = waitingFor();
        return concepts.list().map((c) => {
          const changes = made.filter((m) => m.concepts.includes(c.id)).length;
          return { ...conceptBrief(c), ...(changes && { changes }), ...(waiting?.concepts.includes(c.id) && { waiting: true }) };
        });
      },
    },
    {
      name: 'concepts.history', kind: 'read',
      about: 'What was changed in the project for one concept: the commits that name it (a line "Concept: <id>" under the message, which an accepted change set gets from code.describe and the person can write in a commit of their own), the newest first, and the change set that is waiting to be decided when it is for this concept.',
      input: { id: 'string' },
      run(_c, i) {
        if (!concepts.get(i.id)) throw new CommandError('missing', `there is no concept ${i.id}; see concepts.list`);
        const waiting = waitingFor();
        return {
          ...(waiting?.concepts.includes(i.id) && { waiting: { says: waiting.says, files: waiting.files } }),
          changes: (code?.history() ?? []).filter((m) => m.concepts.includes(i.id)).slice(0, 40).map((m) => ({ hash: m.hash.slice(0, 10), ts: m.ts, says: m.subject })),
        };
      },
    },
    {
      name: 'concepts.get', kind: 'read',
      about: 'One concept in full: the words, its stage, whether it is locked, its links and what makes it real.',
      input: { id: 'string' },
      run(_c, i) {
        const c = concepts.get(i.id);
        if (!c) throw new CommandError('missing', `there is no concept ${i.id}; see concepts.list`);
        return { ...c, locked: locks.has(`concept:${c.id}`) };
      },
    },
    {
      name: 'concepts.create', kind: 'write', agent: 'proposes',
      about: 'A new concept: a name and a description in plain words, and if known its stage, its links ([{to, kind}], kind is part-of, leads-to or clashes-with; to may be a concept proposed in the same round) and what makes it real (realised: paths, drawings, tests). questions is a list of what only the person can say about it: each gets a field on the card for their answer. It starts as an idea unless said otherwise. thought is the id of a loose thought of the person (thoughts.list) that this concept is made from: it stops being loose when the concept is there. The agent\'s becomes a proposal.',
      input: { name: 'string', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?', questions: 'json?', thought: 'string?' },
      run(c, i) {
        const questions = asQuestions(i.questions);
        const from = asThought(i.thought);
        const cid = concepts.slug(i.name);
        if (concepts.get(cid)) throw new CommandError('exists', `there already is a concept ${cid}`);
        for (const k of ['links', 'realised'] as const) checkList(i[k], k);
        brief(c.by, i.text);
        const stage = STAGES.includes(i.stage) ? i.stage : 'idea';
        const fresh: Concept = { id: cid, name: i.name, stage, links: i.links ?? [], realised: i.realised ?? [], text: i.text ?? '' };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          const { id: _id, ...after } = fresh;
          const p = proposals.add({ round, by: c.by, kind: 'concept', path: cid, after: after as unknown as RecordValue, note: 'a new concept', ...(questions && { questions }), ...(from && { thought: from.id }) });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'concept', path: cid, after: p.after, note: p.note, ...(p.questions?.length && { questions: p.questions }), ...(from && { thought: from.text }) });
          return { proposed: p.id, id: cid, round };
        }
        concepts.save(fresh);
        events.add({ type: 'concept.changed', by: c.by, id: cid, what: 'created' });
        placed(from?.id, c.by);
        return { id: cid };
      },
    },
    {
      name: 'concepts.update', kind: 'write', agent: 'proposes',
      about: 'Change a concept: its name, text, stage (idea, design, build, playtest), links ([{to, kind}], kind is part-of, leads-to or clashes-with), realised (record paths, drawings, tests). questions is a list of what only the person can say about the change: each gets a field on the card for their answer (an empty list takes the questions of a pending proposal away). thought is the id of a loose thought of the person (thoughts.list) that this change works into the concept: it stops being loose when the change is made. The agent\'s becomes a proposal.',
      input: { id: 'string', name: 'string?', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?', note: 'string?', questions: 'json?', thought: 'string?' },
      run(c, i) {
        const questions = asQuestions(i.questions);
        const from = asThought(i.thought);
        if (i.stage !== undefined && !STAGES.includes(i.stage)) throw new CommandError('input', `stage is one of ${STAGES.join(', ')}`);
        brief(c.by, i.text, concepts.get(i.id)?.text);
        // A concept that is itself still a proposal is worked on further as that proposal: its links and what makes it
        // real do not have to wait until the person has accepted it.
        const coming = concepts.get(i.id) ? undefined : proposals.list({ status: 'pending' }).find((p) => p.kind === 'concept' && p.path === i.id && !p.before);
        if (coming && isAgent(c.by)) {
          for (const k of ['links', 'realised'] as const) checkList(i[k], k);
          const more: Record<string, unknown> = {};
          for (const k of ['name', 'text', 'stage', 'links', 'realised'] as const) if (i[k] !== undefined && !same(i[k], coming.after[k])) more[k] = i[k];
          if (!Object.keys(more).length && !questions) return { changed: false };
          const p = proposals.add({ round: coming.round, by: c.by, kind: 'concept', path: i.id, after: more as RecordValue, note: coming.note, ...(questions && { questions }), ...(from && { thought: from.id }) });
          const of = p.thought ? thoughts.get(p.thought) : undefined;
          events.add({ type: 'proposal', by: c.by, round: p.round, id: p.id, kind: 'concept', path: i.id, after: p.after, note: p.note, ...(p.questions?.length && { questions: p.questions }), ...(of && { thought: of.text }) });
          return { proposed: p.id, round: p.round, says: 'added to the proposal of this new concept' };
        }
        const now = concepts.get(i.id);
        if (!now) throw new CommandError('missing', `there is no concept ${i.id}; see concepts.list`);
        locks.guard(`concept:${i.id}`, c.by);
        for (const k of ['links', 'realised'] as const) checkList(i[k], k);
        const after: Record<string, unknown> = {};
        for (const k of ['name', 'text', 'stage', 'links', 'realised'] as const)
          if (i[k] !== undefined && !same(i[k], now[k])) after[k] = i[k];
        if (!Object.keys(after).length) return { changed: false };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          const before = Object.fromEntries(Object.keys(after).map((k) => [k, now[k as keyof Concept]]));
          const p = proposals.add({ round, by: c.by, kind: 'concept', path: i.id, before: before as RecordValue, after: after as RecordValue, note: i.note ?? '', ...(questions && { questions }), ...(from && { thought: from.id }) });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'concept', path: i.id, before: p.before, after: p.after, note: p.note, ...(p.questions?.length && { questions: p.questions }), ...(from && { thought: from.text }), touches: [{ id: now.id, name: now.name, stage: now.stage }] });
          return { proposed: p.id, round };
        }
        concepts.save({ ...now, ...(after as Partial<Concept>) });
        events.add({ type: 'concept.changed', by: c.by, id: i.id, what: 'updated', fields: Object.keys(after) });
        placed(from?.id, c.by);
        return { changed: true };
      },
    },
    {
      name: 'concepts.remove', kind: 'write',
      about: 'Throw a concept away.',
      input: { id: 'string' },
      run(c, i) {
        if (!concepts.get(i.id)) throw new CommandError('missing', `there is no concept ${i.id}`);
        concepts.remove(i.id);
        events.add({ type: 'concept.changed', by: c.by, id: i.id, what: 'removed' });
        return { removed: true };
      },
    },

    // ---- loose thoughts: what the person typed without saying where it belongs
    {
      name: 'thoughts.list', kind: 'read',
      about: 'The person\'s loose thoughts: what they typed without a name or a place for it. They are not part of the concepts; one becomes part of them only when the person wants it to (thought on concepts.create or concepts.update).',
      run: () => thoughts.list(),
    },
    {
      name: 'thoughts.add', kind: 'write',
      about: 'Keep a loose thought: a few words or lines, as they come. Only the person does this.',
      input: { text: 'string' },
      run(c, i) {
        if (!i.text.trim()) throw new CommandError('input', 'a thought has words');
        const made = thoughts.add(i.text.slice(0, 4000));
        events.add({ type: 'thought.changed', by: c.by, id: made.id, what: 'added' });
        return made;
      },
    },
    {
      name: 'thoughts.remove', kind: 'write',
      about: 'Throw a loose thought away. Only the person does this.',
      input: { id: 'string' },
      run(c, i) {
        if (!thoughts.remove(i.id)) throw new CommandError('missing', `there is no loose thought ${i.id}`);
        events.add({ type: 'thought.changed', by: c.by, id: i.id, what: 'removed' });
        return { removed: true };
      },
    },

    // ---- worlds
    {
      name: 'world.push', kind: 'write',
      about: 'The page shares the world being played, so the agent can read it and look at it. Done by the page every few seconds.',
      input: { snapshot: 'json' },
      run(_c, i) {
        rooms.set('mine', { snapshot: i.snapshot, at: Date.now() });
        writeFileSync(mineFile, JSON.stringify(i.snapshot));
        return { ok: true };
      },
    },
    {
      name: 'world.rooms', kind: 'read',
      about: 'The worlds on the host: mine (a mirror of the one being played) and the sandboxes.',
      run: () => [...rooms].map(([name, r]) => ({ name, sandbox: name !== 'mine', secondsAgo: Math.round((Date.now() - r.at) / 1000) })),
    },
    {
      name: 'world.fork', kind: 'write', agent: 'free',
      about: 'Make a sandbox world to play and poke in: a copy of the one being played (from "mine", the default), of another room, or a brand new game (from "new").',
      input: { room: 'string', from: 'string?' },
      run(_c, i) {
        if (i.room === 'mine' || !/^[a-z][a-z0-9-]{0,30}$/.test(i.room)) throw new CommandError('input', 'a sandbox is named in lower-case letters, and is not called mine');
        const from = i.from ?? 'mine';
        const snapshot = from === 'new' ? undefined : world(from).snapshot();
        rooms.set(i.room, { world: build(snapshot), at: Date.now() });
        return { room: i.room, state: world(i.room).describe() };
      },
    },
    {
      name: 'world.drop', kind: 'write', agent: 'free',
      about: 'Throw a sandbox away.',
      input: { room: 'string' },
      run(_c, i) {
        if (i.room === 'mine') throw new CommandError('permission', 'mine is not a sandbox');
        return { dropped: rooms.delete(i.room) };
      },
    },
    {
      name: 'game.state', kind: 'read',
      about: 'A world in words and numbers: where the player is, what they have, what is unlocked. Without a room, the one being played.',
      input: { room: 'string?' },
      run: (_c, i) => ({ room: i.room ?? 'mine', state: world(i.room).describe() }),
    },
    {
      name: 'game.look', kind: 'look',
      about: 'A picture of a world as it is now, with the same state in words. The file can be read as an image. With copy, the same world as the agent\'s working copy draws it: how a change to the game\'s code looks, before it is accepted. The mirror of the world being played has the right state but not the exact places of everything in it.',
      input: { room: 'string?', copy: 'boolean?', caption: 'string?' },
      async run(c, i) {
        const w = world(i.room);
        if (i.copy) {
          const look = newLookFile();
          const res = await inCopy<{ text: string }>({ do: 'look', snapshot: w.snapshot(), out: look.file });
          events.add({ type: 'look', by: c.by, url: look.url, caption: i.caption ?? `${i.room ?? 'the world being played'}, as the working copy draws it`, text: res.text });
          return { ...look, text: res.text };
        }
        const look = saveLook(game.render(w, { time: 3.3 }));
        const text = w.describe();
        events.add({ type: 'look', by: c.by, url: look.url, caption: i.caption ?? `${i.room ?? 'the world being played'}, now`, text });
        return { ...look, text };
      },
    },
    {
      name: 'game.lookAt', kind: 'look',
      about: 'A picture of the game some minutes in: a new game is played up to there by a bot (profile: eager or casual) and drawn. With copy, the game as the agent\'s working copy has it. Takes a few seconds per hour of game.',
      input: { minutes: 'number', profile: 'string?', copy: 'boolean?', caption: 'string?' },
      async run(c, i) {
        const look = newLookFile();
        const spec = { do: 'lookAt' as const, minutes: Math.max(0, i.minutes), profile: i.profile, out: look.file };
        const res = i.copy ? await inCopy<{ text: string }>(spec) : await job<{ text: string }>(spec);
        events.add({ type: 'look', by: c.by, url: look.url, caption: i.caption ?? `${i.minutes} minutes in${i.copy ? ', in the working copy' : ''}`, text: res.text });
        return { ...look, text: res.text };
      },
    },

    {
      name: 'world.snapshot', kind: 'read',
      about: 'A world as data, to start it again somewhere else: what the page of the working copy starts from, so a change is played where the person is.',
      input: { room: 'string?' },
      run: (_c, i) => world(i.room).snapshot() ?? null,
    },

    // ---- code: the agent's working copy
    {
      name: 'code.changes', kind: 'read',
      about: 'What the agent\'s working copy of the game changes, against the project: the files, and how many lines came and went. With path, the change in that file to read.',
      input: { path: 'string?' },
      run(_c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        return i.path ? { path: i.path, diff: code.diff(i.path) } : { files: code.changes() };
      },
    },
    {
      name: 'code.describe', kind: 'write', agent: 'free',
      about: 'Say what the working copy\'s change set does, for the person: one short sentence in plain words, thirty words at most about what is different when the project is used, not which files or how. It describes the whole change set as it stands, everything the person gets by accepting it, not the step you took last: when you add to a change set, say it again so that it still covers all of it. It is what the proposal says, and its first line is the commit when it is accepted. concepts is a list of the ids of the concepts the change set is for, when it makes or changes something a concept that exists is about: the card names them, the commit says so, and the concept shows the change. Leave it out to keep what was said before; an empty list for a change that is for no concept (a fix, tidying up).',
      input: { text: 'string', concepts: 'json?' },
      run(c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        if (!i.text.trim()) throw new CommandError('input', 'say what the change does');
        if (isAgent(c.by) && wordsIn(i.text) > SAID_WORDS) throw new CommandError('input', `that is ${wordsIn(i.text)} words: say what is different when the project is used in one short sentence, ${SAID_WORDS} words at the most. No list of what is in it: the card shows the files`);
        if (i.concepts !== undefined) {
          if (!Array.isArray(i.concepts) || (i.concepts as unknown[]).some((id) => typeof id !== 'string')) throw new CommandError('input', 'concepts is a list of concept ids, like ["slow-burn"]');
          const ids = [...new Set(i.concepts as string[])];
          const none = ids.find((id) => !concepts.get(id));
          if (none !== undefined) throw new CommandError('missing', `there is no concept ${none}; see concepts.list. A change set is only said to be for a concept that exists: leave it out rather than make one up`);
          belongs(ids);
        }
        const was = about();
        about(i.text);
        // Said by hand while a proposal is open, the card says it at once; the agent's is shown when its reply is done.
        if (proposals.list({ status: 'pending', round: CODE }).length) proposeCode(c.by, i.text);
        const files = code.changes().map((f) => f.path);
        return {
          said: i.text.trim(),
          // What it replaces is said back, with what the change set holds: a description of the last step alone
          // would leave the rest of the change unnamed, on the card and in the commit.
          ...(was && was !== i.text.trim() && { replaces: was }),
          ...(belongs().length && { concepts: belongs() }),
          covers: files,
          says: `this is now the description of the whole change set (${files.length} ${files.length === 1 ? 'file' : 'files'}); if it only says what you did last, say it again so that it covers all of it`,
        };
      },
    },
    {
      name: 'code.show', kind: 'write', agent: 'free',
      about: 'Say where the working copy\'s change set can be seen, so the person lands on it when they play the copy: steps is the way there from where the app opens, as a person would go, a list of {"go": "/path"}, {"tap": "the words on it"} and {"fill": "what the field is called", "text": "what goes in"}; at is the thing itself (the words on it, or a CSS selector) and text a few words to say with it. They are taken there with what their browser remembers of the project, and a ring is put around it. An empty list of steps and no at takes it away.',
      input: { steps: 'json?', at: 'string?', text: 'string?' },
      run(c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        const raw = i.steps ?? [];
        if (!Array.isArray(raw) || raw.length > 12) throw new CommandError('input', 'steps is a list of at most twelve steps');
        const steps = (raw as Record<string, unknown>[]).map((st): Step => {
          if (st && typeof st.go === 'string' && /^[/?#]/.test(st.go) && !st.go.startsWith('//')) return { go: st.go };
          if (st && typeof st.tap === 'string' && st.tap.trim()) return { tap: st.tap.trim() };
          if (st && typeof st.fill === 'string' && st.fill.trim() && typeof st.text === 'string') return { fill: st.fill.trim(), text: st.text };
          throw new CommandError('input', 'a step is {"go": "/path"}, {"tap": "the words on it"} or {"fill": "what the field is called", "text": "what goes in"}');
        });
        const at = i.at?.trim();
        if (!steps.length && !at) { shown(null); return { shown: false }; }
        const show: Show = { steps, ...(at && { at }), ...(i.text?.trim() && { text: i.text.trim() }) };
        shown(show);
        if (proposals.list({ status: 'pending', round: CODE }).length) proposeCode(c.by, '');
        return { shown: true, says: 'when the person plays your copy they are taken there; you cannot try the steps on their screen unless they ask you to use the app, so take the words from the code' };
      },
    },
    {
      name: 'code.example', kind: 'write', agent: 'free',
      about: `Give the person an example of your change set to play, beside your copy itself: a page that shows the change in exactly the case it is about, so they do not have to play their way to it. path is that page as your copy's page serves it: one you wrote in your scratchpad ("/${SCRATCH}/example.html", which loads the project's own code from your copy and sets up the case; it is never part of the change set), or a path the project has for it already; text is a few words on what it shows. The card then has "Play the example" next to playing the copy, and the values you exposed can be turned there too. No path takes it away.`,
      input: { path: 'string?', text: 'string?' },
      run(c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        const asked = i.path?.trim();
        if (asked) {
          if (!copyPage()) throw new CommandError('unsupported', 'the project has no page to show an example on (project.configure: page)');
          // (A file of the copy may be named as it is named there: it is the same page.)
          const path = asked.startsWith('/') ? asked : `/${asked.replace(/^\.\//, '')}`;
          if (path.startsWith('//') || /[\s\\]/.test(path) || path.split(/[?#]/)[0].split('/').includes('..')) throw new CommandError('input', `path is a path on your copy's own page, like "/${SCRATCH}/example.html"`);
          if (!made(path)) throw new CommandError('missing', `there is no file ${path.split(/[?#]/)[0].slice(1)} in your working copy: write the page first`);
          example({ path, ...(i.text?.trim() && { text: i.text.trim().slice(0, 140) }) });
        } else example(null);
        if (proposals.list({ status: 'pending', round: CODE }).length) proposeCode(c.by, '');
        if (!asked) return { example: false };
        return { example: true, path: example()!.path, says: 'the person finds it on the card of your change set, beside playing your copy. A page you made is a guess until you have seen it: look at it yourself when you can (page.take, then page.go with this path and copy: true)' };
      },
    },
    {
      name: 'code.expose', kind: 'write', agent: 'free',
      about: 'Give the person a value of your change set to turn themselves: one you guessed and that they will have an opinion about (how fast, how big, which colour), for tweaking. Not what makes the thing work, not a fact, not a setting the page has itself. values is a list of {"label": "what it is, in their words", "file": "the file in your working copy", "name": "the name the value has there"}, and for a number "min" and "max" (it then gets a slider) and "step". The value is one that is written out where it is named, once in that file: a number, true or false, a text in quotes or a colour (NAME = 4, name: 4, "name": 4, --name: 4px); give a value that is buried in a sum or used in passing a named constant of its own first. On the card each gets a slider, a switch or a field, and what the person sets is written in your working copy at once, so the copy\'s page shows it while they turn it; it is accepted with the rest. You hear what they turned at their next message. Say the whole list every time; an empty list takes them away.',
      input: { values: 'json' },
      run(c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        if (!Array.isArray(i.values) || i.values.length > 8) throw new CommandError('input', 'values is a list of at most eight values');
        const before = exposed();
        const list = (i.values as Record<string, unknown>[]).map((v): Tweak => {
          if (v && typeof v.label === 'string' && v.label.trim().length > 80) throw new CommandError('input', `a label is a few words, at most 80 letters: "${v.label.trim().slice(0, 40)}…" is ${v.label.trim().length}`);
          if (!v || typeof v.label !== 'string' || !v.label.trim() || typeof v.file !== 'string' || typeof v.name !== 'string') throw new CommandError('input', 'a value is {"label": "what it is", "file": "the file in your working copy", "name": "the name the value has there"}, with "min", "max" and "step" for a number');
          const file = v.file.replace(/^\.\//, ''), name = v.name.trim();
          if (!editable(file)) throw new CommandError('input', `${v.file} is not a file of your working copy that you may change`);
          const at = standing({ file, name });
          if (!at) throw new CommandError('missing', `there is no file ${file} in your working copy`);
          if (!at.found) throw new CommandError('input', at.times
            ? `${name} is given a value ${at.times} times in ${file}: which one is meant cannot be told. Give the value a name of its own`
            : `${name} is not given a value that is written out in ${file}: it has to stand there as a number, true or false, a text in quotes or a colour, right after the name (${name} = 4, ${name}: 4)`);
          for (const k of ['min', 'max', 'step'] as const) if (v[k] !== undefined && (typeof v[k] !== 'number' || !Number.isFinite(v[k]))) throw new CommandError('input', `${k} is a number`);
          const { min, max, step } = v as { min?: number; max?: number; step?: number };
          if ((min !== undefined || max !== undefined || step !== undefined) && at.found.kind !== 'number') throw new CommandError('input', `${name} is not a number (it is ${JSON.stringify(at.found.value)}), so it has no min, max or step`);
          if (min !== undefined && max !== undefined && min >= max) throw new CommandError('input', `${name}: min is below max`);
          if (step !== undefined && step <= 0) throw new CommandError('input', `${name}: step is more than nothing`);
          const out = unfit(at.found, at.found.value, { min, max });
          if (out) throw new CommandError('input', `${name} is ${at.found.value} now, and ${out}: give it room on both sides`);
          // Exposed before and turned by the person since: what the agent had set is still what it goes back to.
          const earlier = before.find((t) => t.file === file && t.name === name);
          const theirs = earlier?.set !== undefined && earlier.set === at.found.value;
          return { label: v.label.trim(), file, name, ...(min !== undefined && { min }), ...(max !== undefined && { max }), ...(step !== undefined && { step }), was: theirs ? earlier.was : at.found.value, ...(theirs && { set: earlier.set }) };
        });
        const twice = list.find((t, n) => list.findIndex((x) => x.file === t.file && x.name === t.name) !== n);
        if (twice) throw new CommandError('input', `${twice.name} in ${twice.file} is in the list twice`);
        exposed(list);
        if (proposals.list({ status: 'pending', round: CODE }).length) proposeCode(c.by, '');
        if (!list.length) return { exposed: [] };
        return {
          exposed: tweaks().map((t) => ({ label: t.label, name: t.name, file: t.file, is: t.value, as: t.kind === 'number' ? (t.min !== undefined && t.max !== undefined ? 'a slider' : 'a number to fill in') : t.kind === 'boolean' ? 'a switch' : t.kind === 'colour' ? 'a colour to pick' : 'a text to fill in' })),
          says: 'the person finds them on the card of your change set, and what they set is written in your working copy at once; you are told what they turned at their next message. Say in your answer that they are there to turn',
          // (A value is judged on the thing itself: where that is small or hard to get to, the example is where it is turned.)
          ...(copyPage() && !example() && { next: `not done yet: before you answer, make the example these values are judged on. Write ${SCRATCH}/example.html, a page that loads the project's own code from your copy and shows the thing they are about large and by itself, then run code.example with its path. Only when what they change is plain to see, large, the moment the app opens is there none: then say so in your answer` }),
        };
      },
    },
    {
      name: 'code.tweak', kind: 'write',
      about: 'Turn one of the values the agent exposed with its change set (code.expose): the value is written in the working copy, in the file it is in, and the copy\'s page shows it. It is part of the change set from then on, accepted or rejected with it, and the agent is told what was turned. Only the person does this.',
      input: { file: 'string', name: 'string', value: 'json' },
      run(_c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        const p = proposals.list({ status: 'pending', round: CODE }).find((x) => x.kind === 'code');
        const t = exposed().find((x) => x.file === i.file && x.name === i.name);
        if (!p || !t) throw new CommandError('missing', `${i.name} in ${i.file} is not a value of a change set that waits`);
        const at = standing(t);
        if (!at?.found) throw new CommandError('missing', `${t.name} is not written out in ${t.file} any more`);
        const why = unfit(at.found, i.value, t);
        if (why) throw new CommandError('input', `${t.label}: ${why}`);
        const value = i.value as TweakValue;
        if (value === at.found.value) return { value, changed: false };
        writeFileSync(join(code.work, t.file), put(at.source, at.found, value));
        const now = standing(t)?.found?.value ?? value;
        exposed(exposed().map((x) => (x.file === t.file && x.name === t.name ? { ...x, set: now } : x)));
        // The agent hears where it went from what it knew: turned back to that, there is nothing to tell.
        const list = turned();
        const told = list.find((x) => x.file === t.file && x.name === t.name);
        if (told) { told.to = now; told.label = t.label; } else list.push({ label: t.label, file: t.file, name: t.name, from: at.found.value, to: now });
        turned(list.filter((x) => x.from !== x.to));
        // A page that does not follow its own files is loaded anew by the screen that shows it.
        proposeCode(p.by, String(p.after.said ?? ''), { tweaked: { file: t.file, name: t.name }, ...(copyPage() && !preview!.follows() && { anew: true }) });
        return { value: now, changed: true };
      },
    },
    {
      name: 'code.play', kind: 'write',
      about: 'The address of the page of the working copy: the game with what the agent coded, to play before any of it is in the project. Starts that page if it is not running.',
      async run() {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        if (!preview || !copyPage()) throw new CommandError('unsupported', 'the project has no page to play: say how it is started in tandem.json ("page")');
        bringUp();
        try { return { url: await preview.url() }; } catch (e) { throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
      },
    },

    // ---- playtests
    {
      name: 'playtest.run', kind: 'read',
      about: 'Let a bot play the whole game (profile eager or casual) and say when every milestone came, in minutes. With copy, the game as the agent\'s working copy has it. About ten seconds.',
      input: { profile: 'string?', copy: 'boolean?' },
      async run(c, i) {
        const profile = i.profile ?? 'eager';
        if (!game.profiles.includes(profile)) throw new CommandError('input', `profile is one of ${game.profiles.join(', ')}`);
        const spec = { do: 'pacing' as const, profile };
        const pacing = i.copy ? await inCopy<Pacing>(spec) : await job<Pacing>(spec);
        events.add({ type: 'playtest', by: c.by, kind: 'run', profile, copy: !!i.copy, length: pacing.length, minutes: pacing.minutes });
        return { profile, length: pacing.length, minutes: pacing.minutes, took: pacing.took };
      },
    },
    {
      name: 'playtest.compare', kind: 'read',
      about: 'Play the game twice, as it is in the project and as the agent\'s working copy has it, and say which milestones moved, and by how much. Do this before telling the person what a change does to the pacing. About twenty seconds.',
      input: { profile: 'string?' },
      async run(c, i) {
        const profile = i.profile ?? 'eager';
        if (!game.profiles.includes(profile)) throw new CommandError('input', `profile is one of ${game.profiles.join(', ')}`);
        const files = code?.changes() ?? [];
        if (!files.length) throw new CommandError('missing', 'the working copy does not differ from the project, so there is nothing to compare');
        const spec = { do: 'pacing' as const, profile };
        const [a, b] = await Promise.all([job<Pacing>(spec), inCopy<Pacing>(spec)]);
        const out = { profile, changes: files.map((f) => f.path), length: { before: a.length, after: b.length }, moved: compare(a, b) };
        events.add({ type: 'playtest', by: c.by, kind: 'compare', ...out });
        return out;
      },
    },
    {
      name: 'playtest.milestones', kind: 'read',
      about: 'The milestones a playthrough reports, each with a few words: so that the names in a playtest mean something.',
      run: () => game.milestones(),
    },

    // ---- the project's page, used as a person would: asked of the person's own screen, where they see it happen
    {
      name: 'page.look', kind: 'read',
      about: 'What is on the project\'s page on the person\'s screen now, as lines: headings, text, and what can be tapped or filled in. copy: true looks at the page of your working copy instead (false: the project\'s own), and their screen switches to it. Works while tandem is open on their device.',
      input: { copy: 'boolean?' },
      run: (c, i) => onPage(c.by, { do: 'look', ...(i.copy !== undefined && { copy: i.copy }) }),
    },
    {
      name: 'page.tap', kind: 'write', agent: 'free',
      about: 'Tap something on the project\'s page on the person\'s screen: at is the words on it (a button, a link, a checkbox by its label) or a CSS selector. Or x and y: a place in the picture of the page you got while you have the page (page.take), in pixels of that picture; that is how something drawn on a canvas is tapped. They see it happen. Answers with what is on the page afterwards. copy as in page.look.',
      input: { at: 'string?', x: 'number?', y: 'number?', copy: 'boolean?' },
      run(c, i) {
        const place = typeof i.x === 'number' && typeof i.y === 'number';
        if (!place && !i.at?.trim()) throw new CommandError('input', 'page.tap needs at (the words on it, or a selector), or x and y (a place in the picture of the page)');
        return onPage(c.by, { do: 'tap', ...(place ? { x: i.x, y: i.y } : { at: i.at }), ...(i.copy !== undefined && { copy: i.copy }) });
      },
    },
    {
      name: 'page.type', kind: 'write', agent: 'free',
      about: 'Fill in a field on the project\'s page on the person\'s screen: at is what the field is called (its label, or what it shows when empty) or a CSS selector; text is what goes in it (for a list of choices: the choice). submit: true sends the form it is in afterwards, as Enter would. Answers with what is on the page afterwards. copy as in page.look.',
      input: { at: 'string', text: 'string', submit: 'boolean?', copy: 'boolean?' },
      run: (c, i) => onPage(c.by, { do: 'type', at: i.at, text: i.text, submit: !!i.submit, ...(i.copy !== undefined && { copy: i.copy }) }),
    },
    {
      name: 'page.go', kind: 'write', agent: 'free',
      about: 'Go to another place in the project\'s page on the person\'s screen: path starts with / (or ? or #). Answers with what is on the page there. copy as in page.look.',
      input: { path: 'string', copy: 'boolean?' },
      run: (c, i) => onPage(c.by, { do: 'go', path: i.path, ...(i.copy !== undefined && { copy: i.copy }) }),
    },
    {
      name: 'page.request', kind: 'write', agent: 'free',
      about: 'Call the project\'s own server the way another device would: nothing of what the person\'s browser keeps goes along, so it is someone new. path starts with / and is asked at the address the project\'s page is served from (its API, if the page reaches that through the same address). method is GET unless there is a body, then POST; body is text, or JSON to send as JSON; headers is an object. as names a visitor ("bob"): one name keeps its cookies from call to call. copy: true calls the working copy\'s server. Answers with the status and the body.',
      input: { path: 'string', method: 'string?', body: 'json?', headers: 'json?', as: 'string?', copy: 'boolean?' },
      run: (c, i) => request(c.by, i),
    },
    {
      name: 'page.take', kind: 'write', agent: 'free',
      about: 'Ask the person to let you have the project\'s page on their screen for a while, to try what you made yourself instead of leaving it to them: why is what you want to see, in a few words. Waits for their answer (yes, or not now). While you have it, page.look, page.tap, page.type and page.go also give a picture of the page as it is on their screen (picture: a file to Read; size: how large it is), so you see what a canvas draws, and page.tap takes a place in that picture (x, y). They watch, and can take it back. Give it back with page.release when you have seen what you needed; it also ends with your turn.',
      input: { why: 'string' },
      async run(c, i) {
        if (!project.pageCommand(0)) throw new CommandError('unsupported', 'this project has no page set up in tandem (project.configure: page)');
        if (!i.why.trim()) throw new CommandError('input', 'why says what you want to see, in a few words: the person reads it before they answer');
        if (held && held.by === c.by) { hold(c.by); return { taken: true }; }
        const id = `t${Date.now().toString(36)}${++asking}`;
        events.add({ type: 'page.take', by: c.by, id, why: i.why.trim() });
        const allow = await new Promise<boolean | undefined>((resolve) => {
          taking.set(id, resolve);
          setTimeout(() => { if (taking.delete(id)) resolve(undefined); }, 100_000).unref?.();
        });
        if (allow === undefined) {
          events.add({ type: 'page.taken', by: 'engine', id, allow: false });
          throw new CommandError('unavailable', 'the person did not answer: tandem may not be open on their device, or they are away. Go on without the page and say what you have not seen');
        }
        if (!allow) throw new CommandError('refused', 'the person said not now. Go on without the page and say what you have not seen; do not ask again this turn unless they tell you to');
        takenBack = false;
        hold(c.by);
        return { taken: true };
      },
    },
    {
      name: 'page.let', kind: 'write',
      about: 'The person\'s answer to the agent asking for the page (page.take): id is which asking, allow is yes or not now.',
      input: { id: 'string', allow: 'boolean' },
      run(c, i) {
        const waiting = taking.get(i.id);
        if (!waiting) throw new CommandError('missing', 'that was asked too long ago: the agent is no longer waiting for the answer');
        taking.delete(i.id);
        events.add({ type: 'page.taken', by: c.by, id: i.id, allow: i.allow });
        waiting(i.allow);
        return { allow: i.allow };
      },
    },
    {
      name: 'page.release', kind: 'write', agent: 'free',
      about: 'Give the project\'s page back to the person after page.take. From the person: take it back from the agent.',
      run(c) {
        const released = release(c.by);
        if (released && !isAgent(c.by)) takenBack = true;
        return { released };
      },
    },
    {
      name: 'page.answer', kind: 'write',
      about: 'The person\'s screen answering what was asked of the project\'s page (page.look, page.tap, page.type, page.go). Sent by tandem\'s page, not by hand.',
      input: { id: 'string', result: 'json' },
      run(_c, i) {
        const waiting = asked.get(i.id);
        // (Two screens open: the first to answer is the one that is heard.)
        if (!waiting) return { heard: false };
        asked.delete(i.id);
        waiting(i.result as Record<string, unknown>);
        return { heard: true };
      },
    },

    // ---- the stage: the agent shows the person something in the app
    {
      name: 'stage.point', kind: 'write', agent: 'free',
      about: 'Point at something on the person\'s screen with a few words (text): a ring appears there. at is something on the project\'s page: the words on it as the person reads them (a button, a heading, a label), or a CSS selector; the page moves to it. x and y are a place in the world being played (world units), where the project says where things are.',
      input: { at: 'string?', x: 'number?', y: 'number?', text: 'string?' },
      run(c, i) {
        if (!i.at?.trim() && (i.x === undefined || i.y === undefined)) throw new CommandError('input', 'say what to point at: at (words on the page, or a selector), or x and y in the world');
        events.add({ type: 'stage.point', by: c.by, ...(i.at?.trim() ? { at: i.at.trim() } : { x: i.x, y: i.y }), text: i.text ?? '' });
        return { shown: true, says: 'the ring is put on the person\'s screen if their page has it; you are not told whether it was found' };
      },
    },
    {
      name: 'stage.open', kind: 'write', agent: 'free',
      about: 'Open something on the person\'s screen: tab is chat, concepts or art; id is the concept or drawing to open there (for a worker: "worker:<id>" in art).',
      input: { tab: 'string', id: 'string?' },
      run: (c, i) => { events.add({ type: 'stage.open', by: c.by, tab: i.tab, id: i.id ?? '' }); return { shown: true }; },
    },
  ];

  // The game's own commands and the inspector work on the host's worlds; the page has the same ones on its own.
  const guarded = (defs: CommandDef[]): CommandDef[] => defs.map((d) => d.kind !== 'write' || d.name.startsWith('ecs.') ? d : {
    ...d, run: (c, i) => { sandboxOnly(i.room, c.by); return d.run(c, i); },
  });
  const art = createArt({
    project, events, proposals, locks, newLookFile,
    taken: (by) => publish(by),
    // With an agent that codes, a drawing taken into the project is news for it: it is the one who brings it in.
    accepted: code && ((drawings) => {
      const what = drawings.map((d) => `${d.name} (${d.isNew ? 'new' : 'changed'}; ${d.w}×${d.h}; looks: ${d.looks.join(', ')}; animations: ${Object.entries(d.anims).map(([a, n]) => `${a} ×${n}`).join(', ')}${d.depth ? '; with a depth map' : ''})`).join('; ');
      events.add({
        type: 'message', by: 'engine', refs: drawings.map((d) => `drawing:${d.name}`),
        text: `Art was accepted into the project: ${what}. It is in the project's art files and in your working copy, but the project does not use it yet. Bring it in: build the drawings in your working copy (the project's own build for them, or \`tandem export <folder>\` when it has none), make the project use what is new about ${drawings.length === 1 ? 'it' : 'them'}, run the tests, and say in a few words what you did and what is left.`,
      });
    }),
  });
  // What needs the project to be seen inside (its worlds, pictures of it, a bot playing it) is there only when
  // the project offers that.
  const SENSES = /^(world|game|playtest)\./;
  registry.add(
    ...core.filter((c) => hasGame || !SENSES.test(c.name)),
    ...(hasGame ? [...guarded(game.commands(world)), ...ecsCommands(world, game, sandboxOnly)] : []),
    ...art.commands,
  );

  return {
    project, game: hasGame ? game : undefined, registry, events, proposals, concepts, thoughts, locks, art, code, preview, proposeCode, tweaked, onStop,
    turnOver() { release('engine', 'the agent\'s turn is over'); takenBack = false; wantExample(); },
    dirs: { project: project.root, data: dataDir, looks: looksDir, files: filesDir },
    run: (name, input, by, round) => registry.run(name, input, { by, round }),
    world,
  };
}
