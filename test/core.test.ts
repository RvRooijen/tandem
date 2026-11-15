// The core, without HTTP, on a project that offers nothing but its files and
// a few drawings: commands, who may do what, concepts and proposals, locks,
// art, the conversation. (What needs a project to be seen inside is in
// game.test.ts.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CommandError, createRegistry } from '../core/commands.ts';
import { createHost } from '../core/host.ts';
import { loadProject } from '../core/project.ts';
import { changeOf, countOf, didWith, outOf, runnable } from '../core/runner.ts';
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

test('a concept that is still a proposal is worked on further as that proposal: its links do not wait for the person', async () => {
  // What the agent writes for a concept is short: a paper is refused, and so is growing one that is there.
  const long = (n: number) => Array.from({ length: n }, (_x, k) => `word${k}`).join(' ');
  await assert.rejects(agent('concepts.create', { name: 'Hedges', text: long(41) }, 'r40'), /that is 41 words, and a concept is one sentence, two at most.*a concept of its own under this one/);
  await me('concepts.create', { name: 'Essay', text: long(200) });
  await assert.rejects(agent('concepts.update', { id: 'essay', text: long(201) }, 'r41'), /that is 201 words/);
  await agent('concepts.update', { id: 'essay', text: long(150) }, 'r41');
  await me('proposals.decide', { round: 'r41', accept: false });
  await me('concepts.remove', { id: 'essay' });
  const made = await agent('concepts.create', { name: 'Hedges', text: 'Hedges keep the wind out.', stage: 'playtest', realised: ['src/hedge.js'] }, 'r40');
  await agent('concepts.create', { name: 'Gates', links: [{ to: 'hedges', kind: 'part-of' }] }, 'r40');
  // Later, even in another round, more is added to the one that is not accepted yet.
  const more = await agent('concepts.update', { id: 'hedges', links: [{ to: 'gates', kind: 'leads-to' }], text: 'Hedges keep the wind out, and the gnomes in.' }, 'r41');
  assert.deepEqual([more.proposed, more.round], [made.proposed, 'r40'], 'the same proposal, in the round it was made in');
  assert.deepEqual(await agent('concepts.update', { id: 'hedges', stage: 'playtest' }, 'r41'), { changed: false });
  const pending = await me('proposals.list', { status: 'pending' });
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.find((p: any) => p.path === 'hedges').after,
    { name: 'Hedges', stage: 'playtest', links: [{ to: 'gates', kind: 'leads-to' }], realised: ['src/hedge.js'], text: 'Hedges keep the wind out, and the gnomes in.' });
  await refused(agent('concepts.update', { id: 'nothing-like-it', text: 'x' }, 'r41'), 'missing');
  await me('proposals.decide', { round: 'r40', accept: true });
  const hedges = await me('concepts.get', { id: 'hedges' });
  assert.deepEqual([hedges.stage, hedges.links, hedges.realised], ['playtest', [{ to: 'gates', kind: 'leads-to' }], ['src/hedge.js']]);
  assert.deepEqual((await me('concepts.get', { id: 'gates' })).links, [{ to: 'hedges', kind: 'part-of' }]);
  for (const id of ['hedges', 'gates']) await me('concepts.remove', { id });
});

