// The host: one project, its stores, its worlds and every command, in one
// place. The server puts HTTP around it; the tests use it as it is. Nothing
// here knows about pages or agents beyond who is asking (`by`).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCode, type Code, type FileChange } from './code.ts';
import { CommandError, createRegistry, isAgent, type By, type CommandDef, type Registry } from './commands.ts';
import { STAGES, createConcepts, type Concept, type Concepts } from './concepts.ts';
import { createEventLog, type EventLog } from './events.ts';
import type { GameModule, World } from './game.ts';
import { runJob, type JobSpec } from './jobs.ts';
import { createLocks, type Locks } from './locks.ts';
import { createPreview, type Preview } from './preview.ts';
import { encodePng } from './png.ts';
import { SETUP, loadProject, prepare, type Project } from './project.ts';
import { createProposals, type Proposals, type RecordValue } from './proposals.ts';
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
  locks: Locks;
  art: Art;
  /** The agent's working copy of the project, when there is a repository to make one in. */
  code?: Code;
  /** The page of the working copy, for playing it. */
  preview?: Preview;
  /** After the agent worked: what its copy differs from the project becomes (or stops being) a proposal. */
  proposeCode(by: By, note: string): void;
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
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function createHost(opts: HostOptions = {}): Promise<Host> {
  const project = loadProject(opts.project ?? process.env.TANDEM_PROJECT ?? process.cwd(), { data: opts.dataDir, tandem: opts.tandemDir });
  prepare(project);
  const dataDir = project.dirs.data, looksDir = project.dirs.looks;

  // What the project offers to be seen inside by. Without it the engine still talks, keeps concepts and codes;
  // the commands that need it are simply not there.
  const adapter = project.config.adapter;
  const hasGame = !!adapter && existsSync(join(project.root, adapter));
  const game = (hasGame ? (await import(join(project.root, adapter!))).game : undefined) as GameModule;
  if (hasGame && !game) throw new Error(`${adapter} does not export \`game\``);

  const registry = createRegistry();
  const events = createEventLog(join(dataDir, 'events.jsonl'));
  const proposals = createProposals(join(dataDir, 'proposals'));
  const concepts = createConcepts(project.dirs.concepts);
  const locks = createLocks(project.locksFile);
  const onStop: (() => void)[] = [];

  // Working files and project files: the agent codes in a copy of its own (code.ts), when the project is in a
  // repository. What the engine itself writes in the project (concepts, locks, accepted drawings) is committed by
  // it, so the copy can take it in; the person's own uncommitted work is theirs and is left alone.
  const candidate = opts.code === undefined && process.env.TANDEM_CODE !== 'off'
    ? createCode({ root: project.root, paths: ['.tandem/concepts', '.tandem/locks.json', '.tandem/.gitignore', '.tandem/tandem.json', '.tandem/page.sh', 'art', 'depth'] }) : undefined;
  const code = opts.code ?? (candidate?.usable() ? candidate : undefined);
  const preview = code && project.pageCommand(0) ? createPreview(() => project.at(code.work)) : undefined;
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

  /** Start the core again, when something looks after it that will (core/start.ts): its game code is from when it started. */
  function restart(code = 75) {
    if (!process.env.TANDEM_SUPERVISED) return;
    setTimeout(() => { for (const stop of onStop) stop(); process.exit(code); }, 600).unref?.();
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

  function proposeCode(by: By, said: string) {
    if (!code) return;
    const files = code.changes();
    const open = proposals.list({ status: 'pending', round: CODE });
    // What it said the change is (code.describe). Its answer is not repeated on the card: it is in the chat, right above.
    const note = about();
    if (!files.length) {
      about('');
      // The copy is the project again: whatever was proposed is no more.
      if (open.length) { proposals.decide(CODE, 'rejected'); events.add({ type: 'proposal.decided', by, round: CODE, status: 'rejected', count: open.length, paths: ['code:working copy'] }); }
      return;
    }
    // (The first line of its answer is kept for the commit, for when it did not say what the change is.)
    const after = { files: files as never, said: said.split('\n')[0].slice(0, 120) };
    const p = proposals.add({ round: CODE, by, kind: 'code', path: 'working copy', after, note });
    // The whole list every time: a file the agent put back is not part of the change any more.
    p.after = after;
    events.add({ type: 'proposal', by, round: CODE, id: p.id, kind: 'code', path: 'working copy', files, note });
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

  function conceptBrief(c: Concept) {
    return { id: c.id, name: c.name, stage: c.stage, locked: locks.has(`concept:${c.id}`), summary: c.text.split('\n').find((l) => l.trim())?.slice(0, 140) ?? '', links: c.links, realised: c.realised };
  }

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
      about: 'Say something in the conversation. refs is a list of things it is about: "concept:<id>", "drawing:<name>", "entity:<id>", "point:<x>,<y>", "page:<json>" (something on the project\'s page: {words, tag, selector, path}). files is a list of what chat.attach gave back: photos and files that go with it.',
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
              taken = code.accept(p.note.split('\n')[0].slice(0, 120) || String(p.after.said ?? '') || 'Accepted from the working copy');
            }
            catch (e) { throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
          }
          await art.accepting(pending);
        } else if (code && pending.some((p) => p.kind === 'code')) code.reject();
        if (pending.some((p) => p.kind === 'code')) about('');
        const set = proposals.decide(i.round, i.accept ? 'accepted' : 'rejected', only);
        if (i.accept) {
          for (const p of set) {
            if (p.kind === 'concept') {
              const now = concepts.get(p.path);
              concepts.save({ id: p.path, name: p.path, stage: 'idea', links: [], realised: [], text: '', ...now, ...(p.after as Partial<Concept>) });
            }
            if (p.kind === 'setup') writeSetup(p.after);
          }
        }
        // What was not named is still waiting: the round is over when nothing of it is.
        const left = open.length - set.length;
        if (!left) art.decided(i.round);
        const setup = i.accept && set.some((p) => p.kind === 'setup');
        if (setup) events.add({ type: 'setup.changed', by: c.by, fields: set.filter((p) => p.kind === 'setup').flatMap((p) => Object.keys(p.after)), restarting: !!process.env.TANDEM_SUPERVISED });
        if (taken.length) events.add({ type: 'code.changed', by: c.by, files: taken.map((f) => f.path) });
        // The core has the project's code in it as it was when it started: it starts again with the new code. When
        // how the project is run was changed, the project's page is started again too.
        if (setup) restart(SETUP); else if (taken.length) restart();
        events.add({ type: 'proposal.decided', by: c.by, round: i.round, status: i.accept ? 'accepted' : 'rejected', count: set.length, ids: set.map((p) => p.id), left, paths: set.map((p) => `${p.kind}:${p.path}`) });
        return { decided: set.length, left };
      },
    },

    // ---- concepts: the layer the person works in
    {
      name: 'concepts.list', kind: 'read',
      about: 'Every concept: its name, its stage (idea, design, build, playtest), whether it is locked, and its first line.',
      run: () => concepts.list().map(conceptBrief),
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
      about: 'A new concept: a name and a description in plain words, and if known its stage, its links ([{to, kind}], kind is part-of, leads-to or clashes-with; to may be a concept proposed in the same round) and what makes it real (realised: paths, drawings, tests). It starts as an idea unless said otherwise. The agent\'s becomes a proposal.',
      input: { name: 'string', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?' },
      run(c, i) {
        const cid = concepts.slug(i.name);
        if (concepts.get(cid)) throw new CommandError('exists', `there already is a concept ${cid}`);
        for (const k of ['links', 'realised'] as const) checkList(i[k], k);
        const stage = STAGES.includes(i.stage) ? i.stage : 'idea';
        const fresh: Concept = { id: cid, name: i.name, stage, links: i.links ?? [], realised: i.realised ?? [], text: i.text ?? '' };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          const { id: _id, ...after } = fresh;
          const p = proposals.add({ round, by: c.by, kind: 'concept', path: cid, after: after as unknown as RecordValue, note: 'a new concept' });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'concept', path: cid, after: p.after, note: p.note });
          return { proposed: p.id, id: cid, round };
        }
        concepts.save(fresh);
        events.add({ type: 'concept.changed', by: c.by, id: cid, what: 'created' });
        return { id: cid };
      },
    },
    {
      name: 'concepts.update', kind: 'write', agent: 'proposes',
      about: 'Change a concept: its name, text, stage (idea, design, build, playtest), links ([{to, kind}], kind is part-of, leads-to or clashes-with), realised (record paths, drawings, tests). The agent\'s becomes a proposal.',
      input: { id: 'string', name: 'string?', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?', note: 'string?' },
      run(c, i) {
        if (i.stage !== undefined && !STAGES.includes(i.stage)) throw new CommandError('input', `stage is one of ${STAGES.join(', ')}`);
        // A concept that is itself still a proposal is worked on further as that proposal: its links and what makes it
        // real do not have to wait until the person has accepted it.
        const coming = concepts.get(i.id) ? undefined : proposals.list({ status: 'pending' }).find((p) => p.kind === 'concept' && p.path === i.id && !p.before);
        if (coming && isAgent(c.by)) {
          for (const k of ['links', 'realised'] as const) checkList(i[k], k);
          const more: Record<string, unknown> = {};
          for (const k of ['name', 'text', 'stage', 'links', 'realised'] as const) if (i[k] !== undefined && !same(i[k], coming.after[k])) more[k] = i[k];
          if (!Object.keys(more).length) return { changed: false };
          const p = proposals.add({ round: coming.round, by: c.by, kind: 'concept', path: i.id, after: more as RecordValue, note: coming.note });
          events.add({ type: 'proposal', by: c.by, round: p.round, id: p.id, kind: 'concept', path: i.id, after: p.after, note: p.note });
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
          const p = proposals.add({ round, by: c.by, kind: 'concept', path: i.id, before: before as RecordValue, after: after as RecordValue, note: i.note ?? '' });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'concept', path: i.id, before: p.before, after: p.after, note: p.note, touches: [{ id: now.id, name: now.name, stage: now.stage }] });
          return { proposed: p.id, round };
        }
        concepts.save({ ...now, ...(after as Partial<Concept>) });
        events.add({ type: 'concept.changed', by: c.by, id: i.id, what: 'updated', fields: Object.keys(after) });
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
      about: 'Say what the working copy\'s change set does, for the person: a sentence or two in plain words about what is different when the project is used, not which files or how. It is what the proposal says, and its first line is the commit when it is accepted. Say it again when the change set becomes something else.',
      input: { text: 'string' },
      run(c, i) {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        if (!i.text.trim()) throw new CommandError('input', 'say what the change does');
        about(i.text);
        // Said by hand while a proposal is open, the card says it at once; the agent's is shown when its reply is done.
        if (proposals.list({ status: 'pending', round: CODE }).length) proposeCode(c.by, i.text);
        return { said: i.text.trim() };
      },
    },
    {
      name: 'code.play', kind: 'write',
      about: 'The address of the page of the working copy: the game with what the agent coded, to play before any of it is in the project. Starts that page if it is not running.',
      async run() {
        if (!code) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
        if (!preview) throw new CommandError('unsupported', 'the project has no page to play: say how it is started in tandem.json ("page")');
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
    // With an agent that codes, a drawing taken into the project is news for it: it is the one who brings it in.
    accepted: code && ((drawings) => {
      const what = drawings.map((d) => `${d.name} (${d.isNew ? 'new' : 'changed'}; ${d.w}×${d.h}; looks: ${d.looks.join(', ')}; animations: ${Object.entries(d.anims).map(([a, n]) => `${a} ×${n}`).join(', ')}${d.depth ? '; with a depth map' : ''})`).join('; ');
      events.add({
        type: 'message', by: 'engine', refs: drawings.map((d) => `drawing:${d.name}`),
        text: `Art was accepted into the project: ${what}. It is in the project's art files and in your working copy, but the project does not use it yet. Bring it in: build the drawings in your working copy if the project has a build for them, make the project use what is new about ${drawings.length === 1 ? 'it' : 'them'}, run the tests, and say in a few words what you did and what is left.`,
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
    project, game: hasGame ? game : undefined, registry, events, proposals, concepts, locks, art, code, preview, proposeCode, onStop,
    dirs: { project: project.root, data: dataDir, looks: looksDir, files: filesDir },
    run: (name, input, by, round) => registry.run(name, input, { by, round }),
    world,
  };
}
