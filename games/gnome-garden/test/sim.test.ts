import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryDiagnostics } from 'archetype-ecs';
import { createGame } from '../src/sim/game.ts';
import { CRITTER, Critter, Flower, Gnome, Pos, ST } from '../src/sim/components.ts';
import { ABILITIES, BEATS, FLOWERS, GNOMES, HEIRLOOMS, TASKS, UPGRADES, priceAt, upgradePrice } from '../src/sim/content.ts';
import { derive, hatsFor, metreEffort, plotCost } from '../src/sim/economy.ts';
import { newState } from '../src/sim/state.ts';
import { PLOTS } from '../src/sim/world.ts';

const quiet = { seed: 1, quiet: true };

function run(g: ReturnType<typeof createGame>, seconds: number, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += 0.1) { g.step(0.1); each?.(t); g.events.length = 0; }
}

/** Tap every plot: picks whatever is ripe. */
function pickAll(g: ReturnType<typeof createGame>) {
  for (let p = 0; p < g.s.plots; p++) g.tap(PLOTS[p].x, PLOTS[p].y - 3);
}

test('every query compiles to a kernel', () => {
  createGame(undefined, quiet);
  assert.equal(queryDiagnostics.allCompiled(), true, queryDiagnostics.format());
});

test('a new garden has four beds and a first diary line', () => {
  const g = createGame(undefined, quiet);
  assert.equal(g.em.count([Flower]), 4);
  assert.equal(g.em.count([Gnome]), 0);
  assert.match(g.s.log[0].text, /Moved in/);
});

test('flowers ripen and can be picked by hand', () => {
  const g = createGame(undefined, quiet);
  run(g, 6);
  pickAll(g);
  // Four in a row: each one in the streak is worth 8% more than the last.
  assert.ok(Math.abs(g.s.blooms - (1 + 1.08 + 1.16 + 1.24)) < 1e-9, String(g.s.blooms));
  assert.equal(g.s.stats.tapped, 4);
  assert.equal(g.combo, 4);
  const had = g.s.blooms;
  pickAll(g);
  assert.equal(g.s.blooms, had, 'a picked flower has to grow back first');
  run(g, 2);
  assert.equal(g.combo, 0, 'a pause ends the streak');
});


/** Where every gnome stands. */
function places(g: ReturnType<typeof createGame>): number[] {
  const out: number[] = [];
  g.em.forEachArchetype([Pos, Gnome], (_ids, n, field) => { for (let i = 0; i < n; i++) out.push(field(Pos.x)[i], field(Pos.y)[i]); });
  return out;
}

test('to begin with gnomes are ornaments, and the nights are slept through', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1000;
  g.s.flags.gnomes = 1;
  assert.equal(g.buyGnome('gardener', 3), 3);
  assert.ok(g.D.charm > 1, 'each one makes the flowers worth more');
  const before = places(g);
  let slept = 0, nights = 0, wasAsleep = false;
  run(g, 90, () => {
    if (g.asleep) { slept += 0.1; assert.equal(g.blind, true); assert.equal(g.tap(60, 100), 'none', 'sound asleep'); }
    if (g.asleep && !wasAsleep) nights++;
    wasAsleep = g.asleep;
  });
  assert.ok(nights >= 2, 'night falls by itself');
  assert.ok(slept / nights < 7, `a slept night is short: ${(slept / nights).toFixed(1)}s`);
  assert.deepEqual(places(g), before, 'and nobody has moved, night or day');
  assert.equal(g.s.stats.delivered, 0);
  assert.ok(!g.s.flags.stir);
});

test('then the mornings start bringing flowers, and still nobody is seen to move', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1000;
  g.s.flags.gnomes = 1;
  g.buyGnome('gardener', 4);
  g.s.clock = 400;
  run(g, 1);
  assert.ok(g.s.flags.stir, 'a few minutes in, with three gnomes');
  const home = places(g);
  let seenMoving = 0, mornings = 0, notHome = 0, strides = 0;
  run(g, 120, () => {
    // Anything short of fully shut eyes counts as seeing: the lids come down before they stir and open after.
    if (g.lids < 1 && !g.frozen) seenMoving++;
    if (g.lids < 1 && !g.statues) strides++;
    for (const e of g.events) if (e.type === 'morning') { mornings++; if (JSON.stringify(places(g)) !== JSON.stringify(home)) notHome++; }
  });
  assert.equal(seenMoving, 0, 'whenever the garden can be seen, even through closing eyes, they are still');
  assert.equal(strides, 0, 'and they are drawn standing, not in mid-stride');
  assert.equal(notHome, 0, 'early on every one of them is back in its place by morning');
  assert.ok(g.s.stats.delivered > 0, 'flowers reach the doorstep overnight');
  assert.ok(g.s.flags.nightWork);
  assert.ok(mornings >= 2);
});


