// The content: every number and line the game is made of, as records. Kinds,
// the records of a kind, and one record with its fields to change. A change
// made here is made at once (it is the person's); the agent's arrive as
// proposals and are shown next to the field they would change.
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { clear, h, short } from '../dom.ts';

type Rec = Record<string, unknown>;
interface Pending { round: string; path: string; kind: string; after: Rec; note: string }

export function contentPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let at: { kind?: string; path?: string } = {};
  let dirty = false;

  async function kinds() {
    at = {};
    const paths = (await app.act<string[]>('records.list')) ?? [];
    if (!body || at.kind || at.path) return;
    const count = new Map<string, number>();
    for (const p of paths) count.set(p.split('/')[0], (count.get(p.split('/')[0]) ?? 0) + 1);
    clear(body,
      h('p.t-hint', {}, 'Everything the game is tuned with. Change a field and the game in the page follows at once.'),
      [...count].map(([kind, n]) => h('div.item', { onclick: () => void records(kind) }, h('div.line', {}, h('b', {}, kind), h('span.count', {}, String(n))))));
  }

  async function records(kind: string) {
    at = { kind };
    const [all = {}, locks = []] = await Promise.all([app.act<Record<string, Rec>>('records.get', { path: `${kind}/*` }), app.act<string[]>('locks.list')]);
    if (!body || at.kind !== kind || at.path) return;
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void kinds() }, '‹ Content'), h('b', {}, kind)),
      Object.entries(all).map(([path, rec]) => h('div.item', { onclick: () => void record(path) },
        h('div.line', {}, h('b', {}, locks.includes(`record:${path}`) && '🔒 ', String(rec.name ?? path.split('/')[1]))),
        h('p', {}, Object.entries(rec).filter(([k]) => k !== 'name').slice(0, 4).map(([k, v]) => `${k} ${short(v, 22)}`).join(' · ')))));
  }

  async function record(path: string) {
    const kind = path.split('/')[0];
    at = { kind, path };
    const [rec, pending, locks] = await Promise.all([
      app.act<Rec>('records.get', { path }),
      app.act<Pending[]>('proposals.list', { status: 'pending' }),
      app.act<string[]>('locks.list'),
    ]);
    if (!body || at.path !== path) return;
    if (!rec) return void records(kind);
    dirty = false;
    const draft: Rec = {};
    const saveBtn = h<'button'>('button.primary', { disabled: true, onclick: () => void save() }, 'Saved');
    const proposed = (pending ?? []).filter((p) => p.kind === 'record' && p.path === path);

    async function save() {
      if (!Object.keys(draft).length) return;
      const bad = Object.entries(draft).find(([, v]) => v === undefined);
      if (bad) return app.toast(`${bad[0]} is not valid JSON yet`);
      if ((await app.act('records.set', { path, value: draft })) === undefined) return;
      Object.assign(rec!, draft);
      for (const k in draft) delete draft[k];
      dirty = false;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saved';
    }

    const field = (key: string, value: unknown) => {
      const changed = (v: unknown) => {
        if (JSON.stringify(v) === JSON.stringify(rec![key])) delete draft[key]; else draft[key] = v;
        dirty = Object.keys(draft).length > 0;
        saveBtn.disabled = !dirty;
        saveBtn.textContent = dirty ? 'Save' : 'Saved';
      };
      let input: HTMLElement;
      if (typeof value === 'number')
        input = h<'input'>('input', { type: 'number', inputMode: 'decimal', step: 'any', value: String(value), 'aria-label': key,
          oninput: (ev: InputEvent) => { const v = (ev.target as HTMLInputElement).value; changed(v === '' ? rec![key] : Number(v)); } });
      else if (typeof value === 'string')
        input = h<'textarea'>('textarea.small', { value, rows: Math.min(6, 1 + Math.floor(value.length / 34)), 'aria-label': key, oninput: (ev: InputEvent) => changed((ev.target as HTMLTextAreaElement).value) });
      else {
        // A list or a table: as JSON, checked as it is typed.
        const el = h<'textarea'>('textarea.small.json', { value: JSON.stringify(value), rows: Math.min(6, 1 + Math.floor(JSON.stringify(value).length / 34)), 'aria-label': key, spellcheck: false });
        el.addEventListener('input', () => {
          try { changed(JSON.parse(el.value)); el.classList.remove('bad'); } catch { draft[key] = undefined; el.classList.add('bad'); dirty = true; saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        });
        input = el;
      }
      const wants = proposed.filter((p) => key in p.after);
      return h('label.field-edit', {}, h('span.k', {}, key), input,
        wants.map((p) => h('div.wants', { onclick: () => app.open('chat') }, 'the agent proposes ', h('b', {}, short(p.after[key], 40)), p.note && ` · ${p.note}`)));
    };

    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void leave(() => records(kind)) }, `‹ ${kind}`), h('span.grow'), app.lockButton(`record:${path}`, !!locks?.includes(`record:${path}`)), saveBtn),
      h('h2', {}, path),
      Object.entries(rec).map(([k, v]) => field(k, v)),
      h('div.t-row', {}, h<'button'>('button.primary', { onclick: () => void leave(() => app.attach(`record:${path}`)) }, 'Talk about this')));

    async function leave(then: () => unknown) {
      if (dirty) await save();
      then();
    }
  }

  return {
    id: 'content', title: 'Content',
    init(a) { app = a; },
    show(b, _foot, id) {
      body = b;
      void (id ? record(id) : at.path ? record(at.path) : at.kind ? records(at.kind) : kinds());
    },
    hide() { body = undefined; },
    event(ev: Event, live) {
      if (!live || !body || dirty) return;
      if ((ev.type === 'record.changed' && ev.by !== 'me') || ev.type === 'proposal.decided' || ev.type === 'proposal') {
        if (at.path) void record(at.path);
      }
    },
  };
}
