// Loose thoughts: what the person types without having to name it or say where
// it belongs. They stand apart from the concepts, which are the document; a
// thought becomes part of the document only when the person wants it to (as a
// concept of its own, or worked into one that is there), and is then no
// longer loose. One small file per project.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Thought { id: string; text: string; ts: number }

export interface Thoughts {
  list(): Thought[];
  get(id: string): Thought | undefined;
  add(text: string): Thought;
  remove(id: string): boolean;
}

export function createThoughts(file: string): Thoughts {
  // Read every time: the file is the project's, and may have come in with a commit.
  const read = (): Thought[] => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Thought[] : []; } catch { return []; } };
  const write = (all: Thought[]) => writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  return {
    list: read,
    get: (id) => read().find((t) => t.id === id),
    add(text) {
      const all = read();
      const ts = Date.now();
      let id = `t${ts.toString(36)}`;
      while (all.some((t) => t.id === id)) id += 'x';
      const made = { id, text: text.trim(), ts };
      write([...all, made]);
      return made;
    },
    remove(id) {
      const all = read();
      if (!all.some((t) => t.id === id)) return false;
      write(all.filter((t) => t.id !== id));
      return true;
    },
  };
}
