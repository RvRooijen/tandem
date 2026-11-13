// The game's content as records, and back. Every number the game is tuned
// with can be written out as a set of small JSON records and read in again, so
// that a change to the game is a change to a record: something that can be
// proposed, previewed, played and accepted without touching code.
import { ABILITIES, BEATS, FLOWERS, GNOMES, TUNE, UPGRADES, type Cost, type Price } from './content.ts';
import { digTable, setDigTable } from './economy.ts';

type Value = Record<string, unknown>;
export type RecordSet = Record<string, Value>;

/** The content as it is in the code right now. */
export function exportRecords(): RecordSet {
  const out: RecordSet = {
    'settings/day': { ...TUNE.day },
    'settings/economy': { ...TUNE.economy },
    'settings/dig': { ...TUNE.dig, table: digTable().slice() },
  };
  for (const f of FLOWERS) out[`flowers/${f.id}`] = { name: f.name, value: f.value, grow: f.grow, depth: f.depth ?? 0, cost: { ...f.cost } };
  for (const g of GNOMES) out[`gnomes/${g.id}`] = { price: g.price.map((p) => [...p]) };
  for (const u of UPGRADES) out[`upgrades/${u.id}`] = {
    max: u.max, price: u.price.map((p) => [...p]),
    ...(u.table && { table: u.table.slice() }),
    ...(u.base !== undefined && { base: u.base }), ...(u.per !== undefined && { per: u.per }), ...(u.depth !== undefined && { depth: u.depth }),
  };
  for (const a of ABILITIES) out[`abilities/${a.id}`] = { len: a.len, cd: a.cd };
  for (const b of BEATS) out[`beats/${b.id}`] = {
    ...(b.after !== undefined && { after: b.after }), ...(b.peace !== undefined && { peace: b.peace }),
    ...(typeof b.text === 'string' && { text: b.text }),
  };
  return out;
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Lay a set of records over the content. Fields a record does not name stay as they are. */
export function applyRecords(set: RecordSet) {
  for (const group of ['day', 'economy', 'dig'] as const) {
    const rec = set[`settings/${group}`];
    if (!rec) continue;
    const target = TUNE[group] as Record<string, number>;
    for (const key in target) target[key] = num(rec[key], target[key]);
  }
  const table = set['settings/dig']?.table;
  if (Array.isArray(table) && table.every((v) => typeof v === 'number')) setDigTable(table as number[]);
  for (const f of FLOWERS) {
    const rec = set[`flowers/${f.id}`];
    if (!rec) continue;
    if (typeof rec.name === 'string') f.name = rec.name;
    f.value = num(rec.value, f.value);
    f.grow = num(rec.grow, f.grow);
    if (rec.depth !== undefined) f.depth = num(rec.depth, f.depth ?? 0) || undefined;
    if (rec.cost && typeof rec.cost === 'object') f.cost = rec.cost as Cost;
  }
  for (const g of GNOMES) {
    const rec = set[`gnomes/${g.id}`];
    if (Array.isArray(rec?.price)) g.price = rec.price as Price[];
  }
  for (const u of UPGRADES) {
    const rec = set[`upgrades/${u.id}`];
    if (!rec) continue;
    u.max = num(rec.max, u.max);
    if (Array.isArray(rec.price)) u.price = rec.price as Price[];
    if (Array.isArray(rec.table)) u.table = rec.table as number[];
    if (rec.base !== undefined) u.base = num(rec.base, u.base ?? 0);
    if (rec.per !== undefined) u.per = num(rec.per, u.per ?? 1);
    if (rec.depth !== undefined) u.depth = num(rec.depth, u.depth ?? 0);
  }
  for (const a of ABILITIES) {
    const rec = set[`abilities/${a.id}`];
    if (!rec) continue;
    a.len = num(rec.len, a.len);
    a.cd = num(rec.cd, a.cd);
  }
  for (const b of BEATS) {
    const rec = set[`beats/${b.id}`];
    if (!rec) continue;
    if (rec.after !== undefined) b.after = num(rec.after, b.after ?? 0);
    if (rec.peace !== undefined) b.peace = num(rec.peace, b.peace ?? 100);
    if (typeof rec.text === 'string' && typeof b.text === 'string') b.text = rec.text;
  }
}
