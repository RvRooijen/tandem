// Locks: anything can get one. A locked thing is the person's alone: the agent
// cannot change it or propose a change to it, not even when asked to. Only the
// person locks and unlocks. A thing is named the way a message refers to it:
// "concept:<id>", "record:<path>", "drawing:<name>". One small file per game.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CommandError, isAgent, type By } from './commands.ts';

export interface Locks {
  has(ref: string): boolean;
  set(ref: string, locked: boolean): void;
  list(): string[];
  /** Refuse an agent that is about to change something locked. */
  guard(ref: string, by: By): void;
}

const KINDS = ['concept', 'record', 'drawing'];

export function createLocks(file: string): Locks {
  let refs: string[] = [];
  try { refs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []; } catch { /* no locks is the safe way to read a broken file: nothing is silently locked forever */ }
  return {
    has: (ref) => refs.includes(ref),
    list: () => [...refs],
    set(ref, locked) {
      if (!KINDS.includes(ref.slice(0, ref.indexOf(':'))) || ref.endsWith(':')) throw new CommandError('input', `a lock is on "concept:<id>", "record:<path>" or "drawing:<name>", not "${ref}"`);
      refs = locked ? [...new Set([...refs, ref])].sort() : refs.filter((r) => r !== ref);
      writeFileSync(file, JSON.stringify(refs, null, 2) + '\n');
    },
    guard(ref, by) {
      if (isAgent(by) && refs.includes(ref))
        throw new CommandError('locked', `${ref} is locked: it is the person's alone, and you cannot change it or propose a change to it, even if they ask you to. Tell them it is locked; only they can unlock it`);
    },
  };
}
