// The saved state of a game: plain data, no entities. The garden's entities
// are rebuilt from the counts in here when a save is loaded.
import type { RoleId } from './content.ts';

export const SAVE_VERSION = 1;

/** A job on the to-do list. `have` counts up to `goal`. */
export interface Task { kind: string; goal: number; have: number; from: number; born: number; ready: number }

export interface LogLine { text: string; day: number; kind: 'beat' | 'flavor' | 'buy' | 'away' | 'job' }

export interface State {
  v: number;
  blooms: number;
  teeth: number;
  whispers: number;
  hats: number;             // unspent
  hatsEver: number;         // every hat handed down; this is what multiplies

  totalBlooms: number;      // this owner
  totalTeeth: number;
  totalWhispers: number;
  allBlooms: number;        // every owner

  gnomes: Record<RoleId, number>;   // how many are in the garden
  bought: Record<RoleId, number>;   // how many were paid for (sets the price)
  guests: number;                   // visitors who stayed
  plots: number;
  seed: number;                     // best flower unlocked
  up: Record<string, number>;       // upgrade levels
  heir: Record<string, number>;     // heirlooms owned
  flags: Record<string, number>;
  beats: Record<string, number>;    // diary beats already written
  log: LogLine[];
  todo: Task[];                     // the to-do list, three jobs at a time
  done: number;                     // jobs crossed off by this owner
  cd: Record<string, number>;       // seconds until an ability can be used again
  buff: Record<string, number>;     // seconds left on whatever is in effect

  depth: number;            // metres
  effort: number;           // digging done toward the next metre
  peaceCap: number;         // the story's ceiling on peace of mind
  peace: number;            // what is shown; drifts toward the ceiling

  clock: number;            // seconds played by this owner
  dayT: number;             // seconds into the current day/night cycle
  day: number;
  runs: number;             // owners before this one

  stats: {
    tapped: number;
    bestStreak: number;
    critters: number;
    weeds: number;
    abilities: number;
    peeks: number;
    delivered: number;
    caught: number;
    visitors: number;
    greeted: number;
    played: number;         // seconds, all owners
  };
  rate: { blooms: number; teeth: number; whispers: number; effort: number };  // smoothed income per second
  nextFlavor: number;
  nextFriend: number;
  lastSeen: number;         // epoch ms of the last save
  mute: number;
  buyN: number;             // 1, 10 or 0 for max
}

export function newState(): State {
  return {
    v: SAVE_VERSION,
    blooms: 0, teeth: 0, whispers: 0, hats: 0, hatsEver: 0,
    totalBlooms: 0, totalTeeth: 0, totalWhispers: 0, allBlooms: 0,
    gnomes: { gardener: 0, digger: 0, lantern: 0, choir: 0 },
    bought: { gardener: 0, digger: 0, lantern: 0, choir: 0 },
    guests: 0,
    plots: 4,
    seed: 0,
    up: {}, heir: {}, flags: {}, beats: {}, log: [],
    todo: [], done: 0, cd: {}, buff: {},
    depth: 0, effort: 0,
    peaceCap: 100, peace: 100,
    clock: 0, dayT: 0, day: 1, runs: 0,
    stats: { tapped: 0, bestStreak: 0, critters: 0, weeds: 0, abilities: 0, peeks: 0, delivered: 0, caught: 0, visitors: 0, greeted: 0, played: 0 },
    rate: { blooms: 0, teeth: 0, whispers: 0, effort: 0 },
    nextFlavor: 100, nextFriend: 60,
    lastSeen: 0, mute: 0, buyN: 1,
  };
}

/** Fill in anything a save from an older version lacks. */
export function migrate(raw: unknown): State | null {
  if (!raw || typeof raw !== 'object') return null;
  const base = newState();
  const s = raw as Partial<State>;
  if (typeof s.blooms !== 'number' || !s.gnomes) return null;
  const out: State = {
    ...base, ...s,
    gnomes: { ...base.gnomes, ...s.gnomes },
    bought: { ...base.bought, ...s.bought },
    stats: { ...base.stats, ...s.stats },
    rate: { ...base.rate, ...s.rate },
    up: { ...s.up }, heir: { ...s.heir }, flags: { ...s.flags }, beats: { ...s.beats },
    log: Array.isArray(s.log) ? s.log.slice(-80) : [],
    todo: Array.isArray(s.todo) ? s.todo.slice(0, 3) : [],
    cd: { ...s.cd }, buff: { ...s.buff },
    v: SAVE_VERSION,
  };
  for (const k of ['blooms', 'teeth', 'whispers', 'hats', 'hatsEver', 'depth', 'effort', 'done'] as const)
    if (!Number.isFinite(out[k])) out[k] = 0;
  return out;
}
