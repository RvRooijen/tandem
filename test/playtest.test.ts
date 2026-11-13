// The sense of time, and the agent's eyes on its own work: a bot plays the
// whole game in a process of its own, in the project or in the agent's working
// copy, and says when things happened; a look draws either. The working copy
// is a real git worktree of this repository in a temporary folder, taken away
// afterwards. These play a few whole games, so they take a while.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCode } from '../core/code.ts';
import { CommandError } from '../core/commands.ts';
import { ROOT, createHost } from '../core/host.ts';
import { compare, type Pacing } from '../playtest/pacing.ts';
import { AGENT } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'tandem-pt-'));
const branch = `work/test-pt-${process.pid}`;
// A game path nothing is ever in: the project's own changes are not this test's to commit.
const code = createCode({ root: ROOT, work: join(dir, 'copy'), branch, gamePath: 'games/gnome-garden/.nothing' });
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const host = await createHost({ game: 'gnome-garden', gameDir: join(dir, 'game'), dataDir: join(dir, 'data'), code });
after(() => {
  try { git('worktree', 'remove', '--force', join(dir, 'copy')); } catch { /* it was never made */ }
  try { git('branch', '-D', branch); } catch { /* nor its branch */ }
  rmSync(dir, { recursive: true, force: true });
});
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;
const CONTENT = join(dir, 'copy/games/gnome-garden/src/sim/content.ts');

test('two runs side by side say what moved', () => {
  const a: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.2, shovel: 14, awake: 66, old: 400 }, length: 600, later: [], took: 1 };
  const b: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.3, shovel: 9, awake: 66.2, hat: 300 }, length: 500, later: [], took: 1 };
  assert.deepEqual(compare(a, b), [
    { milestone: 'shovel', before: 14, after: 9, change: -35.7 },
    { milestone: 'hat', before: undefined, after: 300 },
    { milestone: 'old', before: 400, after: undefined },
  ]);
});

test('a playtest plays the whole game and says when things happened, without judging it', async () => {
  await assert.rejects(me('playtest.run', { profile: 'reckless' }), (e) => e instanceof CommandError && e.code === 'input');
  const run = await me('playtest.run');
  assert.ok(run.length > 7 * 60 && run.length < 14 * 60, `the whole game takes ${run.length} minutes`);
  assert.ok(run.minutes.gerald < run.minutes.shovel && run.minutes.shovel < run.minutes.awake && run.minutes.awake < run.minutes.unearth);
  assert.deepEqual(Object.keys(run).sort(), ['length', 'minutes', 'profile', 'took'], 'times, and no verdict');
  const ev = host.events.since(0).at(-1)!;
  assert.deepEqual([ev.type, ev.kind, ev.copy], ['playtest', 'run', false]);
  const names = await me('playtest.milestones');
  assert.ok(names.some((m: any) => m.id === 'shovel') && names.some((m: any) => m.id === 'seed:rose'));
});

test('the working copy is played against the project: what the agent\'s change does to the pacing', async () => {
  await assert.rejects(agent('playtest.compare'), (e) => e instanceof CommandError && e.code === 'missing', 'nothing differs yet');
  // In the copy, digging comes much sooner: the shovel's diary line after 4 minutes instead of 13. A number is code.
  code.sync();
  const was = readFileSync(CONTENT, 'utf8');
  const now = was.replace(/(id: 'shovel',[^\n]*?after: )13\b/, '$14');
  assert.notEqual(now, was, 'the shovel\'s timing was found in the code');
  writeFileSync(CONTENT, now);

  const cmp = await agent('playtest.compare');
  assert.deepEqual(cmp.changes, ['games/gnome-garden/src/sim/content.ts']);
  const moved = cmp.moved.find((m: any) => m.milestone === 'shovel');
  assert.ok(moved.before >= 12.9 && moved.after < 8, `the shovel came at ${moved.before}, now ${moved.after}`);
  assert.ok(moved.change < -30);
  assert.deepEqual(Object.keys(cmp).sort(), ['changes', 'length', 'moved', 'profile']);
  assert.match(readFileSync(join(ROOT, 'games/gnome-garden/src/sim/content.ts'), 'utf8'), /id: 'shovel',[^\n]*after: 13\b/, 'and the project was never touched');

  const copy = await me('playtest.run', { copy: true });
  assert.ok(copy.minutes.shovel < 8);
  assert.equal(host.events.since(0).at(-1)!.copy, true);
});

test('a look at the game some minutes in, and at a world now: in the project, and as the working copy has it', async () => {
  const project = await agent('game.lookAt', { minutes: 7 });
  assert.equal(readFileSync(project.file).subarray(1, 4).toString(), 'PNG');
  assert.match(project.text, /Unlocked: .*gnomes/);
  assert.doesNotMatch(project.text, /Unlocked: .*\bdig\b/);
  const copy = await agent('game.lookAt', { minutes: 7, copy: true });
  assert.match(copy.text, /Unlocked: .*\bdig\b/, 'in the copy the hole is there after seven minutes');
  assert.match(String(host.events.since(0).at(-1)!.caption), /7 minutes in, in the working copy/);

  // The world being played, drawn by the copy's code: how a change looks where the person is.
  const fresh = host.game.createWorld(undefined, { seed: 3 });
  host.game.playthrough(fresh, 'eager', { untilSeconds: 400 });
  await me('world.push', { snapshot: fresh.snapshot() });
  const here = await agent('game.look', { copy: true });
  assert.equal(readFileSync(here.file).subarray(1, 4).toString(), 'PNG');
  assert.match(here.text, /gardeners/);
  assert.match(String(host.events.since(0).at(-1)!.caption), /as the working copy draws it/);

  // A copy that does not run says so, in words the agent can act on.
  writeFileSync(CONTENT, `${readFileSync(CONTENT, 'utf8')}\nthis is not code(\n`);
  await assert.rejects(agent('game.look', { copy: true }), (e) => e instanceof CommandError && e.code === 'failed' && /in the working copy/.test(e.message));
  code.reject();
});
