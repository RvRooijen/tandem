// A player made of rules: shops, picks flowers, and keeps time. Shared by the
// balance report, the screenshots and the pacing tests.
import type { Game } from '../src/sim/game.ts';
import { ABILITIES, FLOWERS, GNOMES, HEIRLOOMS, ROLE_IDS, UPGRADES, type Cost, type Res } from '../src/sim/content.ts';
import { Critter, Flower, Pos } from '../src/sim/components.ts';
import { canAfford, gnomeCost, plotCost, unearthCost, upgradeCap, upgradeCost } from '../src/sim/economy.ts';
import { MAX_PLOTS, PLOTS } from '../src/sim/world.ts';
import { rng } from '../src/util.ts';

function price(g: Game, c: Cost): number {
  // Everything in "seconds of income", so costs in different currencies compare.
  let t = 0;
  const s = g.s;
  for (const k in c) {
    const have = s[k as Res], need = c[k as Res]!;
    const rate = k === 'blooms' ? s.rate.blooms + 0.5 : k === 'teeth' ? s.rate.teeth + 0.01 : s.rate.whispers + 0.01;
    t = Math.max(t, Math.max(0, need - have) / rate);
  }
  return t;
}

/** Spend like an eager player: the cheapest thing on offer, saving up when new seeds are close. */
export function shop(g: Game) {
  const s = g.s;
  // Buy anything affordable, cheapest wait first; a few passes per call.
  for (let pass = 0; pass < 6; pass++) {
    type Offer = { c: Cost; buy: () => unknown };
    const offers: Offer[] = [];
    if (s.flags.plots && s.plots < MAX_PLOTS) offers.push({ c: plotCost(s.plots), buy: () => g.buyPlot() });
    const seed = g.seedCost();
    if (seed) offers.push({ c: seed, buy: () => g.buySeed() });
    for (const def of GNOMES) if (s.flags[def.flag]) offers.push({ c: gnomeCost(s, def.id), buy: () => g.buyGnome(def.id) });
    for (const u of UPGRADES) {
      if ((s.up[u.id] ?? 0) >= upgradeCap(s, u.id)) continue;
      if (u.show && !u.show(s)) continue;
      if (u.tab === 'below' && !s.flags.teeth) continue;
      if (u.tab === 'rites' && !s.flags.rites) continue;
      offers.push({ c: upgradeCost(s, u.id), buy: () => g.buyUpgrade(u.id) });
    }
    if (s.flags.unearth) offers.push({ c: unearthCost(), buy: () => g.unearth() });
    for (const h of HEIRLOOMS) if (!s.heir[h.id] && s.hats >= h.cost) g.buyHeirloom(h.id);
    // Like a player would: when the next seeds are nearly in reach, save up for them.
    const saving = seed && !canAfford(s, seed) && price(g, seed) < 240;
    const ok = offers.filter((o) => canAfford(s, o.c) && !(saving && o.c.blooms && o.c !== seed));
    if (!ok.length) return;
    ok.sort((a, b) => (a.c.blooms ?? 0) + (a.c.teeth ?? 0) * 1e3 + (a.c.whispers ?? 0) * 1e3 - ((b.c.blooms ?? 0) + (b.c.teeth ?? 0) * 1e3 + (b.c.whispers ?? 0) * 1e3));
    ok[0].buy();
  }
}


// ---------------------------------------------------------------- players

/** A way of playing: when the player picks flowers by hand, and how often they look at the shop. */
export interface Profile {
  name: string;
  /** Is the player picking by hand right now? t is seconds since this owner moved in. */
  picking: (g: Game, t: number) => boolean;
  /** Seconds between flowers when picking. */
  tapEvery: number;
  /** Seconds between visits to the shop. */
  shopEvery: number;
  /** Does the player use the round buttons, pull weeds and catch what flits by? */
  busy: boolean;
}

export const PROFILES: Record<string, Profile> = {
  // Keeps the game open and joins in: picks all the time early on, then in bursts.
  eager: { name: 'eager', picking: (g, t) => g.s.gnomes.gardener < 8 || t % 40 < 6, tapEvery: 0.45, shopEvery: 1, busy: true },
  // Gets the gnomes going, then only looks in now and then and never picks again.
  casual: { name: 'casual', picking: (g) => g.s.gnomes.gardener < 6, tapEvery: 0.7, shopEvery: 20, busy: false },
};

