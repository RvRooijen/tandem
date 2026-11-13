// A project: any folder with a git repository in it, usually a web project.
// Tandem is started in one and works on it from outside: it brings nothing
// into the project but a small folder of its own (.tandem: the concepts, the
// locks, and what is not kept in git) and, if the project wants one, a
// tandem.json that says how its page is started and its tests are run.
// Everything in tandem.json is optional. What a project offers decides what
// the agent can do there: with nothing, it talks, keeps concepts and codes in
// a working copy; with a page command, the person plays the project and the
// copy inside tandem; with an adapter, the agent can also see inside the
// running thing (its state, pictures of it, its entities, a bot playing it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export interface ProjectConfig {
  /** What it is called. The folder's name if not said. */
  name?: string;
  /** How the project's page is started, with {port} where the port goes. Guessed for a Vite project. */
  page?: string;
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
export function loadProject(dir: string, opts: { data?: string; tandem?: string } = {}): Project {
  const root = resolve(dir);
  if (!existsSync(root)) throw new Error(`there is no folder ${root}`);
  let config: ProjectConfig = {};
  const file = join(root, 'tandem.json');
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')) as ProjectConfig; } catch (e) { throw new Error(`tandem.json is not valid JSON: ${e instanceof Error ? e.message : e}`); }
  }
  const tandem = opts.tandem ?? join(root, '.tandem');
  const data = opts.data ?? join(tandem, 'data');
  const page = config.page ?? guessPage(root);
  const art = config.art?.dir ?? 'art', depth = config.art?.depth ?? 'depth';
  const project: Project = {
    root,
    id: basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project',
    name: config.name ?? basename(root),
    config,
    dirs: { tandem, concepts: join(tandem, 'concepts'), data, looks: join(data, 'looks'), art: join(root, art), depth: join(root, depth) },
    locksFile: join(tandem, 'locks.json'),
    pageCommand: (port) => page?.replaceAll('{port}', String(port)),
    editable: config.edit ?? ['**'],
    at: (other) => loadProject(other, opts),
  };
  return project;
}

/**
 * Stop a page that was started with a command line: the command and everything it started. A page command is a
 * shell line (npx vite …) whose real server is a grandchild; stopping only the first process leaves that one
 * running, holding the port. So such a command is started in a process group of its own (spawn with
 * `detached: true`), and stopped as a group.
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
