// The drawings the game is made of. Each is a thing of the engine like a
// record: look at it, lock it, hand it to the agent, or give a worker a brief
// to change it. What a worker draws comes back in the chat as a proposal with
// a picture before and after.
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';

interface Drawing { name: string; w: number; h: number; looks: string[]; anims: Record<string, number>; depth: boolean; locked: boolean }
interface Worker { worker: string; drawing: string; state: string; phase: string; doing: string; minutes: number }

export function artPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let open: string | undefined;
  const workersEl = h('div.workers');

  async function paintWorkers() {
    const list = (await app.act<Worker[]>('art.workers')) ?? [];
    clear(workersEl, list.length
      ? list.map((w) => h('div.item', { onclick: () => app.open('chat') },
        h('div.line', {}, h('b', {}, w.drawing), h('span.t-chip', {}, w.state === 'running' ? 'drawing' : w.state === 'waiting' ? (w.phase === 'silhouette' ? 'silhouette to approve' : 'to accept') : w.state)),
        h('p', {}, w.doing || '…'),
        h('div.t-row', {}, w.state === 'running'
          ? h<'button'>('button', { onclick: (ev: MouseEvent) => { ev.stopPropagation(); void app.act('art.stop', { worker: w.worker }).then(paintWorkers); } }, 'Stop')
          : h<'button'>('button.danger', { onclick: (ev: MouseEvent) => { ev.stopPropagation(); void app.act('art.close', { worker: w.worker }).then(paintWorkers); } }, 'Close it'))))
      : h('p.t-hint', {}, 'No worker is drawing. What one draws comes back in the chat as a proposal.'));
  }

  async function list() {
    open = undefined;
    const all = (await app.act<Drawing[]>('art.list')) ?? [];
    if (!body || open) return;
    const name = h<'input'>('input', { placeholder: 'a-new-drawing', 'aria-label': 'Name of a new drawing' });
    const brief = h<'textarea'>('textarea.small', { rows: 2, placeholder: 'What should it be? In plain words.', 'aria-label': 'Brief for a new drawing' });
    clear(body,
      all.map((d) => h('div.item', { onclick: () => void detail(d) },
        h('div.line', {}, h('b', {}, d.locked && '🔒 ', d.name), h('span.count', {}, `${d.w}×${d.h}`)),
        h('p', {}, `${Object.keys(d.anims).length} ${Object.keys(d.anims).length === 1 ? 'animation' : 'animations'}${d.looks.length > 1 ? ` · ${d.looks.length} looks` : ''}${d.depth ? ' · depth map' : ''}`))),
      !all.length && h('div.empty', {}, h('b', {}, 'This game has no drawings yet.')),
      h('h3', {}, 'A new drawing'),
      name, brief,
      h('div.t-row', {}, h<'button'>('button', { onclick: async () => {
        if (!name.value.trim() || !brief.value.trim()) return app.toast('Give it a name and a few words.');
        if (await app.act('art.ask', { name: name.value.trim(), message: brief.value.trim(), new: true })) { name.value = brief.value = ''; app.toast('A worker is drawing it.'); void paintWorkers(); }
      } }, 'Ask a worker')),
      h('h3', {}, 'Workers'),
      workersEl);
    void paintWorkers();
  }

  async function detail(d: Drawing) {
    open = d.name;
    if (!body) return;
    const pic = h('div.sheet', {}, h('div.working', {}, h('i.spin'), h('span', {}, 'Rendering…')));
    const brief = h<'textarea'>('textarea.small', { rows: 3, placeholder: 'What should change? In plain words.', 'aria-label': 'Brief for a worker' });
    const show = async (input: Record<string, unknown> = {}) => {
      const got = await app.act<{ url: string }>('art.look', { name: d.name, ...input });
      if (!body || open !== d.name || !got) return;
      clear(pic, h<'img'>('img', { src: got.url, alt: `${d.name}${input.anim ? `, ${input.anim}` : ''}`, onclick: () => app.zoom(got.url) }));
    };
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void list() }, '‹ Art'), h('b', {}, `${d.name} · ${d.w}×${d.h}`), h('span.grow'), app.lockButton(`drawing:${d.name}`, d.locked, (on) => { d.locked = on; })),
      pic,
      h('div.chips', {},
        h('span.t-chip.tap', { onclick: () => void show() }, 'all'),
        Object.entries(d.anims).map(([a, n]) => h('span.t-chip.tap', { onclick: () => void show({ anim: a }) }, n > 1 ? `${a} ×${n}` : a)),
        d.depth && h('span.t-chip.tap', { onclick: () => void show({ depth: true }) }, 'depth map')),
      d.looks.length > 1 && h('div.chips', {}, h('span.k', {}, 'looks'), d.looks.map((l) => h('span.t-chip.tap', { onclick: () => void show({ look: l }) }, l))),
      h('h3', {}, 'Change it'),
      brief,
      h('div.t-row', {},
        h<'button'>('button', { onclick: async () => {
          if (!brief.value.trim()) return app.toast('Say what should change.');
          if (await app.act('art.ask', { name: d.name, message: brief.value.trim() })) { brief.value = ''; app.toast('A worker is on it. Its drawing comes back in the chat.'); }
        } }, 'Ask a worker'),
        h<'button'>('button.primary', { onclick: () => app.attach(`drawing:${d.name}`) }, 'Talk about this')));
    void show();
  }

  return {
    id: 'art', title: 'Art',
    init(a) { app = a; },
    async show(b, _foot, id) {
      body = b;
      if (id ?? open) {
        const d = ((await app.act<Drawing[]>('art.list')) ?? []).find((x) => x.name === (id ?? open));
        if (d && body) return void detail(d);
      }
      void list();
    },
    hide() { body = undefined; },
    event(ev: Event, live) {
      if (!live || !body) return;
      if (!open && (ev.type === 'art.status' || ev.type === 'art.round' || ev.type === 'art.asked' || ev.type === 'proposal.decided')) void paintWorkers();
      if (!open && ev.type === 'art.changed') void list();
    },
  };
}
