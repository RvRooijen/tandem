// The event log: one append-only file per game. Everything that happens is an
// event: a message, a command run, a proposal, a picture, a playtest. The page
// and the runner both follow it; nothing is told to anyone any other way.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Event {
  /** Its place in the log, from 1. */
  n: number;
  ts: number;
  type: string;
  by?: string;
  [key: string]: unknown;
}

export interface EventLog {
  add(ev: Omit<Event, 'n' | 'ts'>): Event;
  /** Events after number `n`. */
  since(n: number): Event[];
  last(): number;
  subscribe(fn: (ev: Event) => void): () => void;
  /** Tell whoever is following, without keeping it: what the agent is doing right now, a pointer on the stage. n is 0. */
  cast(ev: Omit<Event, 'n' | 'ts'>): void;
}

export function createEventLog(file: string): EventLog {
  mkdirSync(dirname(file), { recursive: true });
  const events: Event[] = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Event)
    : [];
  const subs = new Set<(ev: Event) => void>();
  return {
    add(ev) {
      const full = { n: events.length + 1, ts: Date.now(), ...ev } as Event;
      events.push(full);
      appendFileSync(file, JSON.stringify(full) + '\n');
      for (const fn of subs) fn(full);
      return full;
    },
    since: (n) => events.slice(Math.max(0, n)),
    last: () => events.length,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    cast(ev) {
      const full = { n: 0, ts: Date.now(), ...ev } as Event;
      for (const fn of subs) fn(full);
    },
  };
}
