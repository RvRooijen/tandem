// Every number the simulation runs on, derived from the saved state. Bonuses
// are folded in here and nowhere else, so a new upgrade is one line.
import { FLOWERS, GNOMES, TUNE, UPGRADE, UNEARTH_COST, priceAt, upgradePrice, type Cost, type Res, type RoleId } from './content.ts';
import type { State } from './state.ts';

export interface Derived {
  bloomMult: number;     // blooms per unit of flower value
  tapMult: number;       // extra factor on flowers picked by hand
  tapSeconds: number;    // seconds of income a hand-picked flower also gives
  growMult: number;      // flower growth speed
  nightGrow: number;     // extra growth speed in the dark
  speed: number;         // gnome walking speed, px/s
  carry: number;         // flowers per trip
  pickTime: number;      // seconds to pick one
  digTime: number;       // seconds underground per load
  digPower: number;      // effort per load
  teethPer: number;      // teeth per load
  whisperRate: number;   // whispers per second with the choir in full voice
  dayLen: number;
  nightLen: number;
  visitorEvery: number;  // seconds between visitors, 0 = none come
  tipSeconds: number;    // seconds of income a visitor tips
  guestGnomes: number;   // gnomes gained when a visitor stays
  hatMult: number;
  charm: number;         // the bonus from the number of gnomes
  jobs: number;          // the bonus from jobs crossed off the list
  hoe: boolean;          // do the gnomes pull weeds
  freeze: boolean;       // do they freeze when watched
  byDay: boolean;        // do they move in daylight when not watched
  offline: number;       // share of income kept while away
  offlineCap: number;    // seconds
}

const lv = (s: State, id: string) => s.up[id] ?? 0;

export function totalGnomes(s: State): number {
  return s.gnomes.gardener + s.gnomes.digger + s.gnomes.lantern + s.gnomes.choir;
}

export function derive(s: State): Derived {
  const hatMult = 1 + s.hatsEver * TUNE.economy.hatBonus;
  const gnomes = totalGnomes(s);
  const charm = 1 + gnomes * (TUNE.economy.charmPerGnome + TUNE.economy.charmPerLevel * lv(s, 'charm'));
  const names = lv(s, 'names') ? 2 : 1;
  const jobs = 1 + s.done * TUNE.economy.jobBonus;

  const bloomMult = Math.pow(1.4, lv(s, 'compost')) * Math.pow(1.4, lv(s, 'roots')) * Math.pow(3, lv(s, 'feed')) * charm * jobs * hatMult;
  const nightBase = (TUNE.day.nightBase + TUNE.day.nightPerPorch * lv(s, 'porch')) * (s.heir.dusk ? 2 : 1);
  const evening = lv(s, 'evening');
  const nightLen = evening >= 3 ? 1e9 : nightBase * (1 + 1.5 * evening);

  const lanterns = s.gnomes.lantern;
  const sign = lv(s, 'sign');

  return {
    bloomMult,
    tapMult: Math.pow(1.5, lv(s, 'gloves')),
    tapSeconds: 0.1 * lv(s, 'thumb'),
    growMult: Math.pow(1.15, lv(s, 'can')),
    nightGrow: lv(s, 'moonbloom') ? 2 : 1,
    speed: 20 * (1 + 0.12 * lv(s, 'boots')) * names,
    carry: 1 + lv(s, 'basket'),
    pickTime: 0.5 / names,
    digTime: (5 * Math.pow(0.88, lv(s, 'steps'))) / names,
    digPower: Math.pow(1.4, lv(s, 'shovel')) * Math.pow(2.5, lv(s, 'deeper')) * (s.heir.jar ? 3 : 1) * hatMult,
    teethPer: Math.pow(1.4, lv(s, 'sieve')) * (lv(s, 'marrow') ? 3 : 1) * (1 + s.depth / 12) * hatMult,
    whisperRate: s.gnomes.choir * 0.06 * (lv(s, 'hum') ? 3 : 1) * Math.pow(1.5, lv(s, 'chorus')) * (s.heir.tune ? 3 : 1) * (1 + s.depth / 40) * hatMult,
    dayLen: TUNE.day.dayLen,
    nightLen,
    visitorEvery: lanterns > 0 ? Math.max(30, 110 / (Math.sqrt(lanterns) * (1 + 0.2 * sign))) : 0,
    tipSeconds: 12 * (1 + 0.25 * sign),
    guestGnomes: 1,
    hatMult,
    charm,
    jobs,
    hoe: lv(s, 'hoe') > 0,
    freeze: !lv(s, 'pretend'),
    byDay: !!s.flags.moveByDay || !!s.heir.habits,
    offline: s.heir.dreams ? 1 : 0.5,
    offlineCap: s.heir.dreams ? 24 * 3600 : 8 * 3600,
  };
}

