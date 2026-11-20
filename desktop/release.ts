// A release of tandem for the installer (desktop/install.ps1): the files of the commit that is checked out, as
// tandem.zip on a GitHub release named after the version in package.json. What is not committed is not in it,
// and the commit has to be on GitHub already, for the release to point at it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const tag = `v${version}`;
if (run('git', 'status', '--porcelain')) throw new Error('there are changes that are not committed; commit them first, or they are not in the release');
const head = run('git', 'rev-parse', 'HEAD');
run('git', 'fetch', '-q', 'origin');
if (!run('git', 'branch', '-r', '--contains', head)) throw new Error(`${head.slice(0, 7)} is not on GitHub yet; push it first`);

const dir = mkdtempSync(join(tmpdir(), 'tandem-release-'));
try {
  const zip = join(dir, 'tandem.zip');
  run('git', 'archive', '--format=zip', '-o', zip, 'HEAD');
  run('gh', 'release', 'create', tag, zip, '--target', head, '--title', `tandem ${version}`,
    '--notes', 'Install or update on Windows: download desktop/install.ps1 and run it with PowerShell.');
  console.log(`released ${tag} (${head.slice(0, 7)})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
