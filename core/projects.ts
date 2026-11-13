// Which project tandem is working on, and choosing another. Tandem is started
// once; the project is picked from the page: a list of the folders that could
// be one (the folders next to tandem itself, and wherever else it is told to
// look), and the one that is open. What was open last is remembered, so
// starting tandem again opens it. Opening a project starts the core again on
// that project (core/start.ts does that, when the core asks for it by ending
// with exit code 76).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, type CommandDef } from './commands.ts';

const ENGINE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Exit code that asks whoever started the core to start it again on the project in the state file. */
export const SWITCH = 76;

export interface State { project?: string; roots?: string[] }

const stateFile = () => process.env.TANDEM_STATE ?? join(homedir(), '.tandem', 'state.json');

export function readState(): State {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as State; } catch { return {}; }
}

export function writeState(state: State) {
  mkdirSync(dirname(stateFile()), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n');
}

/** Where projects are looked for: what the person added, what TANDEM_PROJECTS names, and the folder tandem itself is in. */
export function roots(current?: string): string[] {
  const named = (process.env.TANDEM_PROJECTS ?? '').split(':').filter(Boolean);
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
}

function look(dir: string, current?: string): Found {
  let config: { name?: string; page?: string; adapter?: string } = {};
  try { config = JSON.parse(readFileSync(join(dir, 'tandem.json'), 'utf8')); } catch { /* none, or not JSON: it is still a folder */ }
  let vite = false;
  try { const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); vite = !!{ ...pkg.dependencies, ...pkg.devDependencies }.vite; } catch { /* no package.json */ }
  return {
    dir, name: config.name ?? basename(dir),
    git: existsSync(join(dir, '.git')),
    known: existsSync(join(dir, '.tandem')),
    page: !!config.page || vite,
    adapter: !!config.adapter,
    open: !!current && resolve(current) === dir,
  };
}

/** The folders that could be a project: the ones tandem knows first, then by name. */
export function listProjects(current?: string): Found[] {
  const out = new Map<string, Found>();
  for (const root of roots(current)) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const dir = join(root, n);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (!out.has(dir)) out.set(dir, look(dir, current));
    }
  }
  if (current && !out.has(resolve(current))) out.set(resolve(current), look(resolve(current), current));
  return [...out.values()].sort((a, b) => Number(b.open) - Number(a.open) || Number(b.known) - Number(a.known) || Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));
}

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
      about: 'The folders that could be a project (next to tandem, and wherever it was told to look): which is open, which have a git repository, which tandem has been in before.',
      run: () => ({ open: o.current ? resolve(o.current) : null, roots: roots(o.current), projects: listProjects(o.current) }),
    },
    {
      name: 'projects.open', kind: 'write',
      about: 'Work on another project: tandem starts again on that folder. dir is the folder. Only the person does this.',
      input: { dir: 'string' },
      run(_c, i) {
        const dir = resolve(i.dir);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError('missing', `there is no folder ${dir}`);
        if (!existsSync(join(dir, '.git'))) throw new CommandError('input', `${dir} is not a git repository. Tandem keeps the agent's work apart from yours with git; run \`git init\` there (and commit what is there) first`);
        const why = o.busy?.();
        if (why) throw new CommandError('busy', why);
        writeState({ ...readState(), project: dir });
        // After the answer has gone out.
        if (o.restart) setTimeout(o.restart, 300);
        return { opening: dir, restarting: !!o.restart };
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