// ---------------------------------------------------------------- prices

export const plotCost = (plots: number): Cost => ({ blooms: 10 * Math.pow(1.8, plots - 4) });

export function gnomeCost(s: State, id: RoleId, extra = 0): Cost {
  return priceAt(GNOMES.find((g) => g.id === id)!.price, s.bought[id] + extra);
}

export function upgradeCost(s: State, id: string, extra = 0): Cost {
  return upgradePrice(UPGRADE[id], lv(s, id) + extra);
}

export const unearthCost = (): Cost => ({ whispers: UNEARTH_COST });

/** How many levels of an upgrade the garden can take right now: more as the hole deepens. */
export function upgradeCap(s: State, id: string): number {
  const u = UPGRADE[id];
  if (u.depth !== undefined) return s.depth >= u.depth ? u.max : 0;
  if (u.per === undefined) return u.max;
  return Math.min(u.max, (u.base ?? 0) + Math.floor(s.depth / u.per));
}

/** The depth at which the next level of an upgrade comes on offer, or 0 if it already is. */
export function upgradeNeeds(s: State, id: string): number {
  const u = UPGRADE[id];
  const level = s.up[id] ?? 0;
  if (level >= u.max || level < upgradeCap(s, id)) return 0;
  if (u.depth !== undefined) return u.depth;
  return (level + 1 - (u.base ?? 0)) * (u.per ?? 1);
}

export function canAfford(s: State, c: Cost): boolean {
  for (const k in c) if (s[k as Res] < c[k as Res]! - 1e-9) return false;
  return true;
}

export function pay(s: State, c: Cost): boolean {
  if (!canAfford(s, c)) return false;
  for (const k in c) s[k as Res] = Math.max(0, s[k as Res] - c[k as Res]!);
  return true;
}

export function addCost(a: Cost, b: Cost): Cost {
  const out: Cost = { ...a };
  for (const k in b) out[k as Res] = (out[k as Res] ?? 0) + b[k as Res]!;
  return out;
}

// ---------------------------------------------------------------- the hole

/**
 * How long a metre of hole is meant to take a player who joins in, in seconds: a little over three
 * minutes at the top, eight at the bottom, and so ten hours or so to the hundredth metre.
 */
export const metreSeconds = (depth: number) => TUNE.dig.metreSecondsBase + TUNE.dig.metreSecondsPerMetre * depth;

/**
 * The natural log of the effort each of the first hundred metres costs. These are not designed by hand:
 * `npm run calibrate` plays the game and sets each one so that the metre takes metreSeconds.
 */
// calibrated:begin
let DIG: number[] = [7.03, 7.21, 7.45, 7.71, 7.85, 7.99, 8.27, 8.59, 8.91, 9.2, 9.37, 9.49, 9.7, 9.77, 9.64, 9.64, 9.85, 10.1, 10.39, 10.82, 11.42, 11.86, 12, 12.18, 12.49, 12.75, 13.07, 13.44, 13.64, 13.98, 14.61, 14.99, 15.15, 15.32, 15.43, 15.58, 15.78, 15.89, 15.99, 16.19, 16.35, 16.49, 16.7, 16.8, 17.1, 17.71, 18.07, 18.19, 18.38, 18.54, 18.66, 18.85, 18.96, 19.05, 19.24, 19.39, 19.5, 19.68, 19.8, 20.11, 20.72, 21.04, 21.14, 21.34, 21.47, 21.57, 21.75, 21.88, 21.99, 22.16, 22.28, 22.39, 22.58, 22.71, 22.9, 23.39, 23.86, 24.13, 24.3, 24.39, 24.47, 24.64, 24.76, 24.87, 25.02, 25.12, 25.14, 25.14, 25.18, 25.42, 25.85, 26.08, 26.11, 26.13, 26.13, 26.13, 26.14, 26.15, 26.16, 26.16];
// calibrated:end

/** For the calibration tool: try another table. */
export function setDigTable(table: number[]) { DIG = table; }
export const digTable = () => DIG;

/** Effort to dig from `depth` metres to the next one. Past the table it grows by a fifth a metre. */
export function metreEffort(depth: number): number {
  const last = DIG.length - 1;
  return depth <= last ? Math.exp(DIG[depth]) : Math.exp(DIG[last]) * Math.pow(1.2, depth - last);
}

// ---------------------------------------------------------------- a new owner

/** Red hats handed down when the garden is unearthed. */
export function hatsFor(totalBlooms: number, depth: number): number {
  if (depth < 100) return 0;
  return Math.max(3, Math.floor(Math.pow(Math.log10(totalBlooms + 10), 1.3) / 6));
}

export const flowerValue = (kind: number) => FLOWERS[kind].value;
