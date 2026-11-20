// Projects for the tests. Tandem works on a project from outside, so a test
// needs one: `fixture()` is a small project made fresh in a temporary folder
// (a git repository with a few drawings, a tandem.json, no page and nothing
// to see inside). Nothing is ever written in a real project.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost, type Host } from '../core/host.ts';

export const AGENT = 'agent:main';

// Which project was open last is remembered in a file in the person's home; a test has its own.
process.env.TANDEM_STATE ??= join(tmpdir(), `tandem-state-${process.pid}.json`);
// Git for Windows checks files out with CRLF; the tests write LF and read back what they wrote.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
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
