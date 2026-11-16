// The drawings the project is made of, and the drawing work on them. A drawing
// is a thing of the engine like a concept: look at it, lock it, hand it to the
// agent. Drawing work is asked for in the chat and judged by the agent; a
// worker is watched here, live: its drawing appears as it is typed, then its
// round with a picture before and after, and what the agent made of it.
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { drawArt } from '../artview.ts';
import { clear, h, prose } from '../dom.ts';
import { icon } from '../icons.ts';

interface Drawing { name: string; w: number; h: number; looks: string[]; anims: Record<string, number>; depth: boolean; locked: boolean }
interface Open { worker: string; drawing: string; state: string; phase: string; doing: string; minutes: number }

/** What is known of a worker, from the events: what it draws, how it is doing, what it proposes. */
interface Seen {
  id: string;
  name: string;
  state: string;
  phase: string;
  doing: string;
  said: string;
  /** What it was asked and told, in order. */
  asked: string[];
  pictures?: { before?: string; after?: string; looks?: { look: string; before?: string; after?: string }[] };
  isNew?: boolean;
  /** Its round was accepted or rejected: it is done. */
  decided?: string;
  /** The drawing as it is being typed, the last version that came in. */
  draft?: string;
}

export function artPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let open: { drawing: string } | { worker: string } | undefined;
  const seen = new Map<string, Seen>();
  const workersEl = h('div.workers');
  /** The parts of the worker view that change while it is open. */
  let live: { id: string; canvas: HTMLCanvasElement; rest: HTMLElement; looks: HTMLElement } | undefined;

  /** Draw a worker's drawing as it is now, and say which looks are which. */
  function drawLive(text: string) {
    if (!live) return;
    const looks = drawArt(live.canvas, text);
    if (looks) live.looks.textContent = looks.length > 1 ? `Every look, top to bottom: ${looks.join(' · ')}` : '';
  }

  const know = (id: string, name = ''): Seen => {
    let w = seen.get(id);
    if (!w) { w = { id, name, state: 'running', phase: 'color', doing: '', said: '', asked: [] }; seen.set(id, w); }
    if (name) w.name = name;
    return w;
  };
  const stateWords = (w: { state: string; phase: string }) =>
    w.state === 'running' ? 'drawing' : w.state === 'waiting' ? (w.phase === 'silhouette' ? 'silhouette, with the agent' : 'with the agent') : w.state;

  async function paintWorkers() {
    const list = (await app.act<Open[]>('art.workers')) ?? [];
    for (const o of list) Object.assign(know(o.worker, o.drawing), { state: o.state, phase: o.phase, doing: o.doing });
    clear(workersEl, list.length
      ? list.map((w) => h('div.item', { onclick: () => void workerView(w.worker) },
        h('div.line', {}, h('b', {}, w.drawing), h('span.t-chip', { data: { state: w.state } }, stateWords(w))),
        h('p', {}, w.doing || '…')))
      : h('p.t-hint', {}, 'No worker is drawing. When one does, you watch it here.'));
  }

  /** The drawings as they were last listed: shown at once when the tab is opened, and listed again behind it. */
  let drawings: Drawing[] | undefined;

  async function list(atOnce = false) {
    open = undefined; live = undefined;
    if (atOnce && drawings && body) paintList(drawings);
    const all = await app.act<Drawing[]>('art.list');
    if (!all) return;
    const same = !!drawings && JSON.stringify(all) === JSON.stringify(drawings);
    drawings = all;
    if (!body || open) return;
    if (!same || !body.contains(workersEl)) paintList(all);
    else void paintWorkers();
  }

  function paintList(all: Drawing[]) {
    if (!body) return;
    clear(body,
      h('h3', {}, 'Workers'),
      workersEl,
      h('h3', {}, 'Drawings'),
      all.map((d) => h('div.item.drawing', { onclick: () => void detail(d) },
        h('div.line', {}, h('b', {}, d.locked && [icon('lock'), ' '], d.name), h('span.count', {}, `${d.w}×${d.h}`)),
        h('p', {}, `${Object.keys(d.anims).length} ${Object.keys(d.anims).length === 1 ? 'animation' : 'animations'}${d.looks.length > 1 ? ` · ${d.looks.length} looks` : ''}${d.depth ? ' · depth map' : ''}`))),
      !all.length && h('div.empty', {}, h('b', {}, 'This project has no drawings yet.')),
      h('p.t-hint', {}, 'New drawings and changes are asked for in the chat: say what you want, and point at a drawing with @.'));
    void paintWorkers();
  }

  async function detail(d: Drawing) {
    open = { drawing: d.name }; live = undefined;
    if (!body) return;
    const pic = h('div.sheet', {}, h('div.working', {}, h('i.spin'), h('span', {}, 'Rendering…')));
    const mine = () => open && 'drawing' in open && open.drawing === d.name;
    const show = async (input: Record<string, unknown> = {}) => {
      const got = await app.act<{ url: string }>('art.look', { name: d.name, ...input });
      if (!body || !mine() || !got) return;
      clear(pic, h<'img'>('img', { src: got.url, alt: `${d.name}${input.anim ? `, ${input.anim}` : ''}`, onclick: () => app.zoom(got.url) }));
    };
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void list() }, icon('back'), 'Art'), h('b', {}, `${d.name} · ${d.w}×${d.h}`), h('span.grow'), app.lockButton(`drawing:${d.name}`, d.locked, (on) => { d.locked = on; })),
      pic,
      h('div.chips', {},
        h('span.t-chip.tap', { onclick: () => void show() }, 'all'),
        Object.entries(d.anims).map(([a, n]) => h('span.t-chip.tap', { onclick: () => void show({ anim: a }) }, n > 1 ? `${a} ×${n}` : a)),
        d.depth && h('span.t-chip.tap', { onclick: () => void show({ depth: true }) }, 'depth map')),
      d.looks.length > 1 && h('div.chips', {}, h('span.k', {}, 'looks'), d.looks.map((l) => h('span.t-chip.tap', { onclick: () => void show({ look: l }) }, l))),
      h('div.t-row', {}, h<'button'>('button.primary', { onclick: () => app.attach(`drawing:${d.name}`) }, 'Talk about this')),
      h('p.t-hint', {}, 'A change to it is asked for in the chat.'));
    void show();
  }

  // ---------------------------------------------------------------- a worker, watched

  /** Everything under the live drawing: how it is doing, what it said, and what became of it. Deciding is the agent's. */
  function paintWorker(w: Seen, rest: HTMLElement) {
    const pic = (url: string | undefined, label: string) => url && h('figure', { onclick: () => app.zoom(url) }, h<'img'>('img', { src: url, alt: `${w.name}, ${label}` }), h('figcaption', {}, label));
    clear(rest,
      w.state === 'running' && h('div.working', {}, h('i.spin'), h('span', {}, w.doing || 'starting'), h<'button'>('button', { onclick: () => void app.act('art.stop', { worker: w.id }) }, 'Stop')),
      w.decided && h(`div.${w.decided === 'accepted' ? 'pass' : 'fail'}`, {}, w.decided === 'accepted' ? 'Accepted: it is in the game.' : 'Rejected: the game was left as it is.'),
      !w.decided && w.state === 'failed' && h('div.fail', {}, `It failed: ${w.doing}`),
      !w.decided && w.state === 'stopped' && h('p.t-hint', {}, 'It was stopped. The agent decides what happens with it.'),
      !w.decided && w.state === 'waiting' && h('p.t-hint.judged', {}, w.phase === 'silhouette' ? 'The agent looks at the silhouette: it approves it, or sends the worker round again.' : 'The agent looks at the drawing: it takes it into the project, or sends the worker round again.'),
      w.said && w.state !== 'failed' && h('div.said', {}, prose(w.said)),
      // A drawing with looks is compared look by look: the change may be in any of them.
      w.state !== 'running' && w.pictures?.after && (w.pictures.looks?.length
        ? [
          // A drawing that had no looks before: how it is, once, above the looks it would get.
          !w.pictures.looks.some((l) => l.before) && w.pictures.before && h('div.pictures', {}, pic(w.pictures.before, 'as it is')),
          w.pictures.looks.map((l) => h('div.pictures', {}, pic(l.before, `${l.look}, as it is`), pic(l.after, l.before ? `${l.look}, as proposed` : `${l.look}, new`), !l.after && h('div.note', {}, `${l.look} would be gone`))),
        ]
        : h('div.pictures', {}, pic(w.pictures.before, 'as it is'), pic(w.pictures.after, w.phase === 'silhouette' ? 'the silhouette' : w.isNew ? 'new' : 'as proposed'))),
      w.asked.length > 0 && [h('h3', {}, 'Asked'), w.asked.map((a) => h('p.t-hint', {}, a))]);
  }

  async function workerView(id: string) {
    open = { worker: id };
    if (!body) return;
    const w = know(id);
    const canvas = h<'canvas'>('canvas.live', { 'aria-label': `${w.name || 'the drawing'}, as the worker has it` });
    const rest = h('div.worker-rest');
    const looks = h('p.t-hint.looks');
    live = { id, canvas, rest, looks };
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void list() }, icon('back'), 'Art'), h('b', {}, w.name || 'a worker'), h('span.grow'), h('span.t-chip', {}, w.decided ?? stateWords(w))),
      h('div.stage-live', {}, canvas),
      looks,
      rest);
    paintWorker(w, rest);
    // What it has drawn so far; from here on its typing comes in by itself.
    if (w.draft) drawLive(w.draft);
    else if (!w.decided && w.name) {
      const got = await app.act<{ text: string }>('art.get', { name: w.name, worker: id });
      if (got?.text && live?.id === id && !w.draft) drawLive(got.text);
    }
  }

  /** Something about a worker changed: if it is the one being watched, show it. */
  function refresh(w: Seen) {
    if (live?.id !== w.id || !body) return;
    paintWorker(w, live.rest);
    const chip = body.querySelector('.bar .t-chip'), title = body.querySelector('.bar b');
    if (chip) chip.textContent = w.decided ?? stateWords(w);
    if (title && w.name) title.textContent = w.name;
  }

  return {
    id: 'art', title: 'Art',
    init(a) { app = a; },
    async show(b, _foot, id) {
      body = b;
      if (id?.startsWith('worker:')) return void workerView(id.slice(7));
      if (!id && open && 'worker' in open) return void workerView(open.worker);
      const name = id ?? (open && 'drawing' in open ? open.drawing : undefined);
      if (name) {
        // (A drawing that was listed before is opened from that; one that is new since is asked for.)
        const d = drawings?.find((x) => x.name === name) ?? (drawings = (await app.act<Drawing[]>('art.list')) ?? drawings)?.find((x) => x.name === name);
        if (d && body) return void detail(d);
      }
      void list(true);
    },
    hide() { body = undefined; live = undefined; },
    event(ev: Event) {
      // The workers are followed whether or not the tab is showing, so it is all there when it is opened.
      switch (ev.type) {
        case 'art.asked': {
          const w = know(String(ev.worker), String(ev.name));
          w.asked.push(String(ev.message));
          w.isNew = !!ev.isNew;
          refresh(w);
          break;
        }
        case 'art.told': {
          const w = know(String(ev.worker), String(ev.name));
          w.asked.push(String(ev.message));
          refresh(w);
          break;
        }
        case 'art.status': {
          const w = know(String(ev.worker), String(ev.name));
          Object.assign(w, { state: String(ev.state), phase: String(ev.phase), doing: String(ev.doing ?? '') });
          if (w.state === 'closed') w.decided ??= 'rejected';
          refresh(w);
          break;
        }
        case 'art.draft': {
          const w = know(String(ev.worker));
          if (ev.depth) break;                    // the depth map is not what is being watched
          w.draft = String(ev.text);
          if (live?.id === w.id) drawLive(w.draft);
          break;
        }
        case 'art.round': {
          const w = know(String(ev.worker), String(ev.name));
          Object.assign(w, { state: String(ev.state), phase: String(ev.phase), said: String(ev.text ?? ''), doing: ev.state === 'failed' ? String(ev.text ?? '') : '' });
          refresh(w);
          break;
        }
        case 'proposal': {
          if (!ev.worker) break;
          const w = know(String(ev.worker), String(ev.path));
          Object.assign(w, { pictures: ev.pictures, phase: String(ev.phase), isNew: !!ev.isNew, said: String(ev.note ?? w.said) });
          refresh(w);
          break;
        }
        case 'proposal.decided': {
          const w = seen.get(String(ev.round));
          if (w) { w.decided = String(ev.status); w.state = 'closed'; refresh(w); }
          break;
        }
        default:
      }
      if (body && !open && ['art.status', 'art.round', 'art.asked', 'proposal.decided'].includes(ev.type)) void paintWorkers();
      if (body && !open && ev.type === 'art.changed') void list();
    },
  };
}
