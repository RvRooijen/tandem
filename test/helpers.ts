// Projects for the tests. Tandem works on a project from outside, so a test
// needs one: `fixture()` is a small project made fresh in a temporary folder
// (a git repository with a few drawings, a tandem.json, no page and nothing
// to see inside); `game()` is Gnome Garden, the project next to tandem that
// offers everything, used read-only with tandem's own folder for it somewhere
// temporary. Nothing is ever written in a real project.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCode, type Code } from '../core/code.ts';
import { createHost, type Host } from '../core/host.ts';

export const AGENT = 'agent:main';

// Which project was open last is remembered in a file in the person's home; a test has its own.
process.env.TANDEM_STATE ??= join(tmpdir(), `tandem-state-${process.pid}.json`);
const FIXTURE = fileURLToPath(new URL('./fixture', import.meta.url));

/** A fresh copy of the fixture project, as a git repository. `code: false` for a host without a working copy. */
export async function fixture(opts: { code?: boolean; page?: boolean } = {}): Promise<{ host: Host; dir: string; cleanup(): void }> {
  const base = mkdtempSync(join(tmpdir(), 'tandem-fx-'));
  const dir = join(base, 'fixture');
  cpSync(FIXTURE, dir, { recursive: true });
  // A project with a page says how it is started; nothing here starts it, the address is all the shell needs.
  if (opts.page) writeFileSync(join(dir, 'tandem.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'tandem.json'), 'utf8')), page: 'npx serve -l {port}' }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'the fixture');
  const host = await createHost({ project: dir, ...(opts.code === false && { code: null }) });
  return { host, dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Where Gnome Garden is: the project next to tandem, or wherever TANDEM_TEST_GAME says. */
export const GAME = process.env.TANDEM_TEST_GAME ?? fileURLToPath(new URL('../../incremental', import.meta.url));
export const hasGame = existsSync(join(GAME, 'tandem.adapter.ts'));

/**
 * A host on Gnome Garden, without writing in it: what tandem keeps goes to a temporary folder, and the working
 * copy is a worktree there too, on a branch of its own that is taken away again.
 */
export async function game(): Promise<{ host: Host; dir: string; code: Code; cleanup(): void }> {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-gm-'));
  const branch = `tandem-test-${process.pid}`;
  const code = createCode({ root: GAME, work: join(dir, 'copy'), branch, paths: [] });
  const host = await createHost({ project: GAME, dataDir: join(dir, 'data'), tandemDir: join(dir, 'tandem'), code });
  const git = (...args: string[]) => { try { execFileSync('git', args, { cwd: GAME, stdio: 'ignore' }); } catch { /* it was never made */ } };
  return { host, dir, code, cleanup: () => { git('worktree', 'remove', '--force', join(dir, 'copy')); git('branch', '-D', branch); rmSync(dir, { recursive: true, force: true }); } };
}
