// The ECS side of the world being played: what entities there are and what
// they are made of, one entity with every value (live), and the systems that
// run over them. With "pick" on, a finger on the game asks what is there
// instead of playing.
import type { EntityView } from '../../ecs/inspect.ts';
import { run } from '../api.ts';
import type { App, Panel } from '../app.ts';
import { clear, h, num } from '../dom.ts';

interface Summary { entities: number; archetypes: { components: string; count: number }[]; schemas: Record<string, Record<string, string>> }
interface Systems { order: string[]; profiling: boolean; queries: { name: string; mode: string; kernelOps: number; ms?: number; rows?: number; inJs: { source: string; hint?: string }[] }[] }

export function inspectPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let view: { kind: 'home' } | { kind: 'list'; with: string } | { kind: 'entity'; id: number } = { kind: 'home' };
  let timer = 0;
  let picking = false;

  const stop = () => { clearInterval(timer); timer = 0; };

  function setPick(on: boolean) {
    picking = on;
    app.page.intercept = on ? (x, y) => void picked(x, y) : null;
    document.body.classList.toggle('t-picking', on);
  }

  async function picked(x: number, y: number) {
    const hit = await app.act<{ entities: (EntityView & { distance: number })[] }>('ecs.at', { x, y, radius: 16 });
    app.point(x, y, hit?.entities.length ? `entity ${hit.entities[0].id}` : 'nothing here');
    if (!hit?.entities.length) return;
    if (hit.entities.length === 1) return void entity(hit.entities[0].id);
    view = { kind: 'home' };
    stop();
    if (!body) return;
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void home() }, '‹ Inspect'), h('b', {}, `${hit.entities.length} things there`)),
      hit.entities.map((e) => entityRow(e)));
  }

  const entityRow = (e: EntityView) => h('div.item', { onclick: () => void entity(e.id) },
    h('div.line', {}, h('b', {}, `#${e.id}`), h('span.count', {}, Object.keys(e.components).join(' + '))),
    h('p', {}, Object.entries(e.components).flatMap(([c, row]) => Object.entries(row).slice(0, 3).map(([k, v]) => `${c}.${k} ${typeof v === 'number' ? num(v) : v}`)).slice(0, 5).join(' · ')));

  const pickBtn = () => h<'button'>(`button${picking ? '.on' : ''}`, { onclick: (ev: MouseEvent) => { setPick(!picking); (ev.currentTarget as HTMLElement).classList.toggle('on', picking); if (picking) app.toast('Touch something in the game.'); } }, '◎ Pick in the game');

  async function home() {
    stop();
    view = { kind: 'home' };
    const [sum, sys] = await Promise.all([app.act<Summary>('ecs.summary'), app.act<Systems>('ecs.systems')]);
    if (!body || view.kind !== 'home' || !sum || !sys) return;
    const paint = (s: Summary, y: Systems) => clear(body!,
      h('div.t-row', {}, pickBtn(),
        h<'button'>(`button${y.profiling ? '.on' : ''}`, { onclick: async () => { await app.act('ecs.profile', { on: !y.profiling }); void home(); } }, y.profiling ? 'Timing on' : 'Time the systems')),
      h('h3', {}, `${s.entities} entities`),
      s.archetypes.map((a) => h('div.item', { onclick: () => void list(a.components.replace(/ \+ /g, ',')) },
        h('div.line', {}, h('b', {}, a.components), h('span.count', {}, `×${a.count}`)))),
      h('h3', {}, 'Systems, in the order they run'),
      y.order.map((name, i) => {
        const q = y.queries.find((x) => x.name === name);
        return h('div.item.sys-row', {},
          h('div.line', {}, h('b', {}, `${i + 1}. ${name}`),
            h('span.t-chip.mode', { data: { mode: q?.mode ?? 'fn' } }, q ? (q.mode === 'kernel' ? `kernel · ${q.kernelOps} ops` : q.mode) : 'function'),
            q?.ms !== undefined && h('span.count', {}, `${q.ms} ms${q.rows ? ` · ${q.rows} rows` : ''}`)),
          q?.inJs.map((s2) => h('p', {}, `in JS: ${s2.source}${s2.hint ? ` (${s2.hint})` : ''}`)));
      }),
      h('h3', {}, 'Components'),
      Object.entries(s.schemas).map(([name, fields]) => h('div.item', { onclick: () => void list(name) },
        h('div.line', {}, h('b', {}, name)), h('p', {}, Object.entries(fields).map(([k, t]) => `${k}: ${t}`).join(', ')))));
    paint(sum, sys);
    // The counts move as the game does.
    timer = window.setInterval(async () => {
      if (!body || view.kind !== 'home') return stop();
      const [s, y] = await Promise.all([app.act<Summary>('ecs.summary'), app.act<Systems>('ecs.systems')]);
      if (body && view.kind === 'home' && s && y && !body.querySelector(':focus')) { const top = body.scrollTop; paint(s, y); body.scrollTop = top; }
    }, 2500);
  }

  async function list(withComponents: string) {
    stop();
    view = { kind: 'list', with: withComponents };
    const found = await app.act<{ total: number; entities: EntityView[] }>('ecs.entities', { with: withComponents, limit: 60 });
    if (!body || view.kind !== 'list' || !found) return;
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void home() }, '‹ Inspect'), h('b', {}, `${found.total} with ${withComponents.replace(/,/g, ' + ')}`)),
      found.entities.map(entityRow),
      found.total > found.entities.length && h('p.t-hint', {}, `The first ${found.entities.length}.`));
  }

  async function entity(id: number) {
    stop();
    view = { kind: 'entity', id };
    const cells = new Map<string, HTMLElement>();
    const first = await app.act<EntityView>('ecs.entity', { id });
    if (!body || view.kind !== 'entity' || view.id !== id) return;
    if (!first) return void home();
    const pos = app.game.position;
    const where = () => {
      const row = pos && first.components[pos.component];
      return row ? { x: Number(cells.get(`${pos!.component}.${pos!.x}`)?.dataset.v ?? row[pos!.x]), y: Number(cells.get(`${pos!.component}.${pos!.y}`)?.dataset.v ?? row[pos!.y]) } : undefined;
    };
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void home() }, '‹ Inspect'), h('b', {}, `Entity #${id}`)),
      h('div.t-row', {}, pickBtn(),
        where() && h<'button'>('button', { onclick: () => { const p = where()!; app.point(p.x, p.y, `#${id}`); } }, 'Show it'),
        h<'button'>('button.primary', { onclick: () => app.attach(`entity:${id}`) }, 'Talk about this')),
      Object.entries(first.components).map(([name, row]) => h('div.comp', {},
        h('h3', {}, name),
        Object.entries(row).map(([k, v]) => {
          const cell = h('span.v', { data: { v: String(v) } }, typeof v === 'number' ? num(v) : String(v));
          cells.set(`${name}.${k}`, cell);
          return h('div.kv', { onclick: () => void poke(id, name, k, cell) }, h('span.k', {}, k), cell);
        }))),
      h('p.t-hint', {}, 'Touch a value to change it in the running game.'));
    timer = window.setInterval(async () => {
      if (!body || view.kind !== 'entity' || view.id !== id) return stop();
      let now: EntityView | undefined;
      try { now = await run<EntityView>('ecs.entity', { id }); } catch { /* it is gone */ }
      if (!now) { stop(); if (body && view.kind === 'entity') body.append(h('p.fail', {}, 'It is gone.')); return; }
      for (const [name, row] of Object.entries(now.components))
        for (const [k, v] of Object.entries(row)) {
          const cell = cells.get(`${name}.${k}`);
          const textNow = typeof v === 'number' ? num(v) : String(v);
          if (cell && cell.textContent !== textNow) { cell.textContent = textNow; cell.dataset.v = String(v); cell.classList.remove('blink'); void cell.offsetWidth; cell.classList.add('blink'); }
        }
    }, 400);
  }

  async function poke(id: number, component: string, field: string, cell: HTMLElement) {
    const said = prompt(`${component}.${field} of entity ${id}`, cell.dataset.v ?? '');
    if (said === null || said.trim() === '' || Number.isNaN(Number(said))) return;
    await app.act('ecs.set', { id, component, field, value: Number(said) });
  }

  return {
    id: 'inspect', title: 'Inspect',
    init(a) { app = a; },
    show(b, _foot, id) {
      body = b;
      if (id && !Number.isNaN(Number(id))) void entity(Number(id));
      else if (view.kind === 'entity') void entity(view.id);
      else if (view.kind === 'list') void list(view.with);
      else void home();
    },
    hide() { body = undefined; stop(); setPick(false); },
  };
}
