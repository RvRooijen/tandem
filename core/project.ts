// A project: any folder with a git repository in it, usually a web project.
// Tandem is started in one and works on it from outside: it brings nothing
// into the project but a small folder of its own (.tandem: the concepts, the
// locks, what is not kept in git, and how the project is run: a tandem.json
// that says how its page is started and its tests are run, and a script for
// starting the page when that takes more than a line). A project that would
// rather not have tandem in its history ignores that one folder. A
// tandem.json at the project's root is read too, when there is none in
// tandem's folder. Everything in tandem.json is optional. What a project offers decides what
// the agent can do there: with nothing, it talks, keeps concepts and codes in
// a working copy; with a page command, the person plays the project and the
// copy inside tandem; with an adapter, the agent can also see inside the
// running thing (its state, pictures of it, its entities, a bot playing it).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export interface ProjectConfig {
  /** What it is called. The folder's name if not said. */
  name?: string;
  /**
   * How the project's page is started, with {port} where the port goes; {project} is the project's own folder
   * and {tandem} tandem's folder in it (the page of the agent's working copy is started with this same line, in
   * the copy: a script named through {project} or {tandem} is the project's, whatever the copy holds). Guessed
   * for a Vite project.
   */
  page?: string;
  /**
   * The page only takes in changed code when it is started again (it is built: dotnet run, a server without a
   * watcher): after an accept the project's page is started again, and the copy's when the agent changed it.
   */
  rebuild?: boolean;
  /** How its tests are run, and its type check: the agent may run these in its working copy. */
  test?: string;
  check?: string;
  /** More commands the agent may run in its working copy (a build step, a generator). */
  run?: string[];
  /** A module that lets the engine see inside the project: it exports `game`, a GameModule (core/game.ts). */
  adapter?: string;
  /** Drawings: where they are (art, with depth maps in depth), and how they are built into the project. */
  art?: { dir?: string; depth?: string; build?: string };
  /** What the agent may change in its working copy; everything but tandem's own folder and the drawings if not said. */
  edit?: string[];
  /**
   * Whether tandem commits in the project, and whether it pushes: both unless said not to (false). A project
   * that is not committed for gets an accepted change set in its files, uncommitted, and is never pushed.
   */
  commit?: boolean;
  push?: boolean;
}

export interface Project {
  /** The folder. */
  root: string;
  id: string;
  name: string;
  config: ProjectConfig;
  /** Tandem's own folder in the project: concepts and locks are kept in git, data is not. */
  dirs: { tandem: string; concepts: string; data: string; looks: string; art: string; depth: string };
  locksFile: string;
  /** Where how the project is run is written down by tandem, and the script that starts its page when a line is not enough. */
  configFile: string;
  pageScript: string;
  /** The page command, with a port filled in; undefined when the project has no page to show. */
  pageCommand(port: number): string | undefined;
  /** The paths the agent may edit, as patterns relative to the project. */
  editable: string[];
  /** The same project somewhere else (the agent's working copy): its folders there. */
  at(root: string): Project;
}

/**
 * How a project's page is started, when it does not say: for a project with Vite, Vite on the port asked for.
 * Through its own `dev` script when that ends in Vite, because such a script often starts more than Vite (a server
 * beside it) and the page does not work without the rest; what is added lands on the last command, which is Vite.
 */
function guessPage(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (!{ ...pkg.dependencies, ...pkg.devDependencies }.vite) return undefined;
    const flags = '--port {port} --strictPort --host 127.0.0.1';
    return /(^|[;&|]\s*)(npx\s+)?vite(\s[^;&|]*)?$/.test(pkg.scripts?.dev?.trim() ?? '') ? `npm run dev -- ${flags}` : `npx vite ${flags}`;
  } catch { /* no package.json: no guess */ }
  return undefined;
}

