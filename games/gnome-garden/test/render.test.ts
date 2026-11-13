import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/sim/game.ts';
import { ZOOM, createScene } from '../src/render/scene.ts';
import { FB, frame, hex, text } from '../src/render/fb.ts';
import { FLOWER, GNOME, VISITOR } from '../src/render/sprites.ts';
import { FLOWERS, VISITORS } from '../src/sim/content.ts';
import { WORLD_H } from '../src/sim/world.ts';

test('blit clips at every edge and flips', () => {
  const fb = new FB(8, 8);
  const f = frame(['ab', 'cd'], { a: hex('#ff0000'), b: hex('#00ff00'), c: hex('#0000ff'), d: hex('#ffffff') });
  for (const [x, y] of [[-1, -1], [7, 7], [3, 3], [-5, 2], [9, 9]]) fb.blit(f, x, y);
  assert.equal(fb.get(0, 0), hex('#ffffff'));
  assert.equal(fb.get(7, 7), hex('#ff0000'));
  fb.blit(f, 3, 3, true);
  assert.equal(fb.get(3, 3), hex('#00ff00'));
  text(fb, 'A1+', -2, -2, hex('#ffffff'));
});

test('there is a sprite for everything the game can show', () => {
  assert.equal(FLOWER.length, FLOWERS.length);
  assert.equal(VISITOR.length, VISITORS.length);
  assert.ok(GNOME.length >= 5 + VISITORS.length, 'a look for every visitor who stays');
  for (const looks of GNOME) assert.equal(looks.length, 3);
});

test('the garden renders at every stage, by day and by night, at any width', () => {
  for (const width of [288, 301, 420]) {
    const scene = createScene(width, WORLD_H * ZOOM);
    const g = createGame(undefined, { seed: 2, quiet: true });
    scene.render(g, 1);
    assert.ok(scene.fb.px.every((c) => c >>> 24 === 255), 'every pixel is opaque');
    g.s.blooms = 1e15; g.s.teeth = 1e9; g.s.whispers = 1e9;
    Object.assign(g.s.flags, { gnomes: 1, dig: 1, lantern: 1, choir: 1, rites: 1, teeth: 1, moveByDay: 1, nightSoon: 1, plots: 1 });
    g.buyGnome('gardener', 400); g.buyGnome('digger', 200); g.buyGnome('lantern', 60); g.buyGnome('choir', 500);
    for (let i = 0; i < 44; i++) g.buyPlot();
    for (let seed = 0; seed < 8; seed++) g.buySeed();
    for (const [depth, peace] of [[5, 80], [25, 45], [70, 12], [100, 2]]) {
      g.s.depth = depth; g.s.peaceCap = peace; g.s.peace = peace; g.s.seed = Math.min(8, Math.floor(depth / 12));
      if (depth >= 60) g.s.flags.hatTip = 1;
      if (depth >= 32) g.s.flags.breath = 1;
      for (let i = 0; i < 300; i++) { g.step(0.1); if (i % 30 === 0) g.tap(90, 100); g.events.length = 0; }
      for (let t = 0; t < 3; t += 0.37) scene.render(g, 10 + t);
      assert.ok(scene.fb.px.every((c) => c >>> 24 === 255));
    }
    g.s.flags.unearth = 1;
    assert.ok(g.unearth());
    for (let i = 0; i < 160; i++) { g.step(0.1); scene.render(g, 30 + i * 0.1); g.events.length = 0; }
    assert.equal(g.s.runs, 1);
  }
});
