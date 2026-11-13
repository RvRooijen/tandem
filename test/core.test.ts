// The core, without HTTP, on a project that offers nothing but its files and
// a few drawings: commands, who may do what, concepts and proposals, locks,
// art, the conversation. (What needs a project to be seen inside is in
// game.test.ts.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from '../core/commands.ts';
import { AGENT, fixture } from './helpers.ts';

// Without a working copy: drawings taken into the project are built straight in.
const { host, dir, cleanup } = await fixture({ code: false });
after(cleanup);

const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;
const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);

test('every command says what it is for, and the list is what the agent is told', async () => {
  const list = await me('commands.list');
  assert.ok(list.length > 25);
  for (const c of list) {
    assert.match(c.name, /^[a-z]+\.[a-zA-Z]+$/);
    assert.ok(c.about.length > 15, `${c.name} says what it is for`);
    assert.ok(['yes', 'no', 'as a proposal'].includes(c.agent));
  }
  const by = Object.fromEntries(list.map((c: any) => [c.name, c.agent]));
  assert.equal(by['proposals.decide'], 'no');
  assert.equal(by['concepts.update'], 'as a proposal');
  assert.ok(!list.some((c: any) => c.name.startsWith('records.')), 'the game\'s numbers are code, not a layer of records beside it');
  assert.equal(by['art.look'], 'yes');
  assert.equal(by['locks.set'], 'no');
  // This project does not offer a way to see inside it, so the commands for that are not there at all.
  assert.ok(!list.some((c: any) => /^(game|world|ecs|playtest)\./.test(c.name)));
  assert.equal(host.game, undefined);
});

test('input is checked before anything runs', async () => {
  await refused(me('nothing.here'), 'unknown');
  await refused(me('concepts.get', {}), 'input');
  await refused(me('concepts.get', { id: 5 }), 'input');
  await refused(me('concepts.get', { id: 'slow-burn', nonsense: 1 }), 'input');
  await refused(me('concepts.get', { id: 'orchids' }), 'missing');
});

test('the person changes a concept at once; the agent proposes, and the person decides', async () => {
  await me('concepts.create', { name: 'Tulips', text: 'A splash of colour for the beds.' });
  const before = host.events.last();
  assert.deepEqual(await me('concepts.update', { id: 'tulips', text: 'A splash of colour.' }), { changed: true });
  assert.equal((await me('concepts.get', { id: 'tulips' })).text, 'A splash of colour.');
  assert.equal(host.events.since(before)[0].type, 'concept.changed');
  assert.equal((await me('concepts.update', { id: 'tulips', text: 'A splash of colour.' })).changed, false);

  const p = await agent('concepts.update', { id: 'tulips', text: 'They matter longer.', stage: 'design', note: 'tulips should matter longer' });
  assert.ok(p.proposed);
  assert.equal((await me('concepts.get', { id: 'tulips' })).text, 'A splash of colour.', 'nothing changed yet');
  const ev = host.events.since(0).at(-1)!;
  assert.equal(ev.type, 'proposal');
  assert.deepEqual(ev.before, { text: 'A splash of colour.', stage: 'idea' });
  assert.deepEqual(ev.after, { text: 'They matter longer.', stage: 'design' });

  // A second change to the same thing in the same round is the same proposal, moved on.
  await agent('concepts.update', { id: 'tulips', text: 'They matter much longer.' });
  await agent('concepts.create', { name: 'Roses' });
  const pending = await me('proposals.list', { status: 'pending' });
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.find((x: any) => x.path === 'tulips').after, { text: 'They matter much longer.', stage: 'design' });

  await refused(agent('proposals.decide', { round: 'r1', accept: true }), 'permission');
  assert.deepEqual(await me('proposals.decide', { round: 'r1', accept: true }), { decided: 2, left: 0 });
  assert.equal((await me('concepts.get', { id: 'tulips' })).text, 'They matter much longer.');
  assert.equal((await me('concepts.get', { id: 'roses' })).stage, 'idea');
  await refused(me('proposals.decide', { round: 'r1', accept: true }), 'missing');

  await agent('concepts.update', { id: 'roses', text: 'Thorns.' }, 'r2');
  await me('proposals.decide', { round: 'r2', accept: false });
  assert.equal((await me('concepts.get', { id: 'roses' })).text, '', 'a rejected round changes nothing');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0);

  // A round is shown as one, but it can be decided piece by piece: one taken, one refused, the rest still waiting.
  await agent('concepts.create', { name: 'Lilies' }, 'r3');
  await agent('concepts.create', { name: 'Daisies' }, 'r3');
  await agent('concepts.update', { id: 'roses', text: 'Thorns, again.' }, 'r3');
  const three = await me('proposals.list', { status: 'pending' });
  const idOf = (path: string) => three.find((x: any) => x.path === path).id as string;
  assert.deepEqual(await me('proposals.decide', { round: 'r3', accept: true, only: [idOf('lilies')] }), { decided: 1, left: 2 });
  assert.equal((await me('concepts.get', { id: 'lilies' })).name, 'Lilies');
  await refused(me('concepts.get', { id: 'daisies' }), 'missing');
  assert.deepEqual(await me('proposals.decide', { round: 'r3', accept: false, only: [idOf('daisies')] }), { decided: 1, left: 1 });
  await refused(me('proposals.decide', { round: 'r3', accept: true, only: [idOf('lilies')] }), 'missing');
  const decided = (await me('events.since', { n: 0 })).filter((e: any) => e.type === 'proposal.decided' && e.round === 'r3');
  assert.deepEqual(decided.map((e: any) => [e.status, e.ids, e.left]), [['accepted', [idOf('lilies')], 2], ['rejected', [idOf('daisies')], 1]]);
  // Without naming any, what is left of the round is decided.
  assert.deepEqual(await me('proposals.decide', { round: 'r3', accept: true }), { decided: 1, left: 0 });
  assert.equal((await me('concepts.get', { id: 'roses' })).text, 'Thorns, again.');
  await refused(me('concepts.get', { id: 'daisies' }), 'missing');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0);
  await me('concepts.remove', { id: 'lilies' });
  await me('concepts.remove', { id: 'tulips' });
  await me('concepts.remove', { id: 'roses' });
});