test('later a noise wakes you; later still you watch all night; in the end they move by day', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1e6;
  Object.assign(g.s.flags, { gnomes: 1, stir: 1, nightSoon: 1 });
  g.buyGnome('gardener', 10);
  const toNight = () => { for (let i = 0; i < 600 && g.dark < 1; i++) g.step(0.1); g.events.length = 0; };

  // Restless: a tap in the night wakes you, and they are caught where they stand.
  g.s.flags.restless = 1;
  toNight();
  run(g, 1);
  assert.equal(g.asleep, true);
  assert.equal(g.tap(60, 100), 'wake');
  g.step(0.1);
  assert.equal(g.asleep, false);
  assert.equal(g.blind, false);
  assert.equal(g.frozen, true, 'statues, in the moonlight');
  assert.ok(g.s.stats.caught >= 1);
  assert.equal(g.statues, true, 'standing, not in mid-stride');
  const caughtAt = places(g);
  run(g, 2);
  assert.deepEqual(places(g), caughtAt);
  run(g, 2.3);
  assert.equal(g.asleep, true, 'and back to sleep');

  // Awake: the nights are watched, and they no longer mind.
  g.s.flags.awake = 1;
  toNight();
  run(g, 1);
  assert.equal(g.asleep, false);
  assert.equal(g.frozen, false);
  g.touch();
  g.step(0.1);
  assert.equal(g.frozen, false);

  // By day they still hold still...
  g.s.dayT = 0;
  run(g, 6);
  assert.equal(g.frozen, true);
  // ...until the day they don't, unless you look.
  g.s.flags.moveByDay = 1;
  g.buyGnome('gardener');       // any purchase re-reads the flags
  run(g, 6);
  assert.equal(g.frozen, false);
  g.touch();
  g.step(0.1);
  assert.equal(g.frozen, true);
  assert.equal(g.statues, false, 'caught in mid-stride, and it shows');
  run(g, 4);
  assert.equal(g.frozen, false, 'they start again when nobody is looking');
});

test('diggers deepen the hole and bring back teeth', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1e7;
  Object.assign(g.s.flags, { gnomes: 1, dig: 1, stir: 1, awake: 1, moveByDay: 1, nightSoon: 1 });
  g.buyGnome('gardener', 12);
  g.buyGnome('digger', 6);
  run(g, 400);
  assert.ok(g.s.depth >= 1 || g.s.effort > 0, 'the hole is getting deeper');
  assert.ok(g.s.totalTeeth > 0);
  assert.ok(g.holeR > 0, 'there is a hole as soon as somebody digs');
  assert.ok(g.s.flags.teeth);
});

test('a save restores the garden', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1e6;
  Object.assign(g.s.flags, { gnomes: 1, dig: 1, plots: 1 });
  g.buyGnome('gardener', 5);
  g.buyGnome('digger', 2);
  g.buyPlot();
  g.buyUpgrade('can', 2);
  run(g, 3);
  const copy = createGame(JSON.parse(g.save()), quiet);
  assert.equal(copy.s.plots, 5);
  assert.equal(copy.em.count([Flower]), 5);
  assert.equal(copy.em.count([Gnome]), 7);
  assert.equal(copy.s.up.can, 2);
  assert.equal(copy.s.log.length, g.s.log.length, 'loading writes nothing new in the diary');
  assert.equal(copy.D.growMult, g.D.growMult);
});

test('a broken save starts a new garden', () => {
  for (const bad of [null, 'x', 12, {}, { blooms: 'many' }]) {
    const g = createGame(bad, quiet);
    assert.equal(g.s.plots, 4);
  }
});

test('the unearthing ends the run and hands down hats', () => {
  const g = createGame(undefined, quiet);
  g.s.depth = 100;
  g.s.totalBlooms = 1e15;
  g.s.whispers = 1e9;
  g.s.flags.unearth = 1;
  g.s.flags.dig = 1;
  assert.equal(g.unearth(), true);
  assert.ok(g.ending);
  let reborn = 0;
  run(g, 20, () => { for (const e of g.events) if (e.type === 'reborn') reborn = e.n!; });
  assert.equal(reborn, hatsFor(1e15, 100));
  assert.equal(g.s.runs, 1);
  assert.equal(g.s.hatsEver, reborn);
  assert.equal(g.s.depth, 0);
  assert.equal(g.s.gnomes.gardener, 1, 'somebody left a gnome');
  assert.equal(g.em.count([Gnome]), 1);
  assert.ok(derive(g.s).hatMult > 1);
  assert.ok(g.buyHeirloom('gerald'));
});