test('the agent asks what only the person can say, and their answers come back as a message', async () => {
  await refused(agent('concepts.create', { name: 'Ponds', questions: 'is it deep?' }, 'r45'), 'input');
  await refused(agent('concepts.create', { name: 'Ponds', questions: ['1', '2', '3', '4', '5', '6'] }, 'r45'), 'input');
  // With a concept it proposes: the questions go with the proposal, not into the concept.
  const made = await agent('concepts.create', { name: 'Ponds', text: 'A pond in the corner.', questions: ['Do frogs live in it?', ' Is it deep? '] }, 'r45');
  const ev = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.deepEqual(ev.questions, ['Do frogs live in it?', 'Is it deep?']);
  assert.equal((ev.after as any).questions, undefined);
  await refused(me('chat.answer', { to: made.proposed, answers: ['', ' '] }), 'input');
  await refused(me('chat.answer', { to: 'nothing', answers: ['x'] }), 'missing');
  await refused(agent('chat.answer', { to: made.proposed, answers: ['yes'] }, 'r45'), 'permission');
  const sent = await me('chat.answer', { to: made.proposed, answers: ['Yes, three of them.'] });
  assert.deepEqual([sent.type, sent.by, sent.kind], ['message', 'me', 'answers']);
  assert.equal(sent.text, 'My answers to your questions about the concept Ponds:\n- Do frogs live in it?\n  Yes, three of them.');
  assert.equal(sent.refs, undefined, 'a concept that is not there yet is not pointed at');
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'answered').at(-1)!.answers, ['Yes, three of them.', '']);
  // Worked into the proposal, the answered question is taken away.
  await agent('concepts.update', { id: 'ponds', text: 'A pond in the corner, with three frogs.', questions: ['Is it deep?'] }, 'r46');
  const again = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.deepEqual([again.id, again.questions, (again.after as any).text], [made.proposed, ['Is it deep?'], 'A pond in the corner, with three frogs.']);
  await agent('concepts.update', { id: 'ponds', questions: [] }, 'r46');
  assert.equal(host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!.questions, undefined);
  await me('proposals.decide', { round: 'r45', accept: false });

  // And questions on their own, about something that is there.
  await refused(agent('chat.ask', { questions: [] }, 'r47'), 'input');
  const asked = await agent('chat.ask', { questions: ['Which season does it start in?'], about: 'drawing:garden-flowers' }, 'r47');
  const q = host.events.since(0).filter((e) => e.type === 'questions').at(-1)!;
  assert.deepEqual([q.id, q.questions, q.about, q.round], [asked.asked, ['Which season does it start in?'], 'drawing:garden-flowers', 'r47']);
  const reply = await me('chat.answer', { to: asked.asked, answers: ['Spring.'] });
  assert.deepEqual([reply.text, reply.refs], ['My answers to your questions:\n- Which season does it start in?\n  Spring.', ['drawing:garden-flowers']]);
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

test('a loose thought is the person\'s, kept apart from the concepts until it is given a place among them', async () => {
  assert.deepEqual(await me('thoughts.list'), []);
  await refused(me('thoughts.add', { text: '  ' }), 'input');
  await refused(agent('thoughts.add', { text: 'A thought of the agent.' }), 'permission');
  const moss = await me('thoughts.add', { text: 'Moss on the north side of everything.\nMaybe it spreads.' });
  const owl = await me('thoughts.add', { text: 'An owl at night?' });
  const bell = await me('thoughts.add', { text: 'A bell by the gate.' });
  assert.deepEqual((await agent('thoughts.list')).map((t: any) => t.text), ['Moss on the north side of everything.\nMaybe it spreads.', 'An owl at night?', 'A bell by the gate.'], 'the agent reads them');
  assert.ok(existsSync(join(dir, '.tandem/thoughts.json')), 'kept with the project, beside its concepts');
  await refused(agent('thoughts.remove', { id: owl.id }), 'permission');

  // The person makes a piece of the document from one: the thought is then no longer loose.
  await refused(me('concepts.create', { name: 'Moss', thought: 'no-such-thought' }), 'missing');
  await me('concepts.create', { name: 'Moss', text: moss.text, thought: moss.id });
  assert.equal(host.concepts.get('moss')!.text, moss.text);
  assert.deepEqual((await me('thoughts.list')).map((t: any) => t.id), [owl.id, bell.id]);
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'thought.changed').map((e) => e.what), ['added', 'added', 'added', 'placed']);

  // The agent proposes where one belongs; it stays loose until the person accepts, and stays when they do not.
  await agent('concepts.update', { id: 'moss', text: `${moss.text}\n\nAn owl hunts over it at night.`, thought: owl.id }, 'r70');
  const card = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.equal(card.thought, 'An owl at night?', 'the card says which thought it takes in');
  assert.equal((await me('thoughts.list')).length, 2);
  await me('proposals.decide', { round: 'r70', accept: false });
  assert.equal((await me('thoughts.list')).length, 2, 'declined: still loose');
  await agent('concepts.create', { name: 'The gate bell', text: 'A bell by the gate.', links: [{ to: 'moss', kind: 'part-of' }], thought: bell.id }, 'r71');
  await me('proposals.decide', { round: 'r71', accept: true });
  assert.ok(host.concepts.get('the-gate-bell'));
  assert.deepEqual((await me('thoughts.list')).map((t: any) => t.id), [owl.id], 'accepted: it is in the document now');

  await me('thoughts.remove', { id: owl.id });
  await refused(me('thoughts.remove', { id: owl.id }), 'missing');
  assert.deepEqual(await me('thoughts.list'), []);
  for (const id of ['moss', 'the-gate-bell']) await me('concepts.remove', { id });
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