/** `tandem` and `data` put tandem's own folder, or only what it does not keep in git, somewhere else (a test's). */
export function loadProject(dir: string, opts: { data?: string; tandem?: string; as?: Project } = {}): Project {
  const root = resolve(dir);
  if (!existsSync(root)) throw new Error(`there is no folder ${root}`);
  // The working copy is run by the project's own settings, not by whatever its copy of tandem.json says: how a
  // project's page and tests are started is the person's to decide, not something a change set can rewrite.
  let config: ProjectConfig = opts.as?.config ?? {};
  const tandem = opts.tandem ?? join(root, '.tandem');
  // In tandem's own folder; a project that keeps it among its own files has it at its root.
  const file = existsSync(join(tandem, 'tandem.json')) ? join(tandem, 'tandem.json') : join(root, 'tandem.json');
  if (!opts.as && existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')) as ProjectConfig; } catch (e) { throw new Error(`tandem.json is not valid JSON: ${e instanceof Error ? e.message : e}`); }
  }
  const data = opts.data ?? join(tandem, 'data');
  const ours = opts.as?.dirs.tandem ?? tandem;
  const home = opts.as?.root ?? root;
  // (Asked each time: how the project is run can be changed while tandem is on it.)
  // A working copy of a project that has no page yet is started by what the copy itself brings (the first change
  // set of a new project is the one that gives it a page): so it can be played before it is accepted.
  const page = () => config.page ?? guessPage(home) ?? (root !== home ? guessPage(root) : undefined);
  const art = config.art?.dir ?? 'art', depth = config.art?.depth ?? 'depth';
  const project: Project = {
    root,
    id: basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project',
    name: config.name ?? basename(home),
    config,
    dirs: { tandem, concepts: join(tandem, 'concepts'), data, looks: join(data, 'looks'), art: join(root, art), depth: join(root, depth) },
    locksFile: join(tandem, 'locks.json'),
    configFile: join(ours, 'tandem.json'),
    pageScript: join(ours, 'page.sh'),
    pageCommand: (port) => page()?.replaceAll('{port}', String(port)).replaceAll('{project}', home).replaceAll('{tandem}', ours),
    editable: config.edit ?? ['**'],
    at: (other) => loadProject(other, { ...opts, as: project }),
  };
  return project;
}

/** How the core ends when how the project is run was changed: whoever looks after it starts it again, and the project's page with it. */
export const SETUP = 77;

/** Where one of a started command's streams goes: ours, nowhere, or a file that is open. */
type Out = 'inherit' | 'ignore' | number;

/**
 * Start a page with a command line, in a process group of its own (see stopTree) that does not outlive this
 * process. A group of its own is not stopped with the terminal, and is only stopped by us when we get to it: closed
 * with its window, killed, or fallen over, tandem left the page running and holding its port. So the group watches
 * for us itself: it is handed the reading end of a pipe that only this process holds the other end of, and when
 * that end is gone, however that came about, everything in the group is stopped.
 */
export function startTree(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv; stdio?: [Out, Out, Out] }): ChildProcess {
  const [stdin, stdout, stderr] = options.stdio ?? ['inherit', 'inherit', 'inherit'];
  return spawn('sh', ['-c', `(cat <&3 >/dev/null; kill -TERM 0) & ${command}`], { cwd: options.cwd, env: options.env, stdio: [stdin, stdout, stderr, 'pipe'], detached: true });
}

/**
 * Stop a page that was started with a command line: the command and everything it started. A page command is a
 * shell line (npx vite …) whose real server is a grandchild; stopping only the first process leaves that one
 * running, holding the port. So such a command is started in a process group of its own (startTree), and stopped
 * as a group.
 */
export function stopTree(child: { pid?: number; kill(): boolean } | undefined) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
}

/** Make tandem's folder in a project, with what is not to be kept in git left out of it. */
export function prepare(project: Project) {
  mkdirSync(project.dirs.concepts, { recursive: true });
  mkdirSync(project.dirs.looks, { recursive: true });
  const ignore = join(project.dirs.tandem, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'data/\n');
}
