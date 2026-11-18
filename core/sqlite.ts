// Reading a project's SQLite file, and never writing it: what a data view shows and what the agent asks of it.
// Opened read-only for each question and closed after, so a database the project's own server has open is left
// as it is. node:sqlite is loaded when first needed: it is new enough that node warns about it.
import { existsSync, statSync } from 'node:fs';

/** What a question gave: the columns, at most `limit` rows, and whether there were more. */
export interface Rows { columns: string[]; rows: unknown[][]; more: boolean }

type Sqlite = typeof import('node:sqlite');
let sqlite: Sqlite | undefined;

function open(file: string) {
  if (!existsSync(file)) throw new Error(`there is no file ${file}`);
  if (!statSync(file).isFile()) throw new Error(`${file} is a folder, not a SQLite file`);
  sqlite ??= process.getBuiltinModule('node:sqlite') as Sqlite;
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

/** A value as JSON can carry it: a blob is said by its size. */
const plain = (v: unknown) => (v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === 'bigint' ? String(v) : v);

export function query(file: string, sql: string, params: unknown[] = [], limit = 500): Rows {
  const db = open(file);
  try {
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows: unknown[][] = [];
    let more = false;
    for (const row of stmt.iterate(...(params as never[]))) {
      if (rows.length >= limit) { more = true; break; }
      rows.push(columns.map((c) => plain((row as Record<string, unknown>)[c])));
    }
    return { columns, rows, more };
  } finally {
    db.close();
  }
}

/** Every table and view in the file: its columns and how many rows it has. */
export function tables(file: string): { name: string; type: string; columns: { name: string; type: string }[]; rows: number }[] {
  const db = open(file);
  try {
    const list = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; type: string }[];
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    return list.map((t) => ({
      name: t.name, type: t.type,
      columns: (db.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type })),
      rows: Number((db.prepare(`SELECT count(*) AS n FROM ${quote(t.name)}`).get() as { n: number }).n),
    }));
  } finally {
    db.close();
  }
}
