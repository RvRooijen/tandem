// The sense of time: a bot plays the whole game in a process of its own, on
// the content as it is or as proposed, and the concepts' promises are held
// against what happened. These play a few whole games, so they take a while.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommandError } from '../core/commands.ts';
import { compare, evaluate, type Pacing } from '../playtest/pacing.ts';
import { AGENT, scratchHost } from './helpers.ts';

const { host, cleanup } = await scratchHost();
after(cleanup);
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;

test('two runs side by side say what moved, and checks say what broke', () => {
  const a: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.2, shovel: 14, awake: 66, old: 400 }, length: 600, later: [], took: 1 };
  const b: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.3, shovel: 9, awake: 66.2, hat: 300 }, length: 500, later: [], took: 1 };
  assert.deepEqual(compare(a, b), [
    { milestone: 'shovel', before: 14, after: 9, change: -35.7 },
    { milestone: 'hat', before: undefined, after: 300 },
    { milestone: 'old', before: 400, after: undefined },
  ]);
  const concept = (checks: any[]) => [{ id: 'c', name: 'C', firmness: 'fixed' as const, links: [], realised: [], text: '', checks }];
  const res = evaluate(concept([
    { milestone: 'shovel', min: 12.9, max: 17 }, { milestone: 'awake', min: 64.9 }, { milestone: 'old', max: 500 },
    { milestone: 'gerald', max: 1, profile: 'casual' },
  ]), b);
  assert.deepEqual(res.map((r) => [r.milestone, r.ok]), [['shovel', false], ['awake', true], ['old', false]], 'a check for another player is not held against this one');
  assert.match(res[0].says, /shovel came at 9 min, before 12.9/);
  assert.match(res[2].says, /never happened/);
});

test('a playtest plays the whole game and holds the promises against it', async () => {
  await me('concepts.create', { name: 'Slow burn' });
  await me('concepts.update', { id: 'slow-burn', firmness: 'fixed', realised: ['settings/day'], checks: [
    { milestone: 'shovel', min: 12.9, max: 17, why: 'digging is never there in the first quarter of an hour' },
    { milestone: 'unearth', min: 7.4 * 60, max: 13 * 60 },
    { milestone: 'gerald', max: 0.1, why: 'this one cannot hold' },
  ] });
  await assert.rejects(me('playtest.run', { profile: 'reckless' }), (e) => e instanceof CommandError && e.code === 'input');
  const run = await me('playtest.run');
  assert.ok(run.length > 7.4 * 60 && run.length < 13 * 60, `the whole game takes ${run.length} minutes`);
  assert.ok(run.minutes.shovel >= 12.9 && run.minutes.awake >= 64.9);
  assert.equal(run.checks.total, 3);
  assert.deepEqual(run.checks.failed.map((f: any) => f.concept), ['slow-burn']);
  assert.match(run.checks.failed[0].says, /gerald came at/);
  const ev = host.events.since(0).at(-1)!;
  assert.equal(ev.type, 'playtest');
  assert.equal(ev.kind, 'run');
});

test('a proposal is played before it is accepted: what moved, and which promise it breaks', async () => {
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
  assert.deepEqual(cmp.broke.map((b: any) => b.concept), ['Slow burn']);
  assert.match(cmp.broke[0].says, /shovel came at .* before 12.9/);
  assert.equal(cmp.stillFailing, 1, 'what was already broken is not blamed on the proposal');
  assert.equal(host.game.exportRecords()['beats/shovel'].after, 13, 'and the game itself was never touched');

  const proposed = await me('playtest.run', { proposed: true });
  assert.ok(proposed.minutes.shovel < 8);
  assert.equal(proposed.checks.failed.length, 2);
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
