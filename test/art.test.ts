// Drawing inside tandem: sprites straight from a drawing's text, and a drawing
// worker's whole round trip: asked, silhouette, approval, colour, accepted
// into the project. The worker here is a stand-in for
// claude that uses the real tools of its workspace.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError } from '../core/commands.ts';
import { createHost } from '../core/host.ts';
import { startServer } from '../core/server.ts';
import { exportArt } from '../art/export.ts';
import { spriteSheet } from '../art/sprites.ts';
import { tools } from '../core/runner.ts';
import { AGENT, fixture } from './helpers.ts';

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
// Without a working copy: a drawing taken into the project is built straight in.
const { host, dir, cleanup } = await fixture({ code: false });
// The worker's tools report to the core over HTTP, so there has to be one.
const s = await startServer({ port: 0, host, agent: false });
process.env.TANDEM_PORT = String(s.port);
after(async () => { await s.close(); cleanup(); });

const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;
const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);
async function until(what: () => unknown, says: string, ms = 90000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for ${says}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const rounds = (worker: string) => host.events.since(0).filter((e) => e.type === 'art.round' && e.worker === worker);
// What is only told, not kept: a worker's status and the drawing as it is typed.
const told: any[] = [];
host.events.subscribe((e) => { if (e.n === 0) told.push(e); });

test('a drawing\'s text becomes a sheet of frames, per look, with its depth', () => {
  const sheet = spriteSheet('blob',
    'a = #ff0000\nb = #00ff00\n\n@size 2 2\n@recolor red\n@recolor green a=#00ff00\n=== idle\n--- 200\naa\naa\n---\nab\nba\n=== hop\nbb\n..\n',
    '3 = #5a6988\n\n@size 2 2\n=== idle\n33\n33\n');
  assert.deepEqual([sheet.width, sheet.height, sheet.sheetW, sheet.sheetH], [2, 2, 8, 5]);
  assert.deepEqual(sheet.looks.red, { idle: [[0, 0, 200], [3, 0, 150]], hop: [[6, 0, 150]] });
  assert.deepEqual(Object.keys(sheet.looks), ['red', 'green']);
  const at = (rgba: Uint8ClampedArray, x: number, y: number) => [...rgba.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
  assert.deepEqual(at(sheet.rgba, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(sheet.rgba, 0, 3), [0, 255, 0, 255], 'the green look, a row down');
  assert.deepEqual(at(sheet.rgba, 6, 1), [0, 0, 0, 0], 'nothing drawn there');
  assert.deepEqual(at(sheet.depthRgba!, 3, 0), [0x5a, 0x69, 0x88, 255], 'a frame the depth map lacks gets its first');
  assert.throws(() => spriteSheet('hat', 'a = #ff0000\n\n@base body\n@slot head\n@size 2 2\naa\n'), /attachment of body/);
});

test('a worker draws a new drawing: silhouette, approval, colour, and only then the game', async () => {
  const asked = await agent('art.ask', { name: 'garden-sign', message: 'a wooden sign for the gate', new: true });
  const w = asked.worker as string;
  assert.match(w, /^w[a-z0-9]+$/);
  assert.equal((await me('art.workers'))[0].state, 'running');
  await refused(me('art.tell', { worker: w, message: 'hurry' }), 'busy');

  // Round one ends with a silhouette to approve.
  await until(() => rounds(w).length === 1, 'the silhouette');
  const first = host.events.since(0).filter((e) => e.type === 'proposal' && e.round === w).at(-1)!;
  assert.deepEqual([first.kind, first.path, first.phase, first.isNew, first.worker], ['drawing', 'garden-sign', 'silhouette', true, w]);
  assert.match((first.pictures as any).after, /^\/api\/file\/looks\//);
  assert.equal((first.pictures as any).before, undefined, 'a new drawing has no before');
  assert.match(String(first.note), /Blocked out garden-sign\. Render ok, events ok\./, 'it rendered and reported with the tools of its workspace');
  assert.match(String(first.note), /Tools: Write\(art\/garden-sign\.txt\)\.$/, 'and may write only the drawing it was asked for');
  assert.deepEqual((await me('art.workers')).map((x: any) => [x.drawing, x.state, x.phase]), [['garden-sign', 'waiting', 'silhouette']]);
  assert.ok(!existsSync(join(dir, 'art/garden-sign.txt')), 'nothing is in the game yet');

  // While it drew, the drawing was told as it was typed: first a part of it, then all of it.
  const drafts = told.filter((e) => e.type === 'art.draft' && e.worker === w);
  assert.ok(drafts.length >= 2, 'more than one version came by');
  assert.equal(drafts[0].name, 'garden-sign');
  assert.ok(drafts[0].text.length < drafts.at(-1).text.length && drafts.at(-1).text.startsWith(drafts[0].text.slice(0, 40)));
  assert.match(drafts.at(-1).text, /@rect 3 1 2 2 4\n$/);
  assert.ok(told.some((e) => e.type === 'art.status' && e.worker === w && e.doing === 'round: round 1: block it out'), 'and what it reported about its round');
  // Its own copy can be read as text, to show where it is.
  assert.match((await me('art.get', { name: 'garden-sign', worker: w })).text, /^3 = #5a6988/);

  // The agent is told that the round ended, and what it can do with it: judging it is the agent's.
  const news = () => host.events.since(0).filter((e) => e.type === 'message' && e.by === 'engine' && e.kind === 'art' && e.worker === w);
  assert.equal(news().length, 1);
  assert.deepEqual([news()[0].name, news()[0].state, news()[0].phase], ['garden-sign', 'waiting', 'silhouette']);
  assert.match(String(news()[0].text), new RegExp(`^The drawing worker ${w}, on garden-sign, has a silhouette ready, and waits for it to be approved\\. It says: "Blocked out garden-sign\\..*That was round 1 of its work\\. Judging it is yours.*art\\.look with worker "${w}".*Then: art\\.approve when the shape is right`));

  // A silhouette is not a drawing: it cannot be accepted, only approved.
  await refused(agent('art.accept', { worker: w }), 'input');
  // (And it is not the person's to decide: what a worker proposed is not part of what waits for them.)
  await refused(me('proposals.decide', { accept: true }), 'missing');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1, 'and refusing that left the proposal as it was');
  await agent('art.approve', { worker: w });
  await until(() => rounds(w).length === 2, 'the colour round');
  const second = host.events.since(0).filter((e) => e.type === 'proposal' && e.round === w).at(-1)!;
  assert.equal(second.id, first.id, 'the same proposal, moved on');
  assert.equal(second.phase, 'color');
  assert.match(String(second.note), /Coloured garden-sign\..*Depth kept: true/, 'the approved silhouette was kept as its depth map');
  await refused(me('art.approve', { worker: w }), 'busy');
  assert.equal(news().length, 2);
  assert.match(String(news()[1].text), /has the drawing ready in colour, and waits for it to be taken into the project\..*That was round 2 of its work\..*Then: art\.accept when it is what was asked for/);

  // The worker's version can be looked at before deciding. The agent's look is shown in the chat; the person's own is not news.
  const n = host.events.last();
  const look = await me('art.look', { name: 'garden-sign', worker: w });
  assert.equal(readFileSync(look.file).subarray(1, 4).toString(), 'PNG');
  assert.equal(host.events.last(), n);
  await agent('art.look', { name: 'garden-sign', worker: w });
  assert.equal(host.events.since(n)[0].type, 'look');

  // Taken by the agent: the drawing and its depth map are the game's, the game is built with it, the worker is gone.
  // A drawing the person locked meanwhile is not the agent's to take.
  await me('locks.set', { ref: 'drawing:garden-sign', locked: true });
  await refused(agent('art.accept', { worker: w }), 'locked');
  await me('locks.set', { ref: 'drawing:garden-sign', locked: false });
  const taken = await agent('art.accept', { worker: w });
  assert.deepEqual(taken.accepted, ['garden-sign']);
  assert.match(taken.says, /in the project now, and built into it/);
  const decided = host.events.since(0).filter((e) => e.type === 'proposal.decided' && e.round === w).at(-1)!;
  assert.deepEqual([decided.by, decided.status, decided.count, decided.left], [AGENT, 'accepted', 1, 0]);
  await refused(agent('art.accept', { worker: w }), 'missing');
  assert.match(readFileSync(join(dir, 'art/garden-sign.txt'), 'utf8'), /^r = #d5392f/);
  assert.match(readFileSync(join(dir, 'depth/garden-sign.txt'), 'utf8'), /^3 = #5a6988/);
  assert.ok(JSON.parse(readFileSync(join(dir, 'built.json'), 'utf8')).includes('garden-sign'), 'the project\'s own build of its drawings was run');
  assert.deepEqual(await me('art.workers'), []);
  assert.ok(!existsSync(join(dir, '.tandem/data/art-work', w)));
  assert.deepEqual((await me('art.list')).find((d: any) => d.name === 'garden-sign').depth, true);
});

test('feedback on a drawing there is: a round, more feedback, and a rejection that leaves it alone', async () => {
  const before = (await me('art.get', { name: 'gnome' })).text as string;
  const w = (await me('art.ask', { name: 'gnome', message: 'a taller hat' })).worker as string;
  await until(() => rounds(w).length === 1, 'the round');
  const p = host.events.since(0).filter((e) => e.type === 'proposal' && e.round === w).at(-1)!;
  assert.deepEqual([p.phase, p.isNew], ['color', false]);
  assert.ok((p.pictures as any).before && (p.pictures as any).after, 'a picture of it as it is and as proposed');
  await me('art.tell', { worker: w, message: 'taller still' });
  await until(() => rounds(w).length === 2, 'the second round');
  const pending = await me('proposals.list', { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].after.text.match(/@rect 0 0 1 1/g).length, 2, 'the second round built on the first');
  await agent('art.close', { worker: w });
  assert.equal((await me('art.get', { name: 'gnome' })).text, before);
  assert.deepEqual(await me('art.workers'), []);
});

test('a drawing with looks is pictured look by look, so a change in one of them shows', async () => {
  // The gnome has three looks. A proposal that changes one colour of one of them:
  const gnome = (await me('art.get', { name: 'gnome' })).text as string;
  const line = gnome.split('\n').find((l) => l.startsWith('@recolor hollow'))!;
  const changed = gnome.replace(line, `${line.replace(/(\S)=#[0-9a-f]{6}/, '$1=#ff00ff')}`);
  assert.notEqual(changed, gnome);
  await agent('art.set', { name: 'gnome', text: changed, note: 'hollow, but pinker' }, 'r30');
  const p = host.events.since(0).at(-1)!;
  const pics = p.pictures as { before: string; after: string; looks: { look: string; before?: string; after?: string }[] };
  assert.deepEqual(pics.looks.map((l) => l.look), ['cozy', 'odd', 'hollow']);
  const bytes = (url: string) => readFileSync(join(dir, '.tandem/data/looks', url.split('/').pop()!));
  assert.ok(pics.looks.every((l) => l.before && l.after));
  assert.ok(bytes(pics.looks[0].before!).equals(bytes(pics.looks[0].after!)), 'cozy is as it was');
  assert.ok(bytes(pics.looks[1].before!).equals(bytes(pics.looks[1].after!)), 'and so is odd');
  assert.ok(!bytes(pics.looks[2].before!).equals(bytes(pics.looks[2].after!)), 'hollow is where the change is, and it shows');
  assert.ok(bytes(pics.before).equals(bytes(pics.after)), 'which the plain picture alone would have hidden');

  // A look that is new has no before.
  await agent('art.set', { name: 'gnome', text: gnome.replace(line, `${line}\n@recolor frosty s=#ffffff`) }, 'r30');
  const again = host.events.since(0).at(-1)!.pictures as typeof pics;
  assert.deepEqual(again.looks.map((l) => [l.look, !!l.before, !!l.after]), [['cozy', true, true], ['odd', true, true], ['hollow', true, true], ['frosty', false, true]]);
  await me('proposals.decide', { accept: false });
});

test('a worker that fails says so, and a worker can be stopped', async () => {
  const w = (await me('art.ask', { name: 'gnome', message: 'make it fail' })).worker as string;
  await until(() => rounds(w).length === 1, 'the failure');
  assert.equal(rounds(w)[0].state, 'failed');
  const news = host.events.since(0).filter((e) => e.type === 'message' && e.by === 'engine' && e.kind === 'art' && e.worker === w);
  assert.match(String(news[0].text), /on gnome, failed: the pencil broke\. That was round 1 of its work\. Judging it is yours, from start to finish: the person is not asked and has no buttons for it\. art\.tell sets it going again/);
  await refused(agent('art.accept', { worker: w }), 'missing');
  assert.match(String(rounds(w)[0].text), /The worker failed: the pencil broke/);
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0);
  assert.equal((await me('art.stop', { worker: w })).stopped, false, 'it is not running any more');
  await refused(me('art.stop', { worker: 'w-nobody' }), 'missing');
  // A worker nobody wants any more is closed, and is gone.
  assert.equal((await me('art.workers')).length, 1);
  assert.deepEqual(await agent('art.close', { worker: w }), { closed: true });
  assert.deepEqual(await me('art.workers'), []);
});

test('a worker that was drawing when tandem was started again goes on when it is up; one stopped by hand does not', async () => {
  const fx = await fixture({ code: false });
  const one = await startServer({ port: 0, host: fx.host, agent: false });
  const ask = async (name: string) => ((await fx.host.run('art.ask', { name, message: 'a taller hat' }, 'me')) as { worker: string }).worker;
  const w = await ask('gnome');
  await until(() => fx.host.art.workers.get(w)?.session, 'the conversation it draws in');
  await new Promise((r) => setTimeout(r, 5));
  const byHand = await ask('garden-icons');
  assert.deepEqual(await fx.host.run('art.stop', { worker: byHand }, 'me'), { stopped: true });
  // The engine stops in the middle of its run (a change was accepted, and tandem starts again).
  await one.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fx.host.events.since(0).filter((e) => e.type === 'art.round' && e.worker === w).length, 0, 'nothing is said to have ended');
  const up = await createHost({ project: fx.dir, code: null });
  const two = await startServer({ port: 0, host: up, agent: false });
  const cut = up.art.workers.get(w)!;
  assert.deepEqual([cut.state, cut.session, /a taller hat/.test(cut.asked ?? '')], ['running', 'sess-1', true]);
  // It goes on by itself, and its round ends as any other: a proposal, and the agent is told.
  const round = () => up.events.since(0).find((e) => e.type === 'art.round' && e.worker === w);
  await until(round, 'the round it was cut off in');
  assert.deepEqual([round()!.state, up.art.workers.get(w)!.state, up.art.workers.get(w)!.asked], ['waiting', 'waiting', undefined]);
  assert.equal(((await up.run('proposals.list', { status: 'pending' }, 'me')) as { round: string }[]).filter((p) => p.round === w).length, 1);
  assert.ok(up.events.since(0).some((e) => e.type === 'message' && e.by === 'engine' && e.kind === 'art' && e.worker === w), 'the agent hears of it');
  assert.deepEqual([up.art.workers.get(byHand)!.state, up.art.workers.busy(byHand)], ['stopped', false]);
  await two.close();
  fx.cleanup();
});

test('tandem exports a project\'s drawings as sheets it can load: looks, animations, depth, tiles, characters', () => {
  const root = mkdtempSync(join(tmpdir(), 'tandem-export-'));
  try {
    const put = (path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
    put('art/blob.txt', 'a = #ff0000\nb = #00ff00\n\n@size 2 2\n@recolor red\n@recolor green a=#00ff00\n=== idle\n--- 200\naa\naa\n---\nab\nb.\n=== hop\nbb\n..\n');
    put('depth/blob.txt', '3 = #5a6988\n\n@size 2 2\n=== idle\n33\n33\n');
    put('art/wall.txt', 'a = #888888\n\n@size 4 2\n@tiles 2 2\n@tile left 0 0\n@tile right 1 0\n@strip row h left right -\naaaa\naaaa\n');
    put('art/body.txt', 'a = #0000ff\n\n@size 2 2\naa\naa\n');
    put('art/hat.txt', 'a = #ff0000\n\n@base body\n@slot head\n@size 2 2\naa\n..\n');
    put('art/broken.txt', 'this is not a drawing\n@size\n');

    // From the command line, in the project, the way its build is run.
    const said = execFileSync(fileURLToPath(new URL('../bin/tandem', import.meta.url)), ['export', 'public/sprites', '--runtime=src/pixeldraw.js'], { cwd: root, encoding: 'utf8' });
    assert.match(said, /left out: broken \(/);
    assert.match(said, /the runtime that draws a character is src\/pixeldraw\.js\n3 drawings exported to public\/sprites: blob, body, wall\n$/);
    const index = JSON.parse(readFileSync(join(root, 'public/sprites/sprites.json'), 'utf8'));
    assert.deepEqual(Object.keys(index), ['blob', 'body', 'wall'], 'an attachment has no sheet of its own');
    assert.deepEqual(index.blob, { image: 'blob.png', depth: 'blob.depth.png', width: 2, height: 2, looks: { red: { idle: [[0, 0, 200], [3, 0, 150]], hop: [[6, 0, 150]] }, green: { idle: [[0, 3, 200], [3, 3, 150]], hop: [[6, 3, 150]] } } });
    assert.deepEqual([index.wall.tiles, index.wall.strips], [{ left: [0, 0, 2, 2], right: [2, 0, 2, 2] }, { row: { dir: 'h', start: 'left', middle: 'right', end: null } }]);
    assert.deepEqual([index.body.character, index.body.attachments], ['body.character.json', ['hat']]);
    const character = JSON.parse(readFileSync(join(root, 'public/sprites/body.character.json'), 'utf8'));
    assert.deepEqual([character.format, character.image, Object.keys(character.layers)], ['pixeldraw-character', 'body.character.png', ['body', 'hat']]);
    assert.match(readFileSync(join(root, 'src/pixeldraw.js'), 'utf8'), /export class Character/);
    // The sheet is a picture with nothing where nothing is drawn.
    const png = readFileSync(join(root, 'public/sprites/blob.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [8, 5, 6], 'eight by five, with alpha');
    for (const f of ['blob.depth.png', 'body.png', 'body.character.png', 'wall.png']) assert.ok(existsSync(join(root, 'public/sprites', f)), f);

    // A drawing that is gone takes its files with it; one that is not the project's to load into is refused.
    rmSync(join(root, 'art/blob.txt'));
    rmSync(join(root, 'art/hat.txt'));
    assert.deepEqual(exportArt(root, 'public/sprites').drawings, ['body', 'wall']);
    for (const f of ['blob.png', 'blob.depth.png', 'body.character.json', 'body.character.png']) assert.ok(!existsSync(join(root, 'public/sprites', f)), `${f} is gone`);
    assert.ok(existsSync(join(root, 'public/sprites/body.png')));
    for (const bad of ['../elsewhere', '/tmp/elsewhere', 'art/out', '.tandem/sprites', '.']) assert.throws(() => exportArt(root, bad), /goes in the project|not a place/);
    assert.throws(() => exportArt(root, 'public/sprites', '../pixeldraw.js'), /goes in the project/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an agent that codes may run tandem\'s export in its working copy', async () => {
  const fx = await fixture();
  try { assert.ok(tools(fx.host).allow.includes('Bash(tandem export:*)')); } finally { fx.cleanup(); }
  assert.ok(!tools(host).allow.includes('Bash(tandem export:*)'), 'one without a working copy has nowhere to write them');
});
