// Usage: node scripts/scratch.js <scratch/file.mjs> [args...]
// Runs a worker's own analysis script from its scratch/ folder (finding stray pixels, comparing frames)
// under Node's permission model: it may read the workspace (art/, depth/, out/ with the grid files) and the
// parser (src/), and write only in scratch/. It can't change a drawing, start programs or read elsewhere.
import { spawnSync } from 'node:child_process';
import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const [file, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const scratch = resolve(cwd, 'scratch');
mkdirSync(scratch, { recursive: true });
const script = file && resolve(cwd, file);
if (!script || relative(scratch, script).startsWith('..') || !existsSync(script)) {
  console.error('Usage: node scripts/scratch.js scratch/<file.mjs> [args...]  (the script must be in scratch/)');
  process.exit(1);
}
const src = realpathSync(resolve(cwd, 'src'));
const { status } = spawnSync(
  process.execPath,
  ['--permission', `--allow-fs-read=${cwd}`, `--allow-fs-read=${src}`, `--allow-fs-write=${scratch}`, script, ...args],
  { cwd, stdio: 'inherit' }
);
process.exit(status ?? 1);
