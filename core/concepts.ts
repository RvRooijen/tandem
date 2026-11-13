// Concepts: the layer the person works in. A concept is a name and a
// description in their own words, with links to other concepts and a firmness
// that says how much freedom the agent has with it. One markdown file each.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** loose: an invitation to explore. worked: talked through, still words. playable: made real. fixed: a promise, with checks. */
export type Firmness = 'loose' | 'worked' | 'playable' | 'fixed';
export const FIRMNESS: Firmness[] = ['loose', 'worked', 'playable', 'fixed'];

/** A promise that can be checked: a milestone that must land inside a window, in minutes after the first owner moves in. */
export interface Check { milestone: string; min?: number; max?: number; why?: string; /** Which player it is a promise to; the eager one if not said. */ profile?: string }

export interface Concept {
  id: string;
  name: string;
  firmness: Firmness;
  /** Other concepts: { to, kind } with kind part-of, leads-to or clashes-with. */
  links: { to: string; kind: string }[];
  /** What makes it real: record paths, drawings, tests. */
  realised: string[];
  checks: Check[];
  /** The person's words, and under them whatever was worked out. */
  text: string;
}

export interface Concepts {
  list(): Concept[];
  get(id: string): Concept | undefined;
  save(c: Concept): void;
  remove(id: string): void;
  slug(name: string): string;
}

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'concept';

function parse(id: string, raw: string): Concept {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = m ? JSON.parse(m[1]) : {};
  return {
    id, name: head.name ?? id, firmness: FIRMNESS.includes(head.firmness) ? head.firmness : 'loose',
    links: head.links ?? [], realised: head.realised ?? [], checks: head.checks ?? [],
    text: (m ? m[2] : raw).trim(),
  };
}

// The head is JSON between the dashes: easy for a program to write, readable enough for a person.
const format = (c: Concept) =>
  `---\n${JSON.stringify({ name: c.name, firmness: c.firmness, links: c.links, realised: c.realised, checks: c.checks }, null, 2)}\n---\n\n${c.text.trim()}\n`;

export function createConcepts(dir: string): Concepts {
  mkdirSync(dir, { recursive: true });
  const read = () => (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.md'))
    .map((f) => parse(f.slice(0, -3), readFileSync(join(dir, f), 'utf8')));
  return {
    list: read,
    get: (id) => read().find((c) => c.id === id),
    save(c) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) throw new Error(`a concept id is lower-case words with dashes, not "${c.id}"`);
      writeFileSync(join(dir, c.id + '.md'), format(c));
    },
    remove(id) { if (/^[a-z0-9][a-z0-9-]*$/.test(id)) rmSync(join(dir, id + '.md'), { force: true }); },
    slug,
  };
}
