// Which project tandem is working on, and choosing another. Tandem is started
// once; the project is picked from the page: a list of the folders that could
// be one (the folders next to tandem itself, and wherever else it is told to
// look), and the one that is open. What was open last is remembered, so
// starting tandem again opens it. Opening a project starts the core again on
// that project (core/start.ts does that, when the core asks for it by ending
// with exit code 76).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, type CommandDef } from './commands.ts';

const ENGINE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Exit code that asks whoever started the core to start it again on the project in the state file. */
export const SWITCH = 76;

export interface State {
  project?: string; roots?: string[];
  /** Where the person last made a project: where choosing a folder starts next time. */
  lastIn?: string;
  /** When each project was last opened, by its folder: what was worked on last is listed first. */
  opened?: Record<string, number>;
  /** The model and effort chosen for the agent and for the workers (core/models.ts). */
  models?: Partial<Record<'agent' | 'workers', { model?: string; effort?: string }>>;
}

const stateFile = () => process.env.TANDEM_STATE ?? join(homedir(), '.tandem', 'state.json');

export function readState(): State {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as State; } catch { return {}; }
}

export function writeState(state: State) {
  mkdirSync(dirname(stateFile()), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n');
}

/** The state with this project as the one to open, opened now. */
export const opening = (dir: string, state: State = readState()): State => ({ ...state, project: dir, opened: { ...state.opened, [dir]: Date.now() } });

/** The person's own home folder. Inside a proot on Android that is the home of Termux, not the home of the guest system. */
export function home(): string {
  const named = process.env.TANDEM_HOME;
  if (named && existsSync(named)) return resolve(named);
  const termux = '/data/data/com.termux/files/home';
  return existsSync(termux) ? termux : homedir();
}

/** Where projects are looked for: what the person added, what TANDEM_PROJECTS names, and the folder tandem itself is in. */
export function roots(current?: string): string[] {
  const named = (process.env.TANDEM_PROJECTS ?? '').split(delimiter).filter(Boolean);
  const all = [...(readState().roots ?? []), ...named, dirname(ENGINE), ...(current ? [dirname(resolve(current))] : [])];
  return [...new Set(all.map((r) => resolve(r)))].filter((r) => existsSync(r));
}

export interface Found {
  dir: string;
  name: string;
  /** A project needs a git repository; a folder without one is listed, and says so. */
  git: boolean;
  /** Whether tandem has been here before (a .tandem folder), and what the project has set up. */
  known: boolean;
  page: boolean;
  adapter: boolean;
  open: boolean;
  /** When it was last opened in tandem, if it ever was. */
  opened?: number;
}

function look(dir: string, current?: string, opened: Record<string, number> = {}): Found {
  let config: { name?: string; page?: string; adapter?: string } = {};
  for (const file of [join(dir, '.tandem', 'tandem.json'), join(dir, 'tandem.json')]) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); break; } catch { /* none, or not JSON: it is still a folder */ }
  }
  let vite = false;
  try { const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); vite = !!{ ...pkg.dependencies, ...pkg.devDependencies }.vite; } catch { /* no package.json */ }
  return {
    dir, name: config.name ?? basename(dir),
    git: existsSync(join(dir, '.git')),
    known: existsSync(join(dir, '.tandem')),
    page: !!config.page || vite,
    adapter: !!config.adapter,
    open: !!current && resolve(current) === dir,
    ...(opened[dir] && { opened: opened[dir] }),
  };
}

/** The folders that could be a project: the open one, then the ones that were opened, the last first, then the ones tandem knows, then by name. */
export function listProjects(current?: string): Found[] {
  const out = new Map<string, Found>();
  const opened = readState().opened ?? {};
  for (const root of roots(current)) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const dir = join(root, n);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (!out.has(dir)) out.set(dir, look(dir, current, opened));
    }
  }
  if (current && !out.has(resolve(current))) out.set(resolve(current), look(resolve(current), current, opened));
  return [...out.values()].sort((a, b) => Number(b.open) - Number(a.open) || (b.opened ?? 0) - (a.opened ?? 0) || Number(b.known) - Number(a.known) || Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));
}

/**
 * A project needs a git repository: it is how the agent's work is kept apart from the person's. A folder that has
 * none gets one, with what is in it as its first commit (and, if it has no .gitignore, one that keeps what is
 * never a project's own out of it).
 */
export function ensureRepo(dir: string): boolean {
  if (existsSync(join(dir, '.git'))) return false;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n.DS_Store\n*.log\n');
  // The person's own name on the commit when git knows it; tandem's otherwise.
  let who: string[] = [];
  try { git('config', 'user.name'); git('config', 'user.email'); } catch { who = ['-c', 'user.name=tandem', '-c', 'user.email=tandem@localhost']; }
  git('add', '-A');
  git(...who, 'commit', '-q', '--allow-empty', '-m', 'The project as tandem found it');
  return true;
}

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export interface ProjectsOptions {
  /** The project that is open, if any. */
  current?: string;
  /** Why the project cannot be left right now (the agent is working), if so. */
  busy?(): string | undefined;
  /** Start the core again on what the state file says. Unset: nothing looks after the core, so it only says so. */
  restart?(): void;
}

