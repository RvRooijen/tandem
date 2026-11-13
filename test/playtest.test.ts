// The sense of time: a bot plays the whole game in a process of its own, on
// the content as it is or as proposed, and says when things happened. These play a few whole games, so they take a while.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommandError } from '../core/commands.ts';
import { compare, type Pacing } from '../playtest/pacing.ts';
import { AGENT, scratchHost } from './helpers.ts';

const { host, cleanup } = await scratchHost();
after(cleanup);
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;

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
  assert.equal(ev.type, 'playtest');
  assert.equal(ev.kind, 'run');
  const names = await me('playtest.milestones');
  assert.ok(names.some((m: any) => m.id === 'shovel') && names.some((m: any) => m.id === 'seed:rose'));
});

test('a proposal is played before it is accepted: what moved, and by how much', async () => {
  await assert.rejects(agent('playtest.compare'), (e) => e instanceof CommandError && e.code === 'missing');
  // Digging on offer much sooner: the shovel's diary line comes after 4 minutes instead of 13.
  const shovel = await me('records.get', { path: 'beats/shovel' });
  assert.equal(shovel.after, 13);
  await agent('records.set', { path: 'beats/shovel', value: { after: 4 }, note: 'get to the hole sooner' });
  const cmp = await agent('playtest.compare');
  assert.equal(cmp.round, 'r1', 'the agent compares its own round');
  assert.deepEqual(cmp.changes, ['beats/shovel']);
  const moved = cmp.moved.find((m: any) => m.milestone === 'shovel');
  assert.ok(moved.before >= 12.9 && moved.after < 8, `the shovel came at ${moved.before}, now ${moved.after}`);
  assert.ok(moved.change < -30);
  assert.deepEqual(Object.keys(cmp).sort(), ['changes', 'length', 'moved', 'profile', 'round']);
  assert.equal(host.game.exportRecords()['beats/shovel'].after, 13, 'and the game itself was never touched');

  const proposed = await me('playtest.run', { proposed: true });
  assert.ok(proposed.minutes.shovel < 8);
});

test('a look at the game some minutes in, as it is and as proposed', async () => {
  const now = await agent('game.lookAt', { minutes: 7 });
  assert.equal(readFileSync(now.file).subarray(1, 4).toString(), 'PNG');
  assert.match(now.text, /Unlocked: .*gnomes/);
  assert.doesNotMatch(now.text, /Unlocked: .*\bdig\b/);
  const then = await agent('game.lookAt', { minutes: 7, proposed: true });
  assert.match(then.text, /Unlocked: .*\bdig\b/, 'with the proposal the hole is there after seven minutes');
  assert.match(String(host.events.since(0).at(-1)!.caption), /7 minutes in, as proposed/);
});