test('how tandem runs the project is kept in tandem\'s own folder; the agent proposes it, the person decides', async () => {
  const { configFile, pageScript } = host.project;
  assert.equal(configFile, join(host.project.dirs.tandem, 'tandem.json'));
  await refused(agent('project.configure', { page: 'serve' }, 'r60'), 'input');
  await refused(agent('project.configure', { run: 'npm run build' }, 'r60'), 'input');
  const script = '#!/bin/sh\nnode api.mjs "$(($1 + 1))" &\nexec serve "$1"\n';
  const got = await agent('project.configure', { page: 'sh {tandem}/page.sh {port}', script, run: ['npm run build'], note: 'The page needs its api beside it.' }, 'r60');
  assert.ok(got.proposed);
  const ev = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.deepEqual([ev.kind, ev.path, ev.before, ev.note], ['setup', 'how it is run', undefined, 'The page needs its api beside it.']);
  assert.deepEqual(ev.after, { page: 'sh {tandem}/page.sh {port}', run: ['npm run build'], script });
  assert.ok(!existsSync(configFile) && !existsSync(pageScript), 'nothing is written until it is accepted');
  assert.equal(host.project.pageCommand(5210), undefined);

  await me('proposals.decide', { round: 'r60', accept: true });
  const kept = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual([kept.name, kept.test, kept.page, kept.run], ['Fixture', 'node --test', 'sh {tandem}/page.sh {port}', ['npm run build']], 'what it was run by before is kept with it');
  assert.equal(readFileSync(pageScript, 'utf8'), script);
  assert.equal(host.project.pageCommand(5210), `sh ${host.project.dirs.tandem}/page.sh 5210`);
  assert.deepEqual(host.events.since(0).at(-2)!.fields, ['page', 'run', 'script']);
  // Nothing of it is among the project's own files.
  assert.equal(JSON.parse(readFileSync(join(dir, 'tandem.json'), 'utf8')).page, undefined);
  assert.equal((await me('project.setup')).script, script);
  assert.deepEqual(await agent('project.configure', { run: ['npm run build'] }, 'r61'), { changed: false });

  // The person says it at once; an empty value takes a field away.
  await me('project.configure', { page: '', script: '', run: [] });
  assert.ok(!existsSync(pageScript));
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).page, undefined);
  assert.equal(host.project.pageCommand(5210), undefined);
});

test('the project\'s own server is called the way another device would: someone new, who keeps their cookies by name', async () => {
  await refused(agent('page.request', { path: '/api/me' }, 'r70'), 'unsupported');
  // A page, and a server standing where that page would be served from.
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/api/join' && req.method === 'POST') {
        const name = JSON.parse(body).name as string;
        res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': `who=${name}; Path=/; HttpOnly` });
        return void res.end(JSON.stringify({ joined: name, sent: req.headers['content-type'] }));
      }
      if (req.url === '/api/me') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ cookie: req.headers.cookie ?? null })); }
      if (req.url === '/old') { res.writeHead(302, { location: '/new' }); return void res.end(); }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such thing');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const was = process.env.TANDEM_PAGE_PORT;
  process.env.TANDEM_PAGE_PORT = String((server.address() as AddressInfo).port - 2000);
  await me('project.configure', { page: 'serve {port}' });
  try {
    await refused(agent('page.request', { path: 'http://elsewhere.example/' }, 'r70'), 'input');
    await refused(agent('page.request', { path: '//elsewhere.example/' }, 'r70'), 'input');
    await refused(agent('page.request', { path: '/api/me', method: 'CONNECT' }, 'r70'), 'input');
    assert.deepEqual(await agent('page.request', { path: '/api/me' }, 'r70'), { status: 200, type: 'application/json', as: 'visitor', body: '{"cookie":null}' });
    const joined = await agent('page.request', { path: '/api/join', body: { name: 'bob' }, as: 'bob' }, 'r70');
    assert.deepEqual([joined.status, JSON.parse(joined.body)], [201, { joined: 'bob', sent: 'application/json' }]);
    await agent('page.request', { path: '/api/join', body: { name: 'cas' }, as: 'cas' }, 'r70');
    // Each is their own device: bob is still bob, and someone without a name is no one.
    assert.equal((await agent('page.request', { path: '/api/me', as: 'bob' }, 'r70')).body, '{"cookie":"who=bob"}');
    assert.equal((await agent('page.request', { path: '/api/me', as: 'cas' }, 'r70')).body, '{"cookie":"who=cas"}');
    assert.equal((await agent('page.request', { path: '/api/me' }, 'r70')).body, '{"cookie":null}');
    assert.deepEqual(await agent('page.request', { path: '/old' }, 'r70'), { status: 302, type: '', as: 'visitor', location: '/new', body: '' });
    assert.equal((await agent('page.request', { path: '/nowhere' }, 'r70')).status, 404);
    // What changed something is kept, for the person to see; what only asked is not.
    const did = host.events.since(0).filter((e) => e.type === 'page.did');
    assert.deepEqual(did.map((e) => e.did), ['sent POST /api/join to the project\'s server as bob: 201', 'sent POST /api/join to the project\'s server as cas: 201']);
  } finally {
    server.close();
    if (was === undefined) delete process.env.TANDEM_PAGE_PORT; else process.env.TANDEM_PAGE_PORT = was;
    await me('project.configure', { page: '' });
  }
});

