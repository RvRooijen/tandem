// Content as records: one JSON file per thing, under games/<game>/content/<kind>/<id>.json.
// A read can ask for the records as the pending proposals would leave them, so
// a preview or a playtest runs on the proposed state without anything being written.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordValue = { [key: string]: Json };
/** Every record by its path, "<kind>/<id>". */
export type RecordSet = Record<string, RecordValue>;

export interface Records {
  all(): RecordSet;
  get(path: string): RecordValue | undefined;
  set(path: string, value: RecordValue): void;
  /** The records with changes laid over them: each change replaces the fields it names. */
  overlay(changes: { path: string; after: RecordValue }[]): RecordSet;
}

const okPath = (path: string) => /^[a-z][a-z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(path);

export function createRecords(dir: string): Records {
  const read = (): RecordSet => {
    const out: RecordSet = {};
    if (!existsSync(dir)) return out;
    for (const kind of readdirSync(dir, { withFileTypes: true })) {
      if (!kind.isDirectory()) continue;
      for (const f of readdirSync(join(dir, kind.name))) {
        if (!f.endsWith('.json')) continue;
        out[`${kind.name}/${f.slice(0, -5)}`] = JSON.parse(readFileSync(join(dir, kind.name, f), 'utf8'));
      }
    }
    return out;
  };
  let cache = read();
  return {
    all: () => cache,
    get: (path) => cache[path],
    set(path, value) {
      if (!okPath(path)) throw new Error(`a record path is <kind>/<id>, not "${path}"`);
      const file = join(dir, path + '.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
      cache = { ...cache, [path]: value };
    },
    overlay(changes) {
      const out: RecordSet = { ...cache };
      for (const c of changes) out[c.path] = { ...(out[c.path] ?? {}), ...c.after };
      return out;
    },
  };
}
