// The agent codes in a working copy, and what it changed there is a proposal.
// The copy is a real git worktree of this repository, in a temporary folder and
// on a branch of its own, taken away again afterwards; nothing of the project
// is committed or changed (the project side of it is tested in code.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCode } from '../core/code.ts';
import { ROOT, createHost } from '../core/host.ts';
import { startServer } from '../core/server.ts';

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tandem-wt-'));
const branch = `work/test-${process.pid}`;
// A game path nothing is ever in: the project's own changes are not this test's to commit.
const code = createCode({ root: ROOT, work: join(dir, 'copy'), branch, gamePath: 'games/gnome-garden/.nothing' });
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = git('rev-parse', 'HEAD'), dirty = git('status', '--porcelain');

const host = await createHost({ game: 'gnome-garden', gameDir: join(dir, 'game'), dataDir: join(dir, 'data'), code });
const s = await startServer({ port: 0, host });
process.env.TANDEM_PORT = String(s.port);
after(async () => {
  await s.close();
  try { git('worktree', 'remove', '--force', join(dir, 'copy')); } catch { /* it was never made */ }
  try { git('branch', '-D', branch); } catch { /* nor its branch */ }
  rmSync(dir, { recursive: true, force: true });
});

const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
async function until(what: () => unknown, says: string, ms = 60000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for ${says}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const idle = () => until(() => !s.runner!.status().busy, 'the agent to be done');
const answers = () => host.events.since(0).filter((e) => e.type === 'message' && e.by === 'agent');

test('asked to code, the agent works in its copy, and what the copy changed is a proposal', async () => {
  await me('chat.send', { text: 'code: give the garden seasons' });
  await until(() => answers().length === 1, 'the answer');
  await idle();
  assert.match(String(answers()[0].text), /Seasons added\. In the copy: true\. May edit: true; content: false\. Note: none\./,
    'it stood in its working copy, could change the game\'s code, and not its content');
  assert.ok(existsSync(join(dir, 'copy/games/gnome-garden/src/sim/seasons.ts')));
  assert.ok(!existsSync(join(ROOT, 'games/gnome-garden/src/sim/seasons.ts')), 'the project does not have it');

  const p = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.deepEqual([p.kind, p.round, p.by], ['code', 'code', 'agent:main']);
  assert.deepEqual(p.files, [{ path: 'games/gnome-garden/src/sim/seasons.ts', added: 1, removed: 0, status: 'new' }]);
  assert.match(String(p.note), /Seasons added/);
  assert.deepEqual((await me('code.changes')).files, p.files);
  assert.match((await me('code.changes', { path: 'games/gnome-garden/src/sim/seasons.ts' })).diff, /\+export const SEASONS = 4;/);
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1);
});

test('when the copy is the project again, the proposal is gone; rejected, the copy is put back', async () => {
  await me('chat.send', { text: 'code: undo that' });
  await until(() => answers().length === 2, 'the answer');
  await idle();
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0, 'nothing differs, so nothing is proposed');
  assert.equal(host.events.since(0).at(-1)!.type, 'proposal.decided');

  await me('chat.send', { text: 'code: seasons after all' });
  await until(() => answers().length === 3, 'the answer');
  await idle();
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1);
  await me('proposals.decide', { round: 'code', accept: false });
  assert.ok(!existsSync(join(dir, 'copy/games/gnome-garden/src/sim/seasons.ts')), 'rejected: its copy is the project again');
  assert.deepEqual((await me('code.changes')).files, []);
});

test('the engine tells the agent when art was accepted, and the project was never touched', async () => {
  const tiny = 'k = #1a1c2c\n\n@size 8 8\n@rect 1 1 6 6 k\n';
  await host.run('art.set', { name: 'garden-sign', text: tiny }, 'agent:main', 'r90');
  const before = answers().length;
  await me('proposals.decide', { round: 'r90', accept: true });
  const told = host.events.since(0).filter((e) => e.type === 'message' && e.by === 'engine').at(-1)!;
  assert.match(String(told.text), /Art was accepted into the project: garden-sign \(new; 8×8; looks: default; animations: main ×1\)\. .* Bring it in/);
  assert.deepEqual(told.refs, ['drawing:garden-sign']);
  assert.equal(host.events.since(0).filter((e) => e.type === 'art.changed').at(-1)!.built, false, 'accepting it did not build it into the game');
  assert.ok(!existsSync(join(dir, 'data/art.gen.ts')));
  // And the agent is set to work by it, without the person saying anything.
  await until(() => answers().length === before + 1, 'the agent to answer the engine');
  await idle();

  assert.equal(git('rev-parse', 'HEAD'), head, 'no commit was made in the project');
  assert.equal(git('status', '--porcelain'), dirty, 'and none of its files changed');
});
