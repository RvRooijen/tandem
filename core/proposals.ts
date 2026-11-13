// Proposals: what the agent wants to change, kept apart until the person
// decides. One round of agent work is one change set, shown as one; it is decided
// as one, or piece by piece. Each proposal keeps the thing as it was, so the card can show before and after.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** The fields of a thing, as they were or as they would be. */
export type RecordValue = { [key: string]: Json };

export interface Proposal {
  id: string;
  round: string;
  by: string;
  /** What kind of thing it changes: a concept, a drawing, or the game's code (the agent's working copy). */
  kind: 'concept' | 'drawing' | 'code';
  /** The concept's id or the drawing's name; for code, 'working copy'. */
  path: string;
  /** The fields as they were (undefined for something new) and as they would be. */
  before?: RecordValue;
  after: RecordValue;
  /** Why, in the agent's words. */
  note: string;
  status: 'pending' | 'accepted' | 'rejected';
  ts: number;
}

export interface Proposals {
  add(p: Omit<Proposal, 'id' | 'status' | 'ts'>): Proposal;
  list(filter?: { status?: Proposal['status']; round?: string }): Proposal[];
  /** Mark the pending proposals of a round: all of them, or only the ones named. Returns the ones it decided. */
  decide(round: string, status: 'accepted' | 'rejected', only?: string[]): Proposal[];
}

export function createProposals(dir: string): Proposals {
  mkdirSync(dir, { recursive: true });
  const all: Proposal[] = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Proposal).sort((a, b) => a.ts - b.ts)
    : [];
  const write = (p: Proposal) => writeFileSync(join(dir, p.id + '.json'), JSON.stringify(p, null, 2) + '\n');
  return {
    add(p) {
      // A second change to the same thing in the same round replaces the first: the set says where it ends up.
      const earlier = all.find((x) => x.status === 'pending' && x.round === p.round && x.kind === p.kind && x.path === p.path);
      if (earlier) {
        earlier.after = { ...earlier.after, ...p.after };
        earlier.note = p.note;
        write(earlier);
        return earlier;
      }
      const full: Proposal = { ...p, id: `p${Date.now().toString(36)}${all.length}`, status: 'pending', ts: Date.now() };
      all.push(full);
      write(full);
      return full;
    },
    list: (filter = {}) => all.filter((p) => (!filter.status || p.status === filter.status) && (!filter.round || p.round === filter.round)),
    decide(round, status, only) {
      const set = all.filter((p) => p.round === round && p.status === 'pending' && (!only || only.includes(p.id)));
      for (const p of set) { p.status = status; write(p); }
      return set;
    },
  };
}
