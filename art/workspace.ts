// Where drawings are drawn and looked at. The real ones are the game's:
// games/<id>/art/<name>.txt, with depth maps in games/<id>/depth/. A worker
// never touches those: it draws in a workspace of its own, a copy, and what it
// changed there is what it proposes. Looking at a drawing renders it with
// pixeldraw's render script (art/scripts/render.js), which works on the folder
// it is run in, so a look has a workspace too.
//   <work>/<id>/art, depth   the copies; out/ the renders; scratch/ a worker's own analysis scripts
//   <work>/<id>/scripts, src links to the engine's art/scripts and art/src, as the guide names them
//   <work>/<id>/base.json    { [path]: content } of the real files when they were copied
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ART = fileURLToPath(new URL('.', import.meta.url));
const DIRS = ['art', 'depth'] as const;

export type Files = Record<string, string>;
export interface Change { name: string; before: { text?: string; depth?: string }; after: { text?: string; depth?: string } }

export const validName = (name: string) => /^[a-z0-9][a-z0-9-]*$/.test(name);

/** { 'art/x.txt': text, 'depth/x.txt': text } of a folder. */
export function filesIn(root: string): Files {
  const out: Files = {};
  for (const d of DIRS) {
    if (!existsSync(join(root, d))) continue;
    for (const f of readdirSync(join(root, d)).sort()) if (f.endsWith('.txt')) out[`${d}/${f}`] = readFileSync(join(root, d, f), 'utf8');
  }
  return out;
}

export function createWorkspaces(gameDir: string, workDir: string) {
  const dir = (id: string) => join(workDir, id);

  /** A workspace with the game's drawings as they are now. An existing one is left as it is unless `fresh`. */
  function ensure(id: string, fresh = false): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`"${id}" is not a name for a workspace`);
    const root = dir(id);
    if (existsSync(join(root, 'base.json')) && !fresh) return root;
    for (const d of DIRS) rmSync(join(root, d), { recursive: true, force: true });
    for (const d of [...DIRS, 'out', 'scratch']) mkdirSync(join(root, d), { recursive: true });
    for (const [link, to] of [['scripts', join(ART, 'scripts')], ['src', join(ART, 'src')]])
      if (!existsSync(join(root, link))) symlinkSync(to, join(root, link));
    const base = filesIn(gameDir);
    for (const path in base) writeFileSync(join(root, path), base[path]);
    writeFileSync(join(root, 'base.json'), JSON.stringify(base));
    return root;
  }

  /** What a workspace changed, per drawing: its text and its depth map, before and after. */
  function changes(id: string): Change[] {
    const root = dir(id);
    const base = JSON.parse(readFileSync(join(root, 'base.json'), 'utf8')) as Files;
    const now = filesIn(root);
    const names = new Set<string>();
    for (const path of new Set([...Object.keys(base), ...Object.keys(now)])) if (base[path] !== now[path]) names.add(path.slice(path.indexOf('/') + 1, -4));
    return [...names].filter((n) => now[`art/${n}.txt`] !== undefined).map((name) => ({
      name,
      before: { text: base[`art/${name}.txt`], depth: base[`depth/${name}.txt`] },
      after: { text: now[`art/${name}.txt`], depth: now[`depth/${name}.txt`] },
    }));
  }

  /**
   * Render a drawing of a workspace (file is art/<name>.txt or depth/<name>.txt) with pixeldraw's render script.
   * Gives the picture's path. flags: --anim=, --frame=, --recolor=, --crop=, --grid.
   */
  function render(id: string, file: string, flags: string[] = []): Promise<string> {
    const root = dir(id);
    return new Promise((ok, fail) => {
      execFile(process.execPath, ['scripts/render.js', file, ...flags], { cwd: root, timeout: 60_000, env: { ...process.env, PIXEL_WORKER: '' } }, (err, stdout, stderr) => {
        const name = file.slice(file.indexOf('/') + 1, -4);
        const png = join(root, 'out', file.startsWith('depth/') ? 'depth' : '', `${name}.png`);
        if (err || !existsSync(png)) fail(new Error((stderr || stdout || err?.message || 'no picture came out').trim().split('\n').filter((l) => !/^\s+at |^node:|^Node\.js/.test(l)).slice(-2).join(' ')));
        else ok(png);
      });
    });
  }

  /** A workspace for one job (a picture), with a name nobody else has, so two jobs at once do not draw over each other. */
  let n = 0;
  const scratch = () => { const id = `_s${process.pid}-${++n}`; ensure(id, true); return id; };

  return {
    dir, ensure, changes, render, scratch,
    exists: (id: string) => existsSync(join(dir(id), 'base.json')),
    remove: (id: string) => rmSync(dir(id), { recursive: true, force: true }),
    list: () => (existsSync(workDir) ? readdirSync(workDir).filter((id) => existsSync(join(dir(id), 'worker.json'))) : []),
  };
}

export type Workspaces = ReturnType<typeof createWorkspaces>;
