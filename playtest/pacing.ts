// Playtesting without a player: a bot of rules plays the game through and
// writes down when things happened. Two runs side by side say what a change
// did to the pacing. It reports; it does not judge: what the timing should be
// is the person's to say, in words.
import type { GameModule } from '../core/game.ts';

export interface Pacing {
  profile: string;
  /** Minutes after the first owner moved in at which each milestone happened. */
  minutes: Record<string, number>;
  /** Minutes the first owner lasted, if the run got to the end. */
  length?: number;
  /** Later owners: how long each lasted, in minutes. */
  later: (number | undefined)[];
  /** Wall-clock seconds the run took. */
  took: number;
}

const mins = (s: number) => Math.round((s / 60) * 10) / 10;

export function runPacing(game: GameModule, profile = 'eager', owners = 1, maxHours = 40): Pacing {
  const t0 = Date.now();
  const world = game.createWorld(undefined, { seed: 1 });
  const run = game.playthrough(world, profile, { owners, maxHours, seed: 1 });
  const first = run.owners[0];
  return {
    profile,
    minutes: Object.fromEntries(Object.entries(first.at).map(([k, v]) => [k, mins(v)])),
    length: first.length !== undefined ? mins(first.length) : undefined,
    later: run.owners.slice(1).map((o) => (o.length !== undefined ? mins(o.length) : undefined)),
    took: Math.round((Date.now() - t0) / 100) / 10,
  };
}

export interface Moved { milestone: string; before?: number; after?: number; change?: number }

/** What moved between two runs: milestones more than `threshold` (a fraction) and half a minute apart, biggest first. */
export function compare(before: Pacing, after: Pacing, threshold = 0.05): Moved[] {
  const out: Moved[] = [];
  for (const k of new Set([...Object.keys(before.minutes), ...Object.keys(after.minutes)])) {
    const a = before.minutes[k], b = after.minutes[k];
    if (a === undefined || b === undefined) { if (a !== b) out.push({ milestone: k, before: a, after: b }); continue; }
    const change = a > 0 ? (b - a) / a : 0;
    if (Math.abs(b - a) >= 0.5 && Math.abs(change) >= threshold) out.push({ milestone: k, before: a, after: b, change: Math.round(change * 1000) / 10 });
  }
  return out.sort((x, y) => (x.before ?? x.after ?? 0) - (y.before ?? y.after ?? 0));
}
