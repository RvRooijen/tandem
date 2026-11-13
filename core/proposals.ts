// Proposals: what the agent wants to change, kept apart until the person
// decides. One round of agent work is one change set, accepted or rejected as
// one. Each proposal keeps the thing as it was, so the card can show before and after.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordValue } from './records.ts';

export interface Proposal {
  id: string;
  round: string;
  by: string;
  /** What kind of thing it changes: a record, a concept, a drawing, or the game's code (the agent's working copy). */
  kind: 'record' | 'concept' | 'drawing' | 'code';
  /** The record's path, the concept's id, the drawing's name; for code, 'working copy'. */
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
  /** Mark every pending proposal of a round. Returns the ones it decided. */
  decide(round: string, status: 'accepted' | 'rejected'): Proposal[];
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
    decide(round, status) {
      const set = all.filter((p) => p.round === round && p.status === 'pending');
      for (const p of set) { p.status = status; write(p); }
      return set;
    },
  };
}
