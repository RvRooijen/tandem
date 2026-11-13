// The drawings the game is made of. Look at one, hand it to the agent, or ask
// a pixeldraw worker to change it; what the workers are doing; and bringing
// accepted drawings into the game.
import type { Event } from '../../core/events.ts';
import type { Drawing } from '../../core/game.ts';
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';

export function artPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let open: string | undefined;

  async function list() {
    open = undefined;
    const all = (await app.act<Drawing[]>('art.list')) ?? [];
    if (!body || open) return;
    const workers = h('pre.workers', {}, 'Looking…');
    const refresh = async () => {
      const w = await app.act<{ workers: string }>('art.workers');
      workers.textContent = w ? w.workers : 'pixeldraw is not answering.';
      const ids = [...(w?.workers ?? '').matchAll(/^(w[a-z0-9]+)\s/gm)].map((m) => m[1]);
      clear(acts, ids.map((id) => h('div.t-row', {},
        h('span.k', {}, id),
        h<'button'>('button', { onclick: async () => { await app.act('art.approve', { worker: id }); void refresh(); } }, 'Approve'),
        h<'button'>('button.primary', { onclick: async () => { if (await app.act('art.accept', { worker: id })) app.toast('Accepted. Bring it into the game below.'); void refresh(); } }, 'Accept'))));
    };
    const acts = h('div');
    const name = h<'input'>('input', { placeholder: 'a-new-drawing', 'aria-label': 'Name of a new drawing' });
    const brief = h<'textarea'>('textarea.small', { rows: 2, placeholder: 'What should it be? In plain words.', 'aria-label': 'Brief for a new drawing' });
    clear(body,
      all.map((d) => h('div.item', { onclick: () => void detail(d) },
        h('div.line', {}, h('b', {}, d.name), h('span.count', {}, `${d.w}×${d.h}`)),
        h('p', {}, Object.entries(d.looks).map(([look, anims]) => `${Object.keys(d.looks).length > 1 ? `${look}: ` : ''}${Object.keys(anims).length} animations`).slice(0, 3).join(' · ')))),
      !all.length && h('div.empty', {}, h('b', {}, 'This game does not say what its drawings are.')),
      h('h3', {}, 'A new drawing'),
      name, brief,
      h('div.t-row', {}, h<'button'>('button', { onclick: async () => {
        if (!name.value.trim() || !brief.value.trim()) return app.toast('Give it a name and a few words.');
        if (await app.act('art.ask', { name: name.value.trim(), message: brief.value.trim(), new: true })) { name.value = brief.value = ''; app.toast('A worker is drawing it.'); void refresh(); }
      } }, 'Ask a worker')),
      h('h3', {}, 'Workers in pixeldraw'),
      workers, acts,
      h('div.t-row', {},
        h<'button'>('button', { onclick: () => void refresh() }, 'Look again'),
        h<'button'>('button', { onclick: async (ev: MouseEvent) => {
          const b = ev.currentTarget as HTMLButtonElement;
          b.disabled = true; b.textContent = 'Bringing them in…';
          const done = await app.act<{ imported: number }>('art.import');
          b.disabled = false; b.textContent = 'Bring drawings into the game';
          if (done) app.toast(`${done.imported} drawings brought in. The page reloads when it is rebuilt.`);
        } }, 'Bring drawings into the game')),
      h('p.t-hint', {}, 'A worker draws in pixeldraw and waits there with a silhouette first. Its own viewer is the place to watch it.'));
    void refresh();
  }

  async function detail(d: Drawing) {
    open = d.name;
    if (!body) return;
    const pic = h('div.sheet', {}, h('div.working', {}, h('i.spin'), h('span', {}, 'Drawing the sheet…')));
    const brief = h<'textarea'>('textarea.small', { rows: 3, placeholder: 'What should change? In plain words.', 'aria-label': 'Brief for a worker' });
    const look = Object.keys(d.looks)[0];
    const show = async (lk: string, anim?: string) => {
      const got = await app.act<{ url: string; frames: string[] }>('art.look', { name: d.name, look: lk, ...(anim && { anim }) });
      if (!body || open !== d.name || !got) return;
      clear(pic, h<'img'>('img', { src: got.url, alt: `${d.name}: ${got.frames.join(', ')}`, onclick: () => app.zoom(got.url) }), h('p.t-hint', {}, got.frames.join(' · ')));
    };
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void list() }, '‹ Art'), h('b', {}, `${d.name} · ${d.w}×${d.h}`)),
      pic,
      Object.entries(d.looks).map(([lk, anims]) => h('div.chips', {},
        Object.keys(d.looks).length > 1 && h('span.k', {}, lk),
        h('span.t-chip.tap', { onclick: () => void show(lk) }, 'all'),
        Object.entries(anims).map(([a, n]) => h('span.t-chip.tap', { onclick: () => void show(lk, a) }, n > 1 ? `${a} ×${n}` : a)))),
      h('h3', {}, 'Change it'),
      brief,
      h('div.t-row', {},
        h<'button'>('button', { onclick: async () => {
          if (!brief.value.trim()) return app.toast('Say what should change.');
          if (await app.act('art.ask', { name: d.name, message: brief.value.trim() })) { brief.value = ''; app.toast('A worker is on it.'); }
        } }, 'Ask a worker'),
        h<'button'>('button.primary', { onclick: () => app.attach(`drawing:${d.name}`) }, 'Talk about this')));
    void show(look);
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
      // New drawings are in the code now; the bundler reloads the page by itself, this is for when it does not.
      if (live && ev.type === 'art.imported' && body && !open) void list();
    },
  };
}