test('concepts: the person writes them, the agent proposes, and nothing in one is a timing', async () => {
  const made = await me('concepts.create', { name: 'The Slow Burn', text: 'It starts as a seed packet and takes hours to turn.' });
  assert.equal(made.id, 'the-slow-burn');
  await refused(me('concepts.create', { name: 'The slow burn' }), 'exists');
  await me('concepts.update', { id: made.id, stage: 'playtest', realised: ['the diary lines', 'a test'], links: [{ to: 'ornaments', kind: 'part-of' }] });
  await refused(me('concepts.update', { id: made.id, checks: [{ milestone: 'awake', min: 60 }] }), 'input');
  await refused(me('concepts.update', { id: made.id, stage: 'finished' }), 'input');
  await refused(me('concepts.update', { id: made.id, firmness: 'fixed' }), 'input');
  const c = await me('concepts.get', { id: made.id });
  assert.equal(c.stage, 'playtest');
  assert.equal(c.locked, false);
  assert.deepEqual(c.links, [{ to: 'ornaments', kind: 'part-of' }]);
  assert.ok(!('checks' in c), 'a concept holds words, not windows of minutes');
  assert.match(readFileSync(join(dir, '.tandem/concepts/the-slow-burn.md'), 'utf8'), /It starts as a seed packet/);
  assert.equal((await me('concepts.list'))[0].summary, 'It starts as a seed packet and takes hours to turn.');

  const p = await agent('concepts.create', { name: 'Blue rose', text: 'A rose that only opens at night.' }, 'r4');
  assert.ok(p.proposed);
  await refused(me('concepts.get', { id: 'blue-rose' }), 'missing');
  await agent('concepts.update', { id: made.id, text: 'Slower still.' }, 'r4');
  await me('proposals.decide', { round: 'r4', accept: true });
  assert.equal((await me('concepts.get', { id: 'blue-rose' })).stage, 'idea');
  assert.equal((await me('concepts.get', { id: made.id })).text, 'Slower still.');
  assert.equal((await me('concepts.get', { id: made.id })).stage, 'playtest', 'the rest of the concept is kept');

  await refused(agent('concepts.remove', { id: 'blue-rose' }), 'permission');
  await me('concepts.remove', { id: 'blue-rose' });
  assert.equal((await me('concepts.list')).length, 1);
});

