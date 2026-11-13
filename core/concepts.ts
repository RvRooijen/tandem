// Concepts: the layer the person works in. A concept is a name and a
// description in their own words, with links to other concepts and a stage that
// says where it is on its way into the game. One markdown file each.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a concept is: idea (a thought to explore), design (being worked out in words), build (being made real:
 * content, art), playtest (in the game, being played and tuned). Nothing is ever finished; what must not be
 * touched gets a lock instead (locks.ts).
 */
export type Stage = 'idea' | 'design' | 'build' | 'playtest';
export const STAGES: Stage[] = ['idea', 'design', 'build', 'playtest'];
/** Files written before there were stages. */
const OLD: Record<string, Stage> = { loose: 'idea', worked: 'design', playable: 'playtest', fixed: 'playtest' };

export interface Concept {
  id: string;
  name: string;
  stage: Stage;
  /** Other concepts: { to, kind } with kind part-of, leads-to or clashes-with. */
  links: { to: string; kind: string }[];
  /** What makes it real: record paths, drawings, tests. */
  realised: string[];
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
    id, name: head.name ?? id, stage: STAGES.includes(head.stage) ? head.stage : OLD[head.firmness] ?? 'idea',
    links: head.links ?? [], realised: head.realised ?? [],
    text: (m ? m[2] : raw).trim(),
  };
}

// The head is JSON between the dashes: easy for a program to write, readable enough for a person.
const format = (c: Concept) =>
  `---\n${JSON.stringify({ name: c.name, stage: c.stage, links: c.links, realised: c.realised }, null, 2)}\n---\n\n${c.text.trim()}\n`;

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
