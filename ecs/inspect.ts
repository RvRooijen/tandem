// The ECS side, made visible: what entities there are, what they are made of,
// which systems run over them and how those compiled. Everything here is a
// command, so the inspector panel in the page and the agent ask the same
// questions and get the same answers. It works on any world, in the page (the
// one being played) and on the server (the shared copy, a sandbox).
import { componentSchemas, profiler, queryDiagnostics, type ComponentDef, type EntityId } from 'archetype-ecs';
import { CommandError, type CommandDef } from '../core/commands.ts';
import type { GameModule, World } from '../core/game.ts';

type Row = Record<string, number | string>;
export interface EntityView { id: number; components: Record<string, Row> }

const round = (v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v) as number | string;

function rowOf(world: World, id: EntityId, def: ComponentDef): Row | undefined {
  const row = world.em.getComponent(id, def) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const out: Row = {};
  for (const k in row) out[k] = round(row[k]);
  return out;
}

export function entityView(world: World, game: GameModule, id: number): EntityView | undefined {
  if (!world.em.isAlive(id as EntityId)) return undefined;
  const components: Record<string, Row> = {};
  for (const name in game.components) {
    const def = game.components[name] as ComponentDef;
    if (world.em.hasComponent(id as EntityId, def)) components[name] = rowOf(world, id as EntityId, def) ?? {};
  }
  return { id, components };
}

const TYPES: Record<string, string> = {
  Float32Array: 'f32', Float64Array: 'f64', Int8Array: 'i8', Int16Array: 'i16', Int32Array: 'i32',
  Uint8Array: 'u8', Uint16Array: 'u16', Uint32Array: 'u32', Array: 'string',
};
const typeName = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'function' ? TYPES[v.name] ?? v.name : 'ref');

/** The fields of every component, with their types. */
export function schemas(game: GameModule): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name in game.components) {
    const def = game.components[name] as ComponentDef & { _sym: symbol };
    const schema = componentSchemas.get(def._sym) ?? {};
    out[name] = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, typeName(v)]));
  }
  return out;
}

