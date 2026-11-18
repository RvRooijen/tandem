// Proposals: what the agent wants to change, kept apart until the person
// decides. Everything that waits for the person is one set, shown as one card and
// decided as one: concepts, how the project is run, and the working copy's code.
// (A drawing worker's round is its own: the agent decides it.) Each proposal keeps
// the thing as it was, so the card can show before and after.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** The fields of a thing, as they were or as they would be. */
export type RecordValue = { [key: string]: Json };

export interface Proposal {
  id: string;
  round: string;
  by: string;
  /**
   * What kind of thing it changes: a concept, a drawing, the project's code (the agent's working copy), how tandem
   * runs the project, or one of the project's own commands that does something (run: done when it is accepted).
   */
  kind: 'concept' | 'drawing' | 'code' | 'setup' | 'run';
  /** The concept's id or the drawing's name; for code, 'working copy'; for setup, 'how it is run'; for run, the command. */
  path: string;
  /** The fields as they were (undefined for something new) and as they would be. */
  before?: RecordValue;
  after: RecordValue;
  /** Why, in the agent's words. */
  note: string;
  /** What only the person can say about it: questions the agent has, each answered in a field on the card. */
  questions?: string[];
  /** A concept: the loose thought it works into the document, which is no longer loose once this is accepted. */
  thought?: string;
  /**
   * A concept the person changed on its card before deciding: for each field they changed, what the agent had
   * proposed for it (null when it had proposed nothing for that field). `after` is what the person made of it.
   */
  proposed?: RecordValue;
  status: 'pending' | 'accepted' | 'rejected';
  ts: number;
}

export interface Proposals {
  add(p: Omit<Proposal, 'id' | 'status' | 'ts'>): Proposal;
  list(filter?: { status?: Proposal['status']; round?: string }): Proposal[];
  /**
   * The person changes a pending proposal before deciding it: the fields given are what it would be now. `was` is
   * the thing as it is, for a change to something that exists: a field the proposal did not touch yet gets its before from it.
   */
  edit(id: string, fields: RecordValue, was?: RecordValue): Proposal | undefined;
  /** Mark the pending proposals of a round: all of them, or only the ones named (one that is withdrawn while the rest waits). Returns the ones it decided. */
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
      // A second change to the same thing that still waits replaces the first: the set says where it ends up.
      const earlier = all.find((x) => x.status === 'pending' && x.round === p.round && x.kind === p.kind && x.path === p.path);
      if (earlier) {
        earlier.after = { ...earlier.after, ...p.after };
        // (A field it did not touch before has its before from now.)
        if (p.before) earlier.before = { ...p.before, ...earlier.before };
        // What is proposed anew for a field is what stands there: it is no longer the person's version of it.
        for (const k in p.after) delete earlier.proposed?.[k];
        if (earlier.proposed && !Object.keys(earlier.proposed).length) delete earlier.proposed;
        earlier.note = p.note;
        if (p.questions) earlier.questions = p.questions;
        if (p.thought) earlier.thought = p.thought;
        write(earlier);
        return earlier;
      }
      const full: Proposal = { ...p, id: `p${Date.now().toString(36)}${all.length}`, status: 'pending', ts: Date.now() };
      all.push(full);
      write(full);
      return full;
    },
    edit(id, fields, was) {
      const p = all.find((x) => x.id === id && x.status === 'pending');
      if (!p) return undefined;
      const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a) === JSON.stringify(b);
      for (const k in fields) {
        if (same(fields[k], p.after[k])) continue;
        const proposed = (p.proposed ??= {});
        if (!(k in proposed)) proposed[k] = k in p.after ? p.after[k] : null;
        if (p.before && was && !(k in p.before) && k in was) p.before[k] = was[k];
        p.after[k] = fields[k];
        // Put back to what was proposed, it is the agent's again.
        if (same(proposed[k], p.after[k])) delete proposed[k];
      }
      if (p.proposed && !Object.keys(p.proposed).length) delete p.proposed;
      write(p);
      return p;
    },
    list: (filter = {}) => all.filter((p) => (!filter.status || p.status === filter.status) && (!filter.round || p.round === filter.round)),
    decide(round, status, only) {
      const set = all.filter((p) => p.round === round && p.status === 'pending' && (!only || only.includes(p.id)));
      for (const p of set) { p.status = status; write(p); }
      return set;
    },
  };
}
