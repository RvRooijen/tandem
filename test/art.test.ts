// Drawing inside the engine: the game's sprites built straight from the
// drawings' text, and a drawing worker's whole round trip: asked, silhouette,
// approval, colour, accepted into the game. The worker here is a stand-in for
// claude that uses the real tools of its workspace.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError } from '../core/commands.ts';
import { ROOT } from '../core/host.ts';
import { startServer } from '../core/server.ts';
import { spriteSheet } from '../art/sprites.ts';
import { AGENT, scratchHost } from './helpers.ts';

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const { host, dir, cleanup } = await scratchHost();
// The worker's tools report to the core over HTTP, so there has to be one.
const s = await startServer({ port: 0, host, agent: false });
process.env.TANDEM_PORT = String(s.port);
after(async () => { await s.close(); cleanup(); });

const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>, round = 'r1') => host.run(name, input, AGENT, round) as Promise<any>;
const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);
async function until(what: () => unknown, says: string, ms = 20000) {
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

test('the game\'s sprites are what its drawings build to', () => {
  // If this fails a drawing was changed by hand without building: run `npm run art`.
  const out = join(dir, 'check.gen.ts');
  execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'games/gnome-garden/tools/import-art.ts'), `--out=${out}`]);
  assert.equal(readFileSync(out, 'utf8'), readFileSync(join(ROOT, 'games/gnome-garden/src/render/art.gen.ts'), 'utf8'));
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
  assert.ok(!existsSync(join(dir, 'game/art/garden-sign.txt')), 'nothing is in the game yet');

  // While it drew, the drawing was told as it was typed: first a part of it, then all of it.
  const drafts = told.filter((e) => e.type === 'art.draft' && e.worker === w);
  assert.ok(drafts.length >= 2, 'more than one version came by');
  assert.equal(drafts[0].name, 'garden-sign');
  assert.ok(drafts[0].text.length < drafts.at(-1).text.length && drafts.at(-1).text.startsWith(drafts[0].text.slice(0, 40)));
  assert.match(drafts.at(-1).text, /@rect 3 1 2 2 4\n$/);
  assert.ok(told.some((e) => e.type === 'art.status' && e.worker === w && e.doing === 'round: round 1: block it out'), 'and what it reported about its round');
  // Its own copy can be read as text, to show where it is.
  assert.match((await me('art.get', { name: 'garden-sign', worker: w })).text, /^3 = #5a6988/);

  // A silhouette is not a drawing: it cannot be accepted, only approved.
  await refused(me('proposals.decide', { round: w, accept: true }), 'input');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1, 'and refusing that left the proposal as it was');
  await agent('art.approve', { worker: w });
  await until(() => rounds(w).length === 2, 'the colour round');
  const second = host.events.since(0).filter((e) => e.type === 'proposal' && e.round === w).at(-1)!;
  assert.equal(second.id, first.id, 'the same proposal, moved on');
  assert.equal(second.phase, 'color');
  assert.match(String(second.note), /Coloured garden-sign\..*Depth kept: true/, 'the approved silhouette was kept as its depth map');
  await refused(me('art.approve', { worker: w }), 'busy');

  // The worker's version can be looked at before deciding. The agent's look is shown in the chat; the person's own is not news.
  const n = host.events.last();
  const look = await me('art.look', { name: 'garden-sign', worker: w });
  assert.equal(readFileSync(look.file).subarray(1, 4).toString(), 'PNG');
  assert.equal(host.events.last(), n);
  await agent('art.look', { name: 'garden-sign', worker: w });
  assert.equal(host.events.since(n)[0].type, 'look');

  // Accepted: the drawing and its depth map are the game's, the game is built with it, the worker is gone.
  await me('proposals.decide', { round: w, accept: true });
  assert.match(readFileSync(join(dir, 'game/art/garden-sign.txt'), 'utf8'), /^r = #d5392f/);
  assert.match(readFileSync(join(dir, 'game/depth/garden-sign.txt'), 'utf8'), /^3 = #5a6988/);
  const built = readFileSync(join(dir, 'data/art.gen.ts'), 'utf8');
  assert.match(built, /"garden-sign": \{"w":8,"h":8,"cpp":1,"pal":\["#f2c9a0","#d5392f"\]/);
  assert.match(built, /"depth":\{"default":\{"main":\["/);
  assert.deepEqual(await me('art.workers'), []);
  assert.ok(!existsSync(join(dir, 'data/art-work', w)));
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
  await me('proposals.decide', { round: w, accept: false });
  assert.equal((await me('art.get', { name: 'gnome' })).text, before);
  assert.deepEqual(await me('art.workers'), []);
});

test('a worker that fails says so, and a worker can be stopped', async () => {
  const w = (await me('art.ask', { name: 'gnome', message: 'make it fail' })).worker as string;
  await until(() => rounds(w).length === 1, 'the failure');
  assert.equal(rounds(w)[0].state, 'failed');
  assert.match(String(rounds(w)[0].text), /The worker failed: the pencil broke/);
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0);
  assert.equal((await me('art.stop', { worker: w })).stopped, false, 'it is not running any more');
  await refused(me('art.stop', { worker: 'w-nobody' }), 'missing');
  // A worker nobody wants any more is closed, and is gone.
  assert.equal((await me('art.workers')).length, 1);
  assert.deepEqual(await agent('art.close', { worker: w }), { closed: true });
  assert.deepEqual(await me('art.workers'), []);
});
