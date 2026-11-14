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
import { CommandError } from '../core/commands.ts';
import { loadProject } from '../core/project.ts';
import { didWith, runnable } from '../core/runner.ts';
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