test('a lock keeps the agent off a thing, even when it is asked to change it', async () => {
  await refused(agent('locks.set', { ref: 'drawing:gnome', locked: true }), 'permission');
  await refused(me('locks.set', { ref: 'gnome', locked: true }), 'input');
  await refused(me('locks.set', { ref: 'record:flowers/rose', locked: true }), 'input');
  const before = host.events.last();
  await me('locks.set', { ref: 'concept:the-slow-burn', locked: true });
  await me('locks.set', { ref: 'drawing:gnome', locked: true });
  await me('locks.set', { ref: 'drawing:gnome', locked: true });
  assert.deepEqual(host.events.since(before).map((e) => `${e.type} ${e.ref}`), ['lock.changed concept:the-slow-burn', 'lock.changed drawing:gnome']);
  assert.deepEqual(await agent('locks.list'), ['concept:the-slow-burn', 'drawing:gnome']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.tandem/locks.json'), 'utf8')), ['concept:the-slow-burn', 'drawing:gnome']);

  // The agent cannot change it and cannot propose a change to it.
  const pending = (await me('proposals.list', { status: 'pending' })).length;
  await refused(agent('concepts.update', { id: 'the-slow-burn', text: 'Faster.' }, 'r7'), 'locked');
  await refused(agent('art.ask', { name: 'gnome', message: 'a taller hat' }, 'r7'), 'locked');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, pending, 'nothing was proposed');
  assert.match(await agent('concepts.update', { id: 'the-slow-burn', text: 'Faster.' }).catch((e: Error) => e.message), /even if they ask you to/);
  assert.equal((await agent('concepts.list')).find((c: any) => c.id === 'the-slow-burn').locked, true);
  assert.equal((await agent('art.list')).find((d: any) => d.name === 'gnome').locked, true);

  // What is next to it is not locked, and the person is never locked out.
  assert.ok((await agent('concepts.create', { name: 'Faster seasons' }, 'r7')).proposed);
  await me('proposals.decide', { round: 'r7', accept: false });
  await me('concepts.update', { id: 'the-slow-burn', stage: 'design' });

  await me('locks.set', { ref: 'concept:the-slow-burn', locked: false });
  assert.ok((await agent('concepts.update', { id: 'the-slow-burn', text: 'Faster.' }, 'r8')).proposed);
  await me('proposals.decide', { round: 'r8', accept: false });
  await me('locks.set', { ref: 'drawing:gnome', locked: false });
  assert.deepEqual(await me('locks.list'), []);
});

