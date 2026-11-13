// The stage: the project's own page, in a frame that fills the screen, with
// tandem's tools over it. The frame shows the project, or the agent's working
// copy of it. Every page is shown through tandem and gets a few lines of
// tandem's on the way (bridge/page.js): with those, something on it can be
// found by the words on it. A page that uses the bridge
// (bridge/tandem.bridge.ts) also tells tandem the world being played and where
// things in that world are.
import { reachable, type Info } from './api.ts';
import { clear, h } from './dom.ts';

/** Something on the project's page, as the page says it is: where, what is written on it, and how the code would name it. */
export interface Picked { x: number; y: number; w: number; h: number; words: string; tag: string; selector: string; path: string }

export interface Stage {
  /** What the frame shows now. */
  showing: 'project' | 'copy';
  /** What the page in the frame can do, as far as it has said. */
  can: { snapshot: boolean; point: boolean; find: boolean };
  /** Show the agent's working copy, started from the world the person is in; or the project again. */
  showCopy(url: string): void;
  showProject(): void;
  /** Where a point of the project's world is on this screen; null when the page does not say. */
  where(x: number, y: number): Promise<{ x: number; y: number } | null>;
  /**
   * Where something on the page is on this screen, by the words on it or a selector; the page moves to it.
   * 'missing' when the page has no such thing, null when the page does not answer.
   */
  find(at: string): Promise<{ x: number; y: number; w: number; h: number } | 'missing' | null>;
  /** What is at a place of this screen, on the project's page; null when nothing is, or the page does not answer. */
  pick(x: number, y: number): Promise<Picked | null>;
}

export function createStage(root: HTMLElement, info: Info, on: { snapshot(snapshot: unknown): void; changed(): void }): Stage {
  const frame = h<'iframe'>('iframe#t-frame', { title: info.name, allow: 'autoplay; fullscreen; vibrate', hidden: true });
  const none = h('div#t-nopage');
  root.append(frame, none);

  /** Point the frame at a page, once that page answers: it is started when tandem is, and may take a moment. */
  let wanted = '';
  async function show(url: string, what: string) {
    wanted = url;
    frame.hidden = true;
    none.hidden = false;
    clear(none, h('i.spin'), h('b', {}, `Starting ${what}…`));
    for (let tries = 0; wanted === url; tries++) {
      if (await reachable(url)) break;
      if (tries === 30) clear(none, h('i.spin'), h('b', {}, `${what[0].toUpperCase()}${what.slice(1)} is not answering yet.`),
        h('p', {}, 'Its page is started with the command tandem was given for it ("page" in .tandem/tandem.json). If that command is wrong, or needs something else to run first, it will not come up; what it says is in the terminal tandem was started in.'));
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (wanted !== url) return;
    frame.src = url;
    frame.hidden = false;
    none.hidden = true;
  }

  if (info.page) void show(info.page, `${info.name}`);
  else if (info.project) clear(none,
    h('b', {}, `${info.name} has no page here.`),
    h('p', {}, 'Tandem shows a project\'s own page in this space. Ask the agent to set tandem up for it, or say how it is started in .tandem/tandem.json: "page": "npm run dev -- --port {port}".'),
    h('p', {}, 'The tools work without it: open them with the round button.'));
  // No project at all: the page is there to choose one.
  else clear(none, h('b', {}, 'Which project?'), h('p', {}, 'Tandem works on a project: a folder with a git repository in it. Choose one from the list.'));

  /** The last world the project's page shared: what the copy is started from. */
  let world: unknown;
  let asked = 0;
  const waiting = new Map<number, (at: { x: number; y: number } | null) => void>();
  const picking = new Map<number, (got: Picked | null) => void>();
  const finding = new Map<number, (at: { x: number; y: number; w: number; h: number } | 'missing' | null) => void>();
  const send = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ tandem: 1, ...msg }, '*');

  const stage: Stage = {
    showing: 'project',
    can: { snapshot: false, point: false, find: false },
    showCopy(url) {
      stage.showing = 'copy';
      stage.can = { snapshot: false, point: false, find: false };
      void show(url, 'the working copy');
      on.changed();
    },
    showProject() {
      if (stage.showing === 'project') return;
      stage.showing = 'project';
      stage.can = { snapshot: false, point: false, find: false };
      if (info.page) void show(info.page, info.name);
      on.changed();
    },
    where(x, y) {
      if (!stage.can.point) return Promise.resolve(null);
      const id = ++asked;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        send({ type: 'where', id, x, y });
        setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 800);
      });
    },
    pick(x, y) {
      if (!stage.can.find) return Promise.resolve(null);
      const id = ++asked;
      const r = frame.getBoundingClientRect();
      return new Promise((resolve) => {
        picking.set(id, resolve);
        send({ type: 'pick', id, x: x - r.left, y: y - r.top });
        setTimeout(() => { if (picking.delete(id)) resolve(null); }, 800);
      });
    },
    find(at) {
      if (!stage.can.find) return Promise.resolve(null);
      const id = ++asked;
      return new Promise((resolve) => {
        finding.set(id, resolve);
        send({ type: 'find', id, at });
        setTimeout(() => { if (finding.delete(id)) resolve(null); }, 1500);
      });
    },
  };

  window.addEventListener('message', (ev) => {
    const m = ev.data as { tandem?: number; type?: string; id?: number; x?: number; y?: number; w?: number; h?: number; missing?: boolean; snapshot?: unknown; loaded?: boolean; can?: Partial<Stage['can']> } | null;
    if (!m || m.tandem !== 1 || ev.source !== frame.contentWindow) return;
    if (m.type === 'hello') {
      stage.can = { ...stage.can, snapshot: !!m.can?.snapshot, point: !!m.can?.point };
      // The working copy is played from where the person is in the project, and keeps nothing.
      if (stage.showing === 'copy' && !m.loaded && world !== undefined) send({ type: 'load', snapshot: world });
      // Back in the project: if this page was once asked to start from a world, it is its own again.
      if (stage.showing === 'project' && m.loaded) send({ type: 'unload' });
      on.changed();
    } else if (m.type === 'snapshot') {
      // Only the project's own world is the person's: the copy's is a try-out.
      if (stage.showing === 'project') { world = m.snapshot; on.snapshot(m.snapshot); }
    } else if (m.type === 'page') {
      // Tandem's own lines in the page: what is on it can be found.
      stage.can = { ...stage.can, find: !!m.can?.find };
    } else if (m.type === 'picked' && m.id !== undefined) {
      const r = frame.getBoundingClientRect();
      const p = m as unknown as Picked;
      picking.get(m.id)?.(m.missing ? null : { x: r.left + Number(p.x), y: r.top + Number(p.y), w: Number(p.w), h: Number(p.h), words: String(p.words ?? ''), tag: String(p.tag ?? ''), selector: String(p.selector ?? ''), path: String(p.path ?? '') });
      picking.delete(m.id);
    } else if (m.type === 'found' && m.id !== undefined) {
      const r = frame.getBoundingClientRect();
      finding.get(m.id)?.(m.missing ? 'missing' : { x: r.left + Number(m.x), y: r.top + Number(m.y), w: Number(m.w), h: Number(m.h) });
      finding.delete(m.id);
    } else if (m.type === 'screen' && m.id !== undefined) {
      const r = frame.getBoundingClientRect();
      waiting.get(m.id)?.({ x: r.left + Number(m.x), y: r.top + Number(m.y) });
      waiting.delete(m.id);
    }
  });
  return stage;
}