export interface OwnerLog {
  /** Seconds after moving in at which each thing happened: diary beats by id, 'seed:<flower>', 'gnome:<kind>', 'unearth'. */
  at: Record<string, number>;
  /** Seconds this owner lasted; undefined if the run stopped before the garden was unearthed. */
  length?: number;
  hats?: number;
  /** Jobs crossed off the to-do list. */
  jobs: number;
}

export interface Playthrough { owners: OwnerLog[]; seconds: number }

/**
 * Play the game with a profile until `owners` gardens have been unearthed or `maxHours` have passed.
 * Deterministic for a given game seed and bot seed.
 */
export function playthrough(g: Game, profile: Profile, opts: { owners?: number; maxHours?: number; seed?: number; dt?: number } = {}): Playthrough {
  const dt = opts.dt ?? 0.1;
  const want = opts.owners ?? 1;
  const rand = rng(opts.seed ?? 1);
  const steps = Math.round(((opts.maxHours ?? 6) * 3600) / dt);
  const owners: OwnerLog[] = [{ at: {}, jobs: 0 }];
  let start = 0, tapT = 0, shopT = 0, busyT = 0, i = 0;
  const mark = (key: string, t: number) => { const o = owners[owners.length - 1]; if (o.at[key] === undefined) o.at[key] = t - start; };
  for (const id in g.s.beats) mark(id, 0);
  for (; i < steps; i++) {
    const t = i * dt;
    g.step(dt);
    tapT += dt; shopT += dt;
    if (profile.busy && (busyT += dt) >= 2) {
      busyT = 0;
      chores(g, rand);
    }
    if (!g.blind && tapT >= profile.tapEvery && profile.picking(g, t - start)) {
      tapT = 0;
      const p = Math.floor(rand() * g.s.plots);
      g.tap(PLOTS[p].x, PLOTS[p].y - 3);
    }
    if (shopT >= profile.shopEvery) {
      shopT = 0;
      owners[owners.length - 1].jobs = Math.max(owners[owners.length - 1].jobs, g.s.done);
      const seed = g.s.seed, had = { ...g.s.gnomes };
      for (let j = g.s.todo.length - 1; j >= 0; j--) g.claimTask(j);
      shop(g);
      if (g.s.seed !== seed) mark('seed:' + FLOWERS[g.s.seed].id, t);
      for (const k of ROLE_IDS) if (!had[k] && g.s.gnomes[k]) mark('gnome:' + k, t);
    }
    let reborn = -1;
    for (const e of g.events) {
      if (e.type === 'beat') mark(e.text!, t);
      else if (e.type === 'ending') mark('unearth', t);
      else if (e.type === 'reborn') reborn = e.n!;
    }
    g.events.length = 0;
    if (reborn >= 0) {
      const o = owners[owners.length - 1];
      o.length = t - start;
      o.hats = reborn;
      if (owners.length >= want) { i++; break; }
      start = t;
      owners.push({ at: {}, jobs: 0 });
      for (const id in g.s.beats) mark(id, t);
    }
  }
  return { owners, seconds: i * dt };
}

/** What a player who is paying attention does every couple of seconds: the round buttons, the weeds, whatever is flitting by. */
function chores(g: Game, rand: () => number) {
  for (const a of ABILITIES) g.useAbility(a.id);
  if (g.blind) return;                       // eyes shut: hands off the garden
  const targets: [number, number][] = [];
  g.em.forEachArchetype([Pos, Critter], (_ids, n, field) => {
    for (let i = 0; i < n; i++) if (rand() < 0.6) targets.push([field(Pos.x)[i], field(Pos.y)[i] - 4]);
  });
  g.em.forEachArchetype([Flower], (_ids, n, field) => {
    for (let i = 0; i < n; i++) if (field(Flower.weed)[i] && rand() < 0.5) targets.push([PLOTS[field(Flower.plot)[i]].x, PLOTS[field(Flower.plot)[i]].y - 2]);
  });
  for (const [x, y] of targets) g.tap(x, y);
}

/** Play for a while like an eager player: for screenshots at a given point in the game. */
export function play(g: Game, seconds: number, dt = 0.1) {
  playthrough(g, PROFILES.eager, { owners: 99, maxHours: seconds / 3600, dt, seed: 1 + Math.round(g.s.clock) });
}
