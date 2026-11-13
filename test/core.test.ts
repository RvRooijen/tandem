// The core, without HTTP: commands, who may do what, records and proposals,
// concepts, worlds, the inspector and looks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from '../core/commands.ts';
import { AGENT, scratchHost } from './helpers.ts';

const { host, dir, cleanup } = await scratchHost();
after(cleanup);

const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;
const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);

test('every command says what it is for, and the list is what the agent is told', async () => {
  const list = await me('commands.list');
  assert.ok(list.length > 35);
  for (const c of list) {
    assert.match(c.name, /^[a-z]+\.[a-zA-Z]+$/);
    assert.ok(c.about.length > 15, `${c.name} says what it is for`);
    assert.ok(['yes', 'no', 'as a proposal'].includes(c.agent));
  }
  const by = Object.fromEntries(list.map((c: any) => [c.name, c.agent]));
  assert.equal(by['proposals.decide'], 'no');
  assert.equal(by['records.set'], 'as a proposal');
  assert.equal(by['game.state'], 'yes');
  assert.equal(by['world.push'], 'no');
});

test('input is checked before anything runs', async () => {
  await refused(me('nothing.here'), 'unknown');
  await refused(me('records.get', {}), 'input');
  await refused(me('records.get', { path: 5 }), 'input');
  await refused(me('records.get', { path: 'flowers/tulip', nonsense: 1 }), 'input');
  await refused(me('records.get', { path: 'flowers/orchid' }), 'missing');
});

test('the content starts as what is in the code, as one file per thing', async () => {
  const paths = await me('records.list');
  assert.ok(paths.includes('flowers/tulip') && paths.includes('settings/day') && paths.includes('upgrades/compost'));
  assert.ok(existsSync(join(dir, 'game/content/flowers/tulip.json')));
  const tulip = await me('records.get', { path: 'flowers/tulip' });
  assert.equal(tulip.value, 6);
  const flowers = await me('records.get', { path: 'flowers/*' });
  assert.equal(Object.keys(flowers).length, 9);
});

test('the person changes a record at once; the agent proposes, and the person decides', async () => {
  const before = host.events.last();
  assert.deepEqual(await me('records.set', { path: 'flowers/tulip', value: { value: 7 } }), { changed: true });
  assert.equal((await me('records.get', { path: 'flowers/tulip' })).value, 7);
  assert.equal(host.game.exportRecords()['flowers/tulip'].value, 7, 'and the game itself follows');
  assert.equal(JSON.parse(readFileSync(join(dir, 'game/content/flowers/tulip.json'), 'utf8')).value, 7);
  assert.equal(host.events.since(before)[0].type, 'record.changed');

  await refused(me('records.set', { path: 'flowers/tulip', value: { petals: 5 } }), 'input');
  assert.equal((await me('records.set', { path: 'flowers/tulip', value: { value: 7 } })).changed, false);

  const p = await agent('records.set', { path: 'flowers/tulip', value: { value: 12, grow: 4 }, note: 'tulips should matter longer' });
  assert.ok(p.proposed);
  assert.equal((await me('records.get', { path: 'flowers/tulip' })).value, 7, 'nothing changed yet');
  assert.equal((await me('records.get', { path: 'flowers/tulip', proposed: true })).value, 12, 'but it can be read as proposed');
  assert.equal((await me('records.all', { proposed: true, round: 'r1' }))['flowers/tulip'].grow, 4);
  const ev = host.events.since(0).at(-1)!;
  assert.equal(ev.type, 'proposal');
  assert.deepEqual(ev.before, { value: 7, grow: 4.5 });
  assert.deepEqual(ev.after, { value: 12, grow: 4 });

  // A second change to the same record in the same round is the same proposal, moved on.
  await agent('records.set', { path: 'flowers/tulip', value: { value: 10 } });
  await agent('records.set', { path: 'flowers/rose', value: { value: 250 } });
  const pending = await me('proposals.list', { status: 'pending' });
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.find((x: any) => x.path === 'flowers/tulip').after, { value: 10, grow: 4 });

  await refused(agent('proposals.decide', { round: 'r1', accept: true }), 'permission');
  assert.deepEqual(await me('proposals.decide', { round: 'r1', accept: true }), { decided: 2 });
  assert.equal((await me('records.get', { path: 'flowers/tulip' })).value, 10);
  assert.equal(host.game.exportRecords()['flowers/rose'].value, 250);
  await refused(me('proposals.decide', { round: 'r1', accept: true }), 'missing');

  await agent('records.set', { path: 'flowers/rose', value: { value: 999 } }, 'r2');
  await me('proposals.decide', { round: 'r2', accept: false });
  assert.equal((await me('records.get', { path: 'flowers/rose' })).value, 250, 'a rejected round changes nothing');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0);
});