test('art: a drawing is a thing of the engine: listed, read, looked at, changed and proposed on', async () => {
  const drawings = await agent('art.list');
  assert.deepEqual(drawings.map((d: any) => d.name), ['garden-cottage', 'garden-critters', 'garden-flowers', 'garden-icons', 'garden-props', 'garden-visitor', 'gnome']);
  const gnome = drawings.at(-1);
  assert.deepEqual([gnome.w, gnome.h, gnome.depth, gnome.locked], [32, 32, true, false]);
  assert.deepEqual(gnome.looks, ['cozy', 'odd', 'hollow']);
  assert.deepEqual(gnome.anims, { stand: 1, walk: 2 });

  const src = await agent('art.get', { name: 'gnome' });
  assert.match(src.text, /@recolor odd/);
  assert.match(src.depth, /^1 = #2b3048/m);
  await refused(agent('art.get', { name: 'unicorn' }), 'missing');

  // A look is pixeldraw's own render of it.
  const before = host.events.last();
  const look = await agent('art.look', { name: 'gnome', anim: 'walk', look: 'hollow' });
  assert.equal(readFileSync(look.file).subarray(1, 4).toString(), 'PNG');
  assert.equal(host.events.since(before)[0].caption, 'drawing gnome, walk');
  assert.ok(readFileSync((await agent('art.look', { name: 'gnome', depth: true })).file).length > 500);
  await refused(agent('art.look', { name: 'unicorn' }), 'missing');
  await refused(agent('art.look', { name: 'gnome', anim: 'fly' }), 'failed');

  // The agent's change is a proposal with a picture before and after; the game is not touched.
  const tiny = 'k = #1a1c2c\n\n@size 8 8\n@rect 1 1 6 6 k\n';
  await refused(agent('art.set', { name: 'gnome', text: 'this is not a drawing <<<' }), 'input');
  const p = await agent('art.set', { name: 'gnome', text: tiny, note: 'a smaller gnome' }, 'r20');
  assert.ok(p.proposed);
  const ev = host.events.since(0).at(-1)!;
  assert.deepEqual([ev.type, ev.kind, ev.path, ev.isNew], ['proposal', 'drawing', 'gnome', false]);
  assert.match((ev.pictures as any).before, /^\/api\/file\/looks\//);
  assert.match((ev.pictures as any).after, /^\/api\/file\/looks\//);
  assert.equal((await agent('art.get', { name: 'gnome' })).text, src.text);
  await me('proposals.decide', { round: 'r20', accept: false });
  assert.equal((await agent('art.get', { name: 'gnome' })).text, src.text, 'rejected: still as it was');

  // Accepted, it is the drawing, and the game is built with it.
  await agent('art.set', { name: 'garden-sign', text: tiny, note: 'a sign for the gate' }, 'r21');
  assert.equal(host.events.since(0).at(-1)!.isNew, true);
  await me('proposals.decide', { round: 'r21', accept: true });
  assert.equal(readFileSync(join(dir, 'art/garden-sign.txt'), 'utf8'), tiny);
  assert.ok(JSON.parse(readFileSync(join(dir, 'built.json'), 'utf8')).includes('garden-sign'), 'the project\'s own build of its drawings was run');
  assert.equal((await agent('art.list')).length, 8);
  assert.equal(host.events.since(0).filter((e) => e.type === 'art.changed').at(-1)!.names + '', 'garden-sign');

  // The person's change is made at once. A locked drawing is nobody's but theirs.
  assert.equal((await me('art.set', { name: 'garden-sign', text: tiny.replace('6 6', '5 5') })).changed, true);
  await me('locks.set', { ref: 'drawing:garden-sign', locked: true });
  await refused(agent('art.set', { name: 'garden-sign', text: tiny }, 'r22'), 'locked');
  await refused(agent('art.ask', { name: 'garden-sign', message: 'make it red' }), 'locked');
  await refused(me('art.ask', { name: 'garden-sign', message: 'make it red' }), 'locked');
  await me('locks.set', { ref: 'drawing:garden-sign', locked: false });
  await refused(me('art.ask', { name: 'Not A Name', message: 'x' }), 'input');
  await refused(me('art.ask', { name: 'gnome', message: 'x', new: true }), 'exists');
  await refused(me('art.ask', { name: 'unicorn', message: 'x' }), 'missing');
  await refused(agent('art.build'), 'permission');
});

test('a photo or a file is put with the conversation and goes along with a message', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const photo = await me('chat.attach', { name: '../my photo (1).PNG', data: png });
  assert.match(photo.name, /^[a-z0-9]+-my photo _1_\.PNG$/, 'kept under a name of its own, with nothing of a path in it');
  assert.deepEqual([photo.label, photo.image, photo.size], ['my photo _1_.PNG', true, 8]);
  assert.equal(readFileSync(photo.path).toString('hex'), '89504e470d0a1a0a');
  assert.ok(photo.path.startsWith(join(dir, '.tandem/data/files/')), 'with what tandem keeps outside git, not among the project\'s files');
  assert.match(photo.url, /^\/api\/file\/files\//);
  const notes = await me('chat.attach', { name: 'notes.txt', data: Buffer.from('roses later').toString('base64') });
  assert.equal(notes.image, false);
  await refused(me('chat.attach', { name: 'empty.txt', data: '' }), 'input');
  await refused(agent('chat.attach', { name: 'x.txt', data: 'eA==' }), 'permission');

  const sent = await me('chat.send', { text: 'this is what I mean', files: [photo, notes, { name: '../../etc/passwd' }, { name: 'never-attached.png' }] });
  assert.deepEqual(sent.files.map((f: any) => f.label), ['my photo _1_.PNG', 'notes.txt'], 'only what was really attached goes along');
  await refused(me('chat.send', { text: 'x', files: 'photo.png' }), 'input');
});

test('setting tandem up for a project that exists already: the engine puts the agent to work on it', async () => {
  await refused(agent('project.init'), 'permission');
  const before = host.events.last();
  assert.equal((await me('project.init', { note: 'the server notes are in docs/' })).asked, true);
  const ev = host.events.since(before)[0];
  assert.deepEqual([ev.type, ev.by, ev.kind], ['message', 'engine', 'init']);
  const text = String(ev.text);
  assert.match(text, /^Set tandem up for this project\./);
  assert.match(text, /concepts\.create/, 'the ideas it is made of, as concepts to accept');
  assert.match(text, /tandem\.json/, 'and how it is run');
  assert.match(text, /\{port\}.*\{project\}|\{project\}.*\{port\}/s);
  assert.match(text, /make nothing up/);
  assert.match(text, /The person adds: the server notes are in docs\/$/);
});

test('the conversation and the stage are events like everything else', async () => {
  const before = host.events.last();
  await me('chat.send', { text: 'what about the tulips?', refs: ['drawing:garden-flowers'] });
  await agent('chat.send', { text: 'They pay 10 now.' });
  await agent('stage.point', { x: 30, y: 150, text: 'here' });
  await agent('stage.open', { tab: 'concepts', id: 'the-slow-burn' });
  await refused(me('chat.send', { text: 'x', refs: 'tulip' }), 'input');
  assert.deepEqual(host.events.since(before).map((e) => `${e.type}:${e.by}`), ['message:me', 'message:agent:main', 'stage.point:agent:main', 'stage.open:agent:main']);
  const history = await me('chat.history', { limit: 2 });
  assert.deepEqual(history.map((m: any) => m.text), ['what about the tulips?', 'They pay 10 now.']);
  assert.deepEqual(history[0].refs, ['drawing:garden-flowers']);

  // A new conversation: what was said before is not part of it. Only the person starts one.
  await refused(agent('chat.new'), 'permission');
  await me('chat.new');
  assert.deepEqual(await me('chat.history'), []);
  await me('chat.send', { text: 'a clean start' });
  assert.deepEqual((await me('chat.history')).map((m: any) => m.text), ['a clean start']);
});