test('what the agent does with its tools is said in a few words, for the conversation', () => {
  const did = (name: string, input: Record<string, unknown>) => didWith(host, name, input);
  assert.equal(did('Read', { file_path: join(dir, 'src/main.js') }), 'read src/main.js');
  assert.equal(did('Read', { file_path: join(host.dirs.looks, 'page-1.jpg') }), 'looked at a picture');
  assert.equal(did('Grep', { pattern: 'shadow|Shadow', path: dir }), 'searched for "shadow|Shadow"');
  assert.equal(did('Grep', { pattern: 'bias', path: join(dir, 'src') }), 'searched for "bias" in src');
  assert.equal(did('Glob', { pattern: '**/*.glsl' }), 'looked for files like **/*.glsl');
  assert.equal(did('Edit', { file_path: join(dir, 'src/main.js') }), 'changed src/main.js');
  assert.equal(did('Write', { file_path: '/elsewhere/notes.txt' }), 'wrote /elsewhere/notes.txt');
  assert.equal(did('Bash', { command: 'npm   test\n' }), 'ran `npm test`');
  // A tandem command that only reads is said; one that changes something is said by what it changed.
  assert.equal(did('Bash', { command: 'tandem run concepts.list' }), 'ran concepts.list');
  assert.equal(did('Bash', { command: 'tandem run concepts.create \'{"name":"x"}\'' }), undefined);
  assert.equal(did('WebFetch', {}), 'used WebFetch');
  // What a tool answered: the end of what a command printed, the start of anything else.
  const many = Array.from({ length: 30 }, (_, n) => `line ${n + 1}`).join('\n');
  assert.equal(outOf('Bash', '# pass 3\n# fail 0\n\n'), '# pass 3\n# fail 0');
  assert.deepEqual(outOf('Bash', many).split('\n').slice(0, 2), ['… (6 lines before this)', 'line 7']);
  assert.deepEqual(outOf('Read', many).split('\n').slice(-2), ['line 24', '… (6 more lines)']);
  assert.equal(outOf('Read', [{ type: 'image' }, { type: 'text', text: 'and words' }]), '(a picture)\nand words');
  // A change to a file is said by its lines, not by the tool saying it went well.
  assert.equal(changeOf('Edit', { old_string: 'bias = -0.002', new_string: 'bias = -0.0002\nradius = 2' }), '-bias = -0.002\n+bias = -0.0002\n+radius = 2');
  assert.equal(changeOf('Write', { content: 'export const A = 1;' }), '+export const A = 1;');
  assert.equal(changeOf('Edit', { old_string: 'gone', new_string: '' }), '-gone');
  assert.equal(changeOf('Read', { file_path: 'x' }), undefined);
  assert.deepEqual(countOf('Edit', { old_string: 'bias = -0.002', new_string: 'bias = -0.0002\nradius = 2\n' }), { added: 2, removed: 1 });
  assert.deepEqual(countOf('Write', { content: 'a\nb\nc' }), { added: 3, removed: 0 });
  assert.equal(countOf('Read', { file_path: 'x' }), undefined);
});