export function projectCommands(o: ProjectsOptions): CommandDef[] {
  return [
    {
      name: 'projects.list', kind: 'read',
      about: 'The folders that could be a project (next to tandem, and wherever it was told to look): which is open, which have a git repository (one without gets one when it is opened), which tandem has been in before, and when each was last opened; the one opened last comes first.',
      run: () => ({ open: o.current ? resolve(o.current) : null, roots: roots(o.current), projects: listProjects(o.current) }),
    },
    {
      name: 'projects.open', kind: 'write',
      about: 'Work on another project: tandem starts again on that folder. dir is the folder; if it has no git repository, one is started there with what is in it as its first commit. Only the person does this.',
      input: { dir: 'string' },
      run(_c, i) {
        const dir = resolve(i.dir);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError('missing', `there is no folder ${dir}`);
        const why = o.busy?.();
        if (why) throw new CommandError('busy', why);
        // A folder that is not a repository yet becomes one, with what is in it as its first commit.
        let started = false;
        try { started = ensureRepo(dir); } catch (e) { throw new CommandError('failed', `a git repository could not be started in ${dir}: ${(e instanceof Error ? e.message : String(e)).split('\n').slice(-2).join(' ')}`); }
        writeState(opening(dir));
        // After the answer has gone out.
        if (o.restart) setTimeout(o.restart, 300);
        return { opening: dir, restarting: !!o.restart, ...(started && { started: 'a git repository, with what was there as its first commit' }) };
      },
    },
    {
      name: 'projects.create', kind: 'write',
      about: 'Make a new project: a new folder with a git repository in it, and open it. name is what it is called; in is the folder to make it in, which the person chooses (projects.browse walks the folders). Only the person does this.',
      input: { name: 'string', in: 'string' },
      run(_c, i) {
        const folder = slug(i.name);
        if (!folder) throw new CommandError('input', 'give it a name with letters or digits in it');
        const root = resolve(i.in);
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new CommandError('missing', `there is no folder ${root} to make it in`);
        const dir = join(root, folder);
        if (existsSync(dir)) throw new CommandError('exists', `there already is a ${folder} in ${root}; open that one, or pick another name`);
        const why = o.busy?.();
        if (why) throw new CommandError('busy', why);
        mkdirSync(dir);
        writeFileSync(join(dir, 'README.md'), `# ${i.name.trim()}\n`);
        // What tandem knows of it is kept in tandem's own folder, not among the project's files.
        mkdirSync(join(dir, '.tandem'), { recursive: true });
        writeFileSync(join(dir, '.tandem', 'tandem.json'), JSON.stringify({ name: i.name.trim() }, null, 2) + '\n');
        try { ensureRepo(dir); } catch (e) { throw new CommandError('failed', `a git repository could not be started in ${dir}: ${(e instanceof Error ? e.message : String(e)).split('\n').slice(-2).join(' ')}`); }
        writeState({ ...opening(dir), lastIn: root });
        if (o.restart) setTimeout(o.restart, 300);
        return { opening: dir, restarting: !!o.restart };
      },
    },
    {
      name: 'projects.browse', kind: 'read',
      about: 'Walk the folders of this machine, to choose where a new project goes: the folders inside dir, the one above it, and whether dir is a git repository itself. Without dir, it starts where a project was last made, or in the home folder (on Android: the home of Termux).',
      input: { dir: 'string?' },
      run(_c, i) {
        const last = readState().lastIn;
        const dir = resolve(i.dir ?? (last && existsSync(last) ? last : home()));
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError('missing', `there is no folder ${dir}`);
        let names: string[] = [];
        try { names = readdirSync(dir); } catch { throw new CommandError('permission', `${dir} cannot be looked into`); }
        const folders = names.filter((n) => !n.startsWith('.') && n !== 'node_modules' && (() => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } })()).sort((a, b) => a.localeCompare(b));
        return { dir, parent: dirname(dir) === dir ? null : dirname(dir), folders, home: home(), git: existsSync(join(dir, '.git')) };
      },
    },
    {
      name: 'projects.look', kind: 'write',
      about: 'Look for projects in another folder too: its subfolders are listed from now on. Only the person does this.',
      input: { dir: 'string' },
      run(_c, i) {
        const dir = resolve(i.dir);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError('missing', `there is no folder ${dir}`);
        const state = readState();
        writeState({ ...state, roots: [...new Set([...(state.roots ?? []), dir])] });
        return { roots: roots(o.current) };
      },
    },
  ];
}

/**
 * A project tandem has not been in before gets a first line in its chat: for one that has things in it already, the
 * offer to read it and set tandem up for it; for an empty one, where to begin. Said once, when nothing has been
 * said or written down there yet.
 */
export function welcome(host: { events: { last(): number; add(ev: { type: string; by: string; [k: string]: unknown }): unknown }; concepts: { list(): unknown[] }; project: { root: string; name: string } }): boolean {
  if (host.events.last() > 0 || host.concepts.list().length) return false;
  let files: string[] = [];
  try { files = execFileSync('git', ['ls-files'], { cwd: host.project.root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* not a repository: nothing to count */ }
  const own = files.filter((f) => !/^(README\.md|\.gitignore|tandem\.json|\.tandem\/)/.test(f));
  host.events.add({ type: 'welcome', by: 'engine', existing: own.length > 0, files: own.length, name: host.project.name });
  return true;
}
