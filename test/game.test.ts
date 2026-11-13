// What a project can offer on top of its files: a way to be seen inside. These
// run on Gnome Garden, the project next to tandem, through its adapter: its
// worlds, the inspector, pictures, a bot that plays it, and the same on the
// agent's working copy. Gnome Garden is not written in: what tandem keeps is
// in a temporary folder, and the working copy is a worktree there, taken away
// afterwards. Without Gnome Garden next to tandem, these are skipped. They
// play a few whole games, so they take a while.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from '../core/commands.ts';
import { compare, type Pacing } from '../playtest/pacing.ts';
import { AGENT, GAME, game, hasGame } from './helpers.ts';

const skip = hasGame ? false : `Gnome Garden is not at ${GAME}`;
const made = hasGame ? await game() : undefined;
after(() => made?.cleanup());
const host = made?.host!, code = made?.code!, dir = made?.dir ?? '';
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;
const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);
const CONTENT = join(dir, 'copy/src/sim/content.ts');
const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: GAME, encoding: 'utf8' });
const before = hasGame ? status() : '';

test('a project with an adapter has the commands to see inside it', { skip }, async () => {
  const names = (await me('commands.list')).map((c: any) => c.name);
  for (const n of ['game.state', 'game.look', 'game.lookAt', 'game.tap', 'world.fork', 'ecs.summary', 'playtest.run', 'playtest.compare']) assert.ok(names.includes(n), n);
  assert.equal(host.game!.name, 'Gnome Garden');
});

test('the world being played is mirrored; a sandbox can be played and poked in', { skip }, async () => {
  // The page shares its world.
  const fresh = host.game!.createWorld(undefined, { seed: 3 });
  host.game!.playthrough(fresh, 'eager', { untilSeconds: 400 });
  await me('world.push', { snapshot: fresh.snapshot() });
  await refused(agent('world.push', { snapshot: {} }), 'permission');
  const state = (await agent('game.state')).state as string;
  assert.match(state, /Owner 1/);
  assert.match(state, /gardeners/);
  assert.doesNotMatch(state, /Gnomes 0/, 'six minutes in there are gnomes');

  await refused(agent('game.buy', { what: 'plot' }), 'permission');
  await refused(me('game.tap', { x: 30, y: 150, room: 'mine' }), 'permission');
  await refused(agent('game.step', { seconds: 5, room: 'nowhere' }), 'missing');

  await agent('world.fork', { room: 'box' });
  assert.deepEqual((await me('world.rooms')).map((r: any) => r.name).sort(), ['box', 'mine']);
  const clock = (await agent('game.step', { seconds: 30, room: 'box' })).clock;
  assert.ok(clock > 420);
  assert.ok(!(await agent('game.state')).state.includes(String(Math.round(clock))), 'the mirror did not move');

  const sum = await agent('ecs.summary', { room: 'box' });
  assert.ok(sum.entities > 4);
  assert.equal(sum.schemas.Gnome.state, 'u8');
  assert.equal(sum.schemas.Pos.x, 'f32');
  const gnomes = await agent('ecs.entities', { with: 'Gnome,Pos', room: 'box' });
  assert.ok(gnomes.total >= 1);
  const one = gnomes.entities[0];
  assert.ok('Move' in one.components && 'role' in one.components.Gnome);
  assert.equal((await agent('ecs.entities', { where: 'Gnome.role=0, Pos.y>0', room: 'box' })).total, gnomes.total);
  assert.equal((await agent('ecs.entities', { where: 'Gnome.role=7', room: 'box' })).total, 0);
  await refused(agent('ecs.entities', { where: 'Gnome.role is 7', room: 'box' }), 'input');
  await refused(agent('ecs.entities', { with: 'Unicorn', room: 'box' }), 'input');

  const near = await agent('ecs.at', { x: one.components.Pos.x, y: one.components.Pos.y, room: 'box' });
  assert.equal(near.entities[0].id, one.id);
  await refused(agent('ecs.set', { id: one.id, component: 'Gnome', field: 'load', value: 3 }), 'permission');
  const poked = await agent('ecs.set', { id: one.id, component: 'Gnome', field: 'load', value: 3, room: 'box' });
  assert.equal(poked.components.Gnome.load, 3);
  assert.equal((await agent('ecs.entity', { id: one.id, room: 'box' })).components.Gnome.load, 3);

  const sys = await agent('ecs.systems', { room: 'box' });
  assert.deepEqual(sys.order.slice(0, 4), ['grow', 'ripe', 'brain', 'walkGnomes']);
  assert.equal(sys.queries.find((q: any) => q.name === 'grow').mode, 'kernel');

  // A world as data, to start it again somewhere else (the page of the working copy starts from it).
  const snap = await agent('world.snapshot');
  assert.equal(host.game!.createWorld(snap).describe().split('\n')[1], host.world().describe().split('\n')[1]);

  assert.equal((await agent('world.drop', { room: 'box' })).dropped, true);
});