/** How many entities there are of each make: the set of components they have. */
export function summary(world: World, game: GameModule) {
  const names = Object.keys(game.components);
  const groups = new Map<string, number>();
  const perComponent: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const ids = world.em.getAllEntities();
  for (const id of ids) {
    const has = names.filter((n) => world.em.hasComponent(id, game.components[n] as ComponentDef));
    for (const n of has) perComponent[n]++;
    const key = has.join(' + ') || '(nothing)';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return {
    entities: ids.length,
    archetypes: [...groups].map(([components, count]) => ({ components, count })).sort((a, b) => b.count - a.count),
    components: perComponent,
    schemas: schemas(game),
  };
}

type Cond = { component: string; field: string; op: string; value: number | string };

/** "Gnome.state=2, Pos.y>100" */
function parseWhere(where: string | undefined, game: GameModule): Cond[] {
  if (!where?.trim()) return [];
  return where.split(',').map((part) => {
    const m = part.trim().match(/^([A-Za-z]\w*)\.(\w+)\s*(<=|>=|!=|=|<|>)\s*(.+)$/);
    if (!m) throw new CommandError('input', `a condition is written Component.field=value (also != < > <= >=), not "${part.trim()}"`);
    if (!game.components[m[1]]) throw new CommandError('input', `there is no component called ${m[1]}; there are: ${Object.keys(game.components).join(', ')}`);
    const n = Number(m[4]);
    return { component: m[1], field: m[2], op: m[3], value: Number.isNaN(n) ? m[4].trim() : n };
  });
}

function holds(v: number | string | undefined, c: Cond): boolean {
  if (v === undefined) return false;
  switch (c.op) {
    case '=': return v == c.value;
    case '!=': return v != c.value;
    case '<': return v < c.value;
    case '>': return v > c.value;
    case '<=': return v <= c.value;
    default: return v >= c.value;
  }
}

export function find(world: World, game: GameModule, opts: { with?: string; where?: string; limit?: number }) {
  const need = (opts.with ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of need) if (!game.components[n]) throw new CommandError('input', `there is no component called ${n}; there are: ${Object.keys(game.components).join(', ')}`);
  const conds = parseWhere(opts.where, game);
  const defs = [...new Set([...need, ...conds.map((c) => c.component)])].map((n) => game.components[n] as ComponentDef);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
  const out: EntityView[] = [];
  let total = 0;
  for (const id of world.em.getAllEntities()) {
    if (!defs.every((d) => world.em.hasComponent(id, d))) continue;
    if (conds.length) {
      const ok = conds.every((c) => holds(rowOf(world, id, game.components[c.component] as ComponentDef)?.[c.field], c));
      if (!ok) continue;
    }
    total++;
    if (out.length < limit) out.push(entityView(world, game, id)!);
  }
  return { total, shown: out.length, entities: out };
}

/** The entities nearest a point, nearest first: what a finger on the stage is pointing at. */
export function near(world: World, game: GameModule, x: number, y: number, radius = 14) {
  const pos = game.position;
  if (!pos) throw new CommandError('unsupported', `${game.name} does not say which component is a position`);
  const def = game.components[pos.component] as ComponentDef;
  const hits: { d: number; id: number }[] = [];
  for (const id of world.em.getAllEntities()) {
    const row = rowOf(world, id, def);
    if (!row) continue;
    const d = Math.hypot(Number(row[pos.x]) - x, Number(row[pos.y]) - y);
    if (d <= radius) hits.push({ d, id });
  }
  hits.sort((a, b) => a.d - b.d);
  return { entities: hits.slice(0, 8).map((h) => ({ ...entityView(world, game, h.id)!, distance: Math.round(h.d * 10) / 10 })) };
}

/** The pipeline in the order it runs, and for each query how it was compiled and what it costs. */
export function systems(world: World) {
  const times = profiler.getData();
  return {
    order: world.systems,
    profiling: profiler.enabled,
    queries: queryDiagnostics.reports
      .filter((r) => world.systems.includes(r.query))
      // The same query is reported once per world that was made; the last one is this one's as much as any.
      .filter((r, i, all) => !all.slice(i + 1).some((x) => x.query === r.query))
      .map((r) => ({
        name: r.query, mode: r.mode, kernelOps: r.kernelOps, wasm: r.wasm, demoted: r.demoted,
        ms: times.get(r.query)?.avg !== undefined ? Math.round(times.get(r.query)!.avg * 1000) / 1000 : undefined,
        rows: times.get(r.query)?.rows,
        inJs: r.statements.filter((s) => !s.compiled).map((s) => ({ source: s.source.slice(0, 120), hint: s.hint })),
      })),
  };
}

export function ecsCommands(world: (room?: string) => World, game: GameModule, canWrite: (room: string | undefined, by: string) => void): CommandDef[] {
  return [
    {
      name: 'ecs.summary', kind: 'read',
      about: 'The world at a glance: how many entities, which makes of entity there are (by the components they have), and the fields of every component.',
      input: { room: 'string?' },
      run: (_c, i) => summary(world(i.room), game),
    },
    {
      name: 'ecs.entities', kind: 'read',
      about: 'Find entities. with is a comma list of components they must have; where is conditions like "Gnome.state=2, Pos.y>100"; limit defaults to 20.',
      input: { with: 'string?', where: 'string?', limit: 'number?', room: 'string?' },
      run: (_c, i) => find(world(i.room), game, i),
    },
    {
      name: 'ecs.entity', kind: 'read',
      about: 'One entity by id: every component it has, with every value.',
      input: { id: 'number', room: 'string?' },
      run(_c, i) {
        const e = entityView(world(i.room), game, i.id);
        if (!e) throw new CommandError('missing', `entity ${i.id} is not alive`);
        return e;
      },
    },
    {
      name: 'ecs.at', kind: 'read',
      about: 'The entities near a point of the world (in world units), nearest first: what is standing there.',
      input: { x: 'number', y: 'number', radius: 'number?', room: 'string?' },
      run: (_c, i) => near(world(i.room), game, i.x, i.y, i.radius),
    },
    {
      name: 'ecs.systems', kind: 'read',
      about: 'The systems of the pipeline in the order they run, and for each query whether it compiled to a kernel, runs partly in JS, and what it costs per tick when profiling is on.',
      input: { room: 'string?' },
      run: (_c, i) => systems(world(i.room)),
    },
    {
      name: 'ecs.profile', kind: 'write', agent: 'free',
      about: 'Turn timing of the systems on or off. Costs a little while it is on.',
      input: { on: 'boolean' },
      run(_c, i) { profiler.setEnabled(i.on); return { profiling: profiler.enabled }; },
    },
    {
      name: 'ecs.set', kind: 'write', agent: 'free',
      about: 'Poke a value into an entity: one field of one component. For trying things out; the agent can only do this in a sandbox room.',
      input: { id: 'number', component: 'string', field: 'string', value: 'number', room: 'string?' },
      run(c, i) {
        canWrite(i.room, c.by);
        const w = world(i.room);
        const def = game.components[i.component] as ComponentDef | undefined;
        if (!def) throw new CommandError('input', `there is no component called ${i.component}`);
        const row = w.em.getComponent(i.id as EntityId, def) as Record<string, unknown> | undefined;
        if (!row) throw new CommandError('missing', `entity ${i.id} has no ${i.component}`);
        if (!(i.field in row)) throw new CommandError('input', `${i.component} has no field ${i.field}; it has: ${Object.keys(row).join(', ')}`);
        w.em.replaceComponent(i.id as EntityId, def, { ...row, [i.field]: i.value } as never);
        return entityView(w, game, i.id);
      },
    },
  ];
}