test('concepts: the person writes them, the agent proposes, and nothing in one is a timing', async () => {
  const made = await me('concepts.create', { name: 'The Slow Burn', text: 'It starts as a seed packet and takes hours to turn.' });
  assert.equal(made.id, 'the-slow-burn');
  await refused(me('concepts.create', { name: 'The slow burn' }), 'exists');
  await me('concepts.update', { id: made.id, firmness: 'fixed', realised: ['beats/*', 'settings/day'], links: [{ to: 'ornaments', kind: 'part-of' }] });
  await refused(me('concepts.update', { id: made.id, checks: [{ milestone: 'awake', min: 60 }] }), 'input');
  await refused(me('concepts.update', { id: made.id, firmness: 'solid' }), 'input');
  const c = await me('concepts.get', { id: made.id });
  assert.equal(c.firmness, 'fixed');
  assert.deepEqual(c.links, [{ to: 'ornaments', kind: 'part-of' }]);
  assert.ok(!('checks' in c), 'a concept holds words, not windows of minutes');
  assert.match(readFileSync(join(dir, 'game/concepts/the-slow-burn.md'), 'utf8'), /It starts as a seed packet/);
  assert.equal((await me('concepts.list'))[0].summary, 'It starts as a seed packet and takes hours to turn.');

  // A record that a concept says is its own carries the concept's name on the proposal.
  await agent('records.set', { path: 'settings/day', value: { dayLen: 40 } }, 'r3');
  assert.deepEqual(host.events.since(0).at(-1)!.touches, [{ id: 'the-slow-burn', name: 'The Slow Burn', firmness: 'fixed' }]);
  await me('proposals.decide', { round: 'r3', accept: false });

  const p = await agent('concepts.create', { name: 'Blue rose', text: 'A rose that only opens at night.' }, 'r4');
  assert.ok(p.proposed);
  await refused(me('concepts.get', { id: 'blue-rose' }), 'missing');
  await agent('concepts.update', { id: made.id, text: 'Slower still.' }, 'r4');
  await me('proposals.decide', { round: 'r4', accept: true });
  assert.equal((await me('concepts.get', { id: 'blue-rose' })).firmness, 'loose');
  assert.equal((await me('concepts.get', { id: made.id })).text, 'Slower still.');
  assert.equal((await me('concepts.get', { id: made.id })).firmness, 'fixed', 'the rest of the concept is kept');

  await refused(agent('concepts.remove', { id: 'blue-rose' }), 'permission');
  await me('concepts.remove', { id: 'blue-rose' });
  assert.equal((await me('concepts.list')).length, 1);
});

test('the world being played is mirrored; a sandbox can be played and poked in', async () => {
  // The page shares its world.
  const fresh = host.game.createWorld(undefined, { seed: 3 });
  host.game.playthrough(fresh, 'eager', { untilSeconds: 400 });
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

  assert.equal((await agent('world.drop', { room: 'box' })).dropped, true);
});

test('a look is a picture on disk and the same thing in words', async () => {
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

test('art: the drawings the game is made of can be listed and looked at', async () => {
  const drawings = await agent('art.list');
  assert.deepEqual(drawings.map((d: any) => d.name), ['gnome', 'garden-flowers', 'garden-visitor', 'garden-props', 'garden-critters', 'garden-icons', 'garden-cottage']);
  const gnome = drawings[0];
  assert.deepEqual([gnome.w, gnome.h], [32, 32]);
  assert.deepEqual(gnome.looks.cozy, { stand: 1, walk: 2 });

  const before = host.events.last();
  const sheet = await agent('art.look', { name: 'gnome', look: 'hollow', anim: 'walk' });
  assert.deepEqual(sheet.frames, ['walk 1', 'walk 2']);
  const png = readFileSync(sheet.file);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 2 * 34 * sheet.scale, 'two frames side by side, each with a margin');
  assert.equal(host.events.since(before)[0].caption, 'drawing gnome, walk');
  assert.deepEqual((await agent('art.look', { name: 'garden-flowers' })).frames.slice(0, 3), ['daisy', 'tulip', 'sunflower']);

  await assert.rejects(agent('art.look', { name: 'unicorn' }), (e) => e instanceof CommandError && /no drawing called unicorn; there are: gnome/.test(e.message));
  await assert.rejects(agent('art.look', { name: 'gnome', anim: 'fly' }), (e) => e instanceof CommandError && /it has: stand, walk/.test(e.message));
  // Accepting a drawing and bringing it into the game are the person's.
  await refused(agent('art.accept', { worker: 'w1' }), 'permission');
  await refused(agent('art.import'), 'permission');
  await refused(me('art.ask', { name: 'Not A Name', message: 'x' }), 'input');
});

test('the conversation and the stage are events like everything else', async () => {
  const before = host.events.last();
  await me('chat.send', { text: 'what about the tulips?', refs: ['record:flowers/tulip'] });
  await agent('chat.send', { text: 'They pay 10 now.' });
  await agent('stage.point', { x: 30, y: 150, text: 'here' });
  await agent('stage.open', { tab: 'concepts', id: 'the-slow-burn' });
  await refused(me('chat.send', { text: 'x', refs: 'tulip' }), 'input');
  assert.deepEqual(host.events.since(before).map((e) => `${e.type}:${e.by}`), ['message:me', 'message:agent:main', 'stage.point:agent:main', 'stage.open:agent:main']);
  const history = await me('chat.history', { limit: 2 });
  assert.deepEqual(history.map((m: any) => m.text), ['what about the tulips?', 'They pay 10 now.']);
  assert.deepEqual(history[0].refs, ['record:flowers/tulip']);

  // A new conversation: what was said before is not part of it. Only the person starts one.
  await refused(agent('chat.new'), 'permission');
  await me('chat.new');
  assert.deepEqual(await me('chat.history'), []);
  await me('chat.send', { text: 'a clean start' });
  assert.deepEqual((await me('chat.history')).map((m: any) => m.text), ['a clean start']);
});