test('a look is a picture on disk and the same thing in words', { skip }, async () => {
  const before = host.events.last();
  const look = await agent('game.look', { caption: 'six minutes in' });
  const png = readFileSync(look.file);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.length > 5000);
  assert.match(look.url, /^\/api\/file\/looks\/look-.*\.png$/);
  assert.match(look.text, /Peace of mind/);
  const ev = host.events.since(before)[0];
  assert.equal(ev.type, 'look');
  assert.equal(ev.caption, 'six minutes in');
});

test('two runs side by side say what moved', () => {
  const a: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.2, shovel: 14, awake: 66, old: 400 }, length: 600, later: [], took: 1 };
  const b: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.3, shovel: 9, awake: 66.2, hat: 300 }, length: 500, later: [], took: 1 };
  assert.deepEqual(compare(a, b), [
    { milestone: 'shovel', before: 14, after: 9, change: -35.7 },
    { milestone: 'hat', before: undefined, after: 300 },
    { milestone: 'old', before: 400, after: undefined },
  ]);
});

test('a playtest plays the whole game and says when things happened, without judging it', { skip }, async () => {
  await refused(me('playtest.run', { profile: 'reckless' }), 'input');
  const run = await me('playtest.run');
  assert.ok(run.length > 7 * 60 && run.length < 14 * 60, `the whole game takes ${run.length} minutes`);
  assert.ok(run.minutes.gerald < run.minutes.shovel && run.minutes.shovel < run.minutes.awake && run.minutes.awake < run.minutes.unearth);
  assert.deepEqual(Object.keys(run).sort(), ['length', 'minutes', 'profile', 'took'], 'times, and no verdict');
  const ev = host.events.since(0).at(-1)!;
  assert.deepEqual([ev.type, ev.kind, ev.copy], ['playtest', 'run', false]);
  const names = await me('playtest.milestones');
  assert.ok(names.some((m: any) => m.id === 'shovel') && names.some((m: any) => m.id === 'seed:rose'));
});

test('the working copy is played against the project: what the agent\'s change does to the pacing', { skip }, async () => {
  await refused(agent('playtest.compare'), 'missing');
  // In the copy, digging comes much sooner: the shovel's diary line after 4 minutes instead of 13. A number is code.
  code.sync();
  const was = readFileSync(CONTENT, 'utf8');
  const now = was.replace(/(id: 'shovel',[^\n]*?after: )13\b/, '$14');
  assert.notEqual(now, was, 'the shovel\'s timing was found in the code');
  writeFileSync(CONTENT, now);

  const cmp = await agent('playtest.compare');
  assert.deepEqual(cmp.changes, ['src/sim/content.ts']);
  const moved = cmp.moved.find((m: any) => m.milestone === 'shovel');
  assert.ok(moved.before >= 12.9 && moved.after < 8, `the shovel came at ${moved.before}, now ${moved.after}`);
  assert.ok(moved.change < -30);
  assert.deepEqual(Object.keys(cmp).sort(), ['changes', 'length', 'moved', 'profile']);

  const copy = await me('playtest.run', { copy: true });
  assert.ok(copy.minutes.shovel < 8);
  assert.equal(host.events.since(0).at(-1)!.copy, true);
});

test('a look at the game some minutes in, and at a world now: in the project, and as the working copy has it', { skip }, async () => {
  const project = await agent('game.lookAt', { minutes: 7 });
  assert.equal(readFileSync(project.file).subarray(1, 4).toString(), 'PNG');
  assert.match(project.text, /Unlocked: .*gnomes/);
  assert.doesNotMatch(project.text, /Unlocked: .*\bdig\b/);
  const copy = await agent('game.lookAt', { minutes: 7, copy: true });
  assert.match(copy.text, /Unlocked: .*\bdig\b/, 'in the copy the hole is there after seven minutes');
  assert.match(String(host.events.since(0).at(-1)!.caption), /7 minutes in, in the working copy/);

  // The world being played, drawn by the copy's code: how a change looks where the person is.
  const here = await agent('game.look', { copy: true });
  assert.equal(readFileSync(here.file).subarray(1, 4).toString(), 'PNG');
  assert.match(here.text, /gardeners/);
  assert.match(String(host.events.since(0).at(-1)!.caption), /as the working copy draws it/);

  // A copy that does not run says so, in words the agent can act on.
  writeFileSync(CONTENT, `${readFileSync(CONTENT, 'utf8')}\nthis is not code(\n`);
  await assert.rejects(agent('game.look', { copy: true }), (e) => e instanceof CommandError && e.code === 'failed' && /in the working copy/.test(e.message));
  code.reject();
});

test('and Gnome Garden itself was never written in', { skip }, () => {
  assert.equal(status(), before);
});