test('time away pays out, and only once the gnomes work nights', () => {
  const g = createGame(undefined, quiet);
  assert.equal(g.away(3600), null);
  g.s.flags.nightWork = 1;
  g.s.rate.blooms = 10;
  const got = g.away(3600)!;
  assert.equal(got.blooms, 10 * 3600 * 0.5);
  assert.equal(g.s.blooms, got.blooms);
});

test('nothing is drawn or simulated as NaN after a long mixed session', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1e12; g.s.teeth = 1e9; g.s.whispers = 1e9;
  Object.assign(g.s.flags, { gnomes: 1, dig: 1, lantern: 1, choir: 1, rites: 1, teeth: 1, stir: 1, awake: 1, moveByDay: 1, nightSoon: 1, friends: 1 });
  g.buyGnome('gardener', 60); g.buyGnome('digger', 30); g.buyGnome('lantern', 12); g.buyGnome('choir', 20);
  g.s.depth = 60;
  g.buyUpgrade('gate'); g.buyUpgrade('pretend');
  assert.equal(g.s.up.gate, 1);
  run(g, 400, (t) => { if (Math.floor(t * 10) % 37 === 0) pickAll(g); });
  for (const k of ['blooms', 'teeth', 'whispers', 'depth', 'peace'] as const) assert.ok(Number.isFinite(g.s[k]), k);
  g.em.forEachArchetype([Pos, Gnome], (_ids, n, field) => {
    const x = field(Pos.x), y = field(Pos.y), st = field(Gnome.state);
    for (let i = 0; i < n; i++) { assert.ok(Number.isFinite(x[i]) && Number.isFinite(y[i])); assert.ok(st[i] <= ST.LURE); }
  });
  assert.ok(g.s.stats.visitors > 0, 'lanterns bring visitors');
  assert.ok(g.s.guests > 0, 'and with the gate open at night, some stay');
});

test('weeds come up in the beds, slow the flower there, and can be pulled', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1e6; g.s.flags.plots = 1;
  g.buyPlot(8);
  const weeds = () => {
    const out: number[] = [];
    g.em.forEachArchetype([Flower], (_ids, n, field) => { for (let i = 0; i < n; i++) if (field(Flower.weed)[i]) out.push(field(Flower.plot)[i]); });
    return out;
  };
  run(g, 90);
  const found = weeds();
  assert.ok(found.length >= 1 && found.length <= 2, `${found.length} weeds in 12 beds: never more than a fifth of them`);
  const p = found[0];
  assert.notEqual(g.tap(PLOTS[p].x, PLOTS[p].y - 3), 'none');
  assert.ok(g.s.stats.weeds >= 1);
  assert.ok(!weeds().includes(p));
});

test('things pass through and are worth catching', () => {
  const g = createGame(undefined, quiet);
  g.s.blooms = 1e4; g.s.flags.gnomes = 1;
  g.buyGnome('gardener', 2);
  let seen = -1;
  run(g, 120, () => { for (const e of g.events) if (e.type === 'critter') seen = e.n!; });
  assert.ok(seen >= 0, 'something turned up');
  // Put one where it can be reached and catch it.
  run(g, 120, () => {
    if (g.em.count([Critter]) && !g.s.stats.critters && g.dark < 0.5) {
      g.em.forEachArchetype([Pos, Critter], (_ids, n, field) => { for (let i = 0; i < n; i++) g.tap(field(Pos.x)[i], field(Pos.y)[i] - 4); });
    }
  });
  assert.ok(g.s.stats.critters >= 1, 'caught one');
  assert.ok(CRITTER.glint === 4);
});