test('in its working copy the agent may run the project\'s tests without tandem being told how', () => {
  const bare = mkdtempSync(join(tmpdir(), 'tandem-run-'));
  try {
    assert.deepEqual(runnable(loadProject(bare)), [], 'a folder that says nothing about itself');
    writeFileSync(join(bare, 'package.json'), '{"scripts":{"test":"node --test"}}');
    assert.deepEqual(runnable(loadProject(bare)), ['npm test', 'npm run test', 'node --test']);
    // What tandem was told comes first, and nothing is there twice.
    mkdirSync(join(bare, '.tandem'));
    writeFileSync(join(bare, '.tandem/tandem.json'), JSON.stringify({ test: 'npm test', check: 'npx tsc --noEmit', run: ['npm run build'] }));
    assert.deepEqual(runnable(loadProject(bare)), ['npm test', 'npx tsc --noEmit', 'npm run build', 'npm run test', 'node --test']);
  } finally { rmSync(bare, { recursive: true, force: true }); }
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

test('a proposed concept is the person\'s to change before deciding, they add their own to the round, and the agent hears what was accepted', async () => {
  await agent('concepts.create', { name: 'Ferns', text: 'Ferns like shade.' }, 'r80');
  await agent('concepts.create', { name: 'Moss', text: 'Moss grows on the wall.' }, 'r80');
  const idOf = async (path: string) => (await me('proposals.list', { status: 'pending' })).find((x: any) => x.path === path).id as string;
  const ferns = await idOf('ferns');

  // Only the person, only a concept that still waits, and only what a concept can be.
  await refused(agent('proposals.edit', { id: ferns, text: 'x' }), 'permission');
  await refused(agent('proposals.add', { round: 'r80', name: 'Ivy' }), 'permission');
  await refused(me('proposals.edit', { id: 'nothing', text: 'x' }), 'missing');
  await refused(me('proposals.edit', { id: ferns, name: ' ' }), 'input');
  await refused(me('proposals.edit', { id: ferns, stage: 'done' }), 'input');
  assert.deepEqual(await me('proposals.edit', { id: ferns, text: 'Ferns like shade.' }), { changed: false }, 'the same words are no change');

  const before = host.events.last();
  assert.deepEqual(await me('proposals.edit', { id: ferns, name: 'Tree ferns', text: 'Tree ferns like deep shade.' }), { changed: true });
  const shown = host.events.since(before).at(-1)!;
  assert.deepEqual([shown.type, shown.by, shown.id, shown.edited], ['proposal', AGENT, ferns, ['name', 'text']], 'the card is said again, with what the person changed');
  const kept = (await me('proposals.list', { status: 'pending' })).find((x: any) => x.id === ferns);
  assert.equal(kept.after.text, 'Tree ferns like deep shade.');
  assert.deepEqual(kept.proposed, { name: 'Ferns', text: 'Ferns like shade.' }, 'what the agent proposed is kept beside it');
  // Put back as it was proposed, it is the agent's again.
  await me('proposals.edit', { id: ferns, name: 'Ferns' });
  assert.deepEqual((await me('proposals.list', { status: 'pending' })).find((x: any) => x.id === ferns).proposed, { text: 'Ferns like shade.' });

  // A concept of their own goes into the same round, once.
  await refused(me('proposals.add', { round: 'r81', name: 'Ivy' }), 'missing');
  await refused(me('proposals.add', { round: 'r80', name: 'Moss' }), 'exists');
  const ivy = await me('proposals.add', { round: 'r80', name: 'Ivy', text: 'Ivy climbs.', links: [{ to: 'ferns', kind: 'leads-to' }] });
  assert.deepEqual([ivy.id, ivy.round], ['ivy', 'r80']);
  assert.equal(host.events.since(before).at(-1)!.by, 'me');
  await refused(me('concepts.get', { id: 'ivy' }), 'missing');

  // One piece accepted as it was proposed: the agent is told so.
  const told = () => host.events.since(before).filter((e) => e.type === 'message' && e.by === 'engine' && e.kind === 'accepted');
  await me('proposals.decide', { round: 'r80', accept: true, only: [await idOf('moss')] });
  assert.equal(told().length, 1);
  assert.match(String(told()[0].text), /accepted a concept from your proposal of round r80 \(2 of that round still wait\):\n- Moss \(moss\): as you proposed it\.\nThis is news/);
  assert.equal(told()[0].refs, undefined);

  // The rest as one: the concepts are as the person made them, and the agent hears which those are.
  await me('proposals.decide', { round: 'r80', accept: true });
  assert.deepEqual((({ name, text }) => [name, text])(await me('concepts.get', { id: 'ferns' })), ['Ferns', 'Tree ferns like deep shade.']);
  assert.deepEqual((({ text, stage, links }) => [text, stage, links])(await me('concepts.get', { id: 'ivy' })), ['Ivy climbs.', 'idea', [{ to: 'ferns', kind: 'leads-to' }]]);
  assert.equal(told().length, 2);
  const news = told()[1];
  assert.match(String(news.text), /accepted 2 concepts from your proposal of round r80:\n- Ferns \(ferns\): the person changed it before accepting: its text\.\n- Ivy \(ivy\): the person added it to the round themselves\.\nThe document has them as the person made them/);
  assert.deepEqual(news.refs, ['concept:ferns', 'concept:ivy'], 'what they made of it goes along');
  assert.equal(news.changed, 2);

  // A change to a concept that is there: a field the agent left alone can be changed too, and says what it was.
  await agent('concepts.update', { id: 'moss', text: 'Moss grows on the north wall.' }, 'r82');
  const moss = await idOf('moss');
  await me('proposals.edit', { id: moss, stage: 'design' });
  const p = (await me('proposals.list', { status: 'pending' })).find((x: any) => x.id === moss);
  assert.deepEqual([p.before, p.after, p.proposed], [{ text: 'Moss grows on the wall.', stage: 'idea' }, { text: 'Moss grows on the north wall.', stage: 'design' }, { stage: null }]);
  // What the agent proposes for it after that is what stands there.
  await agent('concepts.update', { id: 'moss', stage: 'build' }, 'r82');
  assert.equal((await me('proposals.list', { status: 'pending' })).find((x: any) => x.id === moss).proposed, undefined);
  // Nothing is told about what is refused.
  await me('proposals.decide', { round: 'r82', accept: false });
  assert.equal(told().length, 2);
  for (const id of ['ferns', 'moss', 'ivy']) await me('concepts.remove', { id });
});

test('what must not happen in the middle of a command waits until none is running', async () => {
  const registry = createRegistry();
  let finish!: () => void;
  registry.add({ name: 'slow.thing', kind: 'write', about: 'Something that takes a while, like an install.', run: () => new Promise<void>((done) => { finish = done; }) });
  let idle = false;
  await registry.idle().then(() => { idle = true; });
  assert.ok(idle, 'with nothing running it is at once');
  idle = false;
  const one = registry.run('slow.thing', {}, { by: 'me' });
  void registry.idle().then(() => { idle = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([idle, registry.running()], [false, 1]);
  finish();
  await one;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([idle, registry.running()], [true, 0]);
});

test('a decision the core was cut off in the middle of is said when it starts again', async () => {
  const fx = await fixture({ code: false });
  try {
    await fx.host.run('concepts.create', { name: 'Willows' }, AGENT, 'r1');
    await fx.host.run('concepts.create', { name: 'Alders' }, AGENT, 'r1');
    await fx.host.run('concepts.create', { name: 'Birches' }, AGENT, 'r2');
    await fx.host.run('proposals.decide', { round: 'r2', accept: false }, 'me');
    // Marked, and then nothing: the core went down before it said so.
    const [willows] = fx.host.proposals.decide('r1', 'accepted', [fx.host.proposals.list({ round: 'r1' })[0].id]);
    const before = fx.host.events.last();
    const again = await createHost({ project: fx.dir, code: null });
    const said = again.events.since(before);
    assert.deepEqual(said.map((e) => [e.type, e.by, e.round, e.status, e.ids, e.left]), [['proposal.decided', 'engine', 'r1', 'accepted', [willows.id], 1]], 'only what the log had not said');
    assert.equal((await createHost({ project: fx.dir, code: null })).events.last(), again.events.last(), 'and it is said once');
  } finally { fx.cleanup(); }
});