test('the round buttons do what they say, then rest', () => {
  const g = createGame(undefined, quiet);
  assert.equal(g.useAbility('water'), false, 'not before the watering can');
  g.s.blooms = 1e6;
  Object.assign(g.s.flags, { gnomes: 1, plots: 1, stir: 1, awake: 1, moveByDay: 1, nightSoon: 1 });
  g.buyUpgrade('can');
  g.buyGnome('gardener', 8);
  g.s.dayT = 0;
  run(g, 5);
  pickAll(g);
  const picked = g.s.stats.tapped;
  // Watered beds ripen four times as fast.
  assert.equal(g.useAbility('water'), true);
  assert.equal(g.useAbility('water'), false, 'it has to rest');
  run(g, 1.2);
  pickAll(g);
  assert.equal(g.s.stats.tapped, picked + 4, 'the daisies are back in about a second');
  // Looking away: they hurry, and a tap on the garden is a peek.
  run(g, 4);
  assert.equal(g.useAbility('away'), true);
  g.step(0.1);
  assert.equal(g.blind, true);
  assert.equal(g.frozen, false);
  assert.equal(g.tap(60, 100), 'peek');
  assert.equal(g.blind, false);
  g.step(0.1);
  assert.equal(g.frozen, true, 'and now they are being watched');
  assert.equal(g.s.stats.peeks, 1);
  // The bell: they work even while watched.
  assert.equal(g.useAbility('bell'), true);
  g.touch();
  g.step(0.1);
  assert.equal(g.frozen, false);
  for (const a of ABILITIES) assert.ok(a.cd > a.len);
  // Turning in early brings the night on; it is for the sleeping stage only.
  assert.equal(g.useAbility('nap'), false);
  g.s.flags.awake = 0;
  g.s.flags.moveByDay = 0;
  g.buyGnome('gardener');       // any purchase re-reads the flags
  g.s.dayT = 0;
  run(g, 1);
  assert.equal(g.useAbility('nap'), true);
  run(g, 4);
  assert.equal(g.asleep, true);
});


test('the to-do list hands out jobs; a finished one waits to be crossed off, and pays then', () => {
  const g = createGame(undefined, quiet);
  run(g, 5);
  pickAll(g);
  run(g, 1);
  assert.equal(g.s.todo.length, 1, 'on day one there is only picking to do');
  assert.equal(g.s.todo[0].kind, 'pick');
  assert.equal(g.claimTask(0), false, 'not before it is done');
  // Do it.
  let ready = 0;
  run(g, 240, (t) => { if (Math.floor(t * 10) % 12 === 0) pickAll(g); for (const e of g.events) if (e.type === 'ready') ready++; });
  assert.equal(ready, 1);
  assert.ok(g.s.todo[0].ready);
  assert.equal(g.s.done, 0, 'nothing is paid until it is crossed off');
  assert.equal(g.skipTask(0), false, 'a finished job cannot be swapped away');
  const before = g.s.blooms, lines = g.s.log.length;
  assert.equal(g.claimTask(0), true);
  assert.equal(g.s.done, 1);
  assert.ok(g.s.blooms > before);
  assert.ok(g.D.jobs > 1, 'and every flower is worth a little more');
  assert.equal(g.s.log.length, lines + 1, 'it goes in the diary');
  assert.equal(g.s.log[g.s.log.length - 1].kind, 'job');
  run(g, 1);
  assert.equal(new Set(g.s.todo.map((t) => t.kind)).size, g.s.todo.length, 'no job is on the list twice');
  assert.equal(new Set(TASKS.map((t) => t.kind)).size, TASKS.length);
  for (const t of TASKS) assert.equal(t.text.length, 3, t.kind);
});

test('content is consistent', () => {
  const ids = new Set<string>();
  for (const u of UPGRADES) { assert.ok(!ids.has(u.id), u.id); ids.add(u.id); }
  const s = newState();
  for (const u of UPGRADES) {
    let prev = 0;
    for (let n = 0; n < Math.min(u.max, 6); n++) {
      const c = upgradePrice(u, n);
      const sum = (c.blooms ?? 0) + (c.teeth ?? 0) + (c.whispers ?? 0);
      assert.ok(sum > prev, `${u.id} level ${n} costs more than the last`);
      prev = sum;
    }
    assert.ok(u.names.length >= 1 && u.blurb.length >= 1);
  }
  for (let i = 1; i < FLOWERS.length; i++) {
    assert.ok(FLOWERS[i].value > FLOWERS[i - 1].value * 4, FLOWERS[i].id);
    assert.ok((FLOWERS[i].depth ?? 0) >= (FLOWERS[i - 1].depth ?? 0), FLOWERS[i].id);
  }
  assert.equal(new Set(BEATS.map((b) => b.id)).size, BEATS.length);
  assert.equal(new Set(HEIRLOOMS.map((h) => h.id)).size, HEIRLOOMS.length);
  for (const def of GNOMES) assert.ok(priceAt(def.price, 10).blooms! > priceAt(def.price, 0).blooms! || priceAt(def.price, 10).teeth! > priceAt(def.price, 0).teeth!);
  // Every flag a beat waits on is set by some earlier beat or by the game itself.
  let peace = 100;
  for (const b of BEATS) if (b.peace !== undefined) { assert.ok(b.peace <= peace, `${b.id} does not raise peace`); peace = b.peace; }
  assert.ok(metreEffort(50) > metreEffort(10));
  assert.ok(plotCost(10).blooms! > plotCost(5).blooms!);
  assert.equal(s.plots, 4);
});
