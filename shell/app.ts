// The engine's layer over the game: a round button, a sheet that slides up
// over the lower part of the screen with the tools in it, a ring for pointing
// at the game. The game underneath keeps running and stays in view, so it
// can be played and talked about at once.
import type { Event } from '../core/events.ts';
import type { GameModule, GamePage } from '../core/game.ts';
import type { AgentStatus } from '../core/runner.ts';
import { run, type Info } from './api.ts';
import { clear, h } from './dom.ts';

export interface Panel {
  id: string;
  title: string;
  /** The panels are made before the app is; it hands itself over here. */
  init(app: App): void;
  /** Draw into the sheet. `id` is something to open straight away: a concept, a record, an entity. */
  show(body: HTMLElement, foot: HTMLElement, id?: string): void;
  hide?(): void;
  /** Something happened; called whether the panel is showing or not. */
  event?(ev: Event, live: boolean): void;
  agent?(): void;
}

export interface App {
  info: Info;
  game: GameModule;
  page: GamePage;
  events: Event[];
  agent: AgentStatus;
  /** What the next message is about: "concept:<id>", "drawing:<name>", "point:<x>,<y>". */
  refs: string[];
  open(tab: string, id?: string): void;
  close(): void;
  current(): string | null;
  /** Hang something on the next message and go to the chat. */
  attach(ref: string): void;
  point(x: number, y: number, text?: string): void;
  zoom(url: string): void;
  toast(text: string): void;
  /** Run a command for a button: failures are said, not thrown. */
  act<T>(name: string, input?: Record<string, unknown>): Promise<T | undefined>;
  badge(tab: string, on: boolean): void;
  /** A button that locks or unlocks something ("concept:<id>", "drawing:<name>") against the agent. */
  lockButton(ref: string, locked: boolean, changed?: (locked: boolean) => void): HTMLButtonElement;
}

export function createApp(root: HTMLElement, info: Info, game: GameModule, page: GamePage, panels: Panel[]): App & { feed(ev: Event, live: boolean): void } {
  const fab = h<'button'>('button#t-fab', { 'aria-label': 'Open the tools', onclick: () => (shown ? app.close() : app.open(last)) }, h('i.mark'), h('i.badge'));
  const tabs = h<'nav'>('nav#t-tabs');
  const body = h('div#t-body');
  const foot = h('div#t-foot');
  const sheet = h<'section'>('section#t-sheet.shut', {},
    h('header', {},
      tabs,
      h<'button'>('button.icon', { 'aria-label': 'Taller or shorter', onclick: () => sheet.classList.toggle('tall') }, '⇕'),
      h<'button'>('button.icon', { 'aria-label': 'Close', onclick: () => app.close() }, '✕')),
    body, foot);
  const ring = h('div#t-ring', { hidden: true }, h('i'), h('span'));
  const toastEl = h('div#t-toast', { hidden: true });
  const zoomEl = h('div#t-zoom', { hidden: true, onclick: () => { zoomEl.hidden = true; } }, h<'img'>('img'));
  root.append(fab, ring, sheet, toastEl, zoomEl);

  let shown: string | null = null, last = 'chat';
  let ringTimer = 0, toastTimer = 0;
  const badges = new Set<string>();

  const tabEls = new Map<string, HTMLButtonElement>();
  for (const p of panels) {
    const b = h<'button'>('button.t-tab', { onclick: () => app.open(p.id) }, p.title, h('i.dot'));
    tabEls.set(p.id, b);
    tabs.append(b);
  }

  function paintBadges() {
    for (const [id, el] of tabEls) el.classList.toggle('news', badges.has(id));
    fab.classList.toggle('news', badges.size > 0);
    fab.classList.toggle('busy', app.agent.busy);
  }

  const app: App & { feed(ev: Event, live: boolean): void } = {
    info, game, page,
    events: [],
    agent: { busy: false, doing: '', text: '', waiting: 0, session: false, off: false, context: 0, limit: 0 },
    refs: [],
    current: () => shown,

    open(tab, id) {
      const panel = panels.find((p) => p.id === tab) ?? panels[0];
      if (shown && shown !== panel.id) panels.find((p) => p.id === shown)?.hide?.();
      shown = last = panel.id;
      badges.delete(panel.id);
      for (const [pid, el] of tabEls) el.classList.toggle('on', pid === panel.id);
      sheet.classList.remove('shut');
      fab.classList.add('open');
      clear(body); clear(foot);
      body.scrollTop = 0;
      panel.show(body, foot, id);
      paintBadges();
    },

    close() {
      if (shown) panels.find((p) => p.id === shown)?.hide?.();
      shown = null;
      sheet.classList.add('shut');
      fab.classList.remove('open');
      page.intercept = null;
    },

    attach(ref) {
      if (!app.refs.includes(ref)) app.refs.push(ref);
      app.open('chat');
    },

    point(x, y, text = '') {
      const at = page.toScreen(x, y);
      ring.style.left = `${at.x}px`;
      ring.style.top = `${at.y}px`;
      ring.querySelector('span')!.textContent = text;
      ring.hidden = false;
      ring.classList.remove('go');
      void ring.offsetWidth;
      ring.classList.add('go');
      clearTimeout(ringTimer);
      ringTimer = window.setTimeout(() => { ring.hidden = true; }, 7000);
    },

    zoom(url) {
      (zoomEl.querySelector('img') as HTMLImageElement).src = url;
      zoomEl.hidden = false;
    },

    toast(text) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 3500);
    },

    async act<T>(name: string, input: Record<string, unknown> = {}) {
      try {
        return await run<T>(name, input);
      } catch (e) {
        app.toast(e instanceof Error ? e.message : String(e));
        return undefined;
      }
    },

    lockButton(ref, locked, changed) {
      const b = h<'button'>('button.icon.lock', { onclick: async () => {
        const done = await app.act<{ locked: boolean }>('locks.set', { ref, locked: !locked });
        if (!done) return;
        locked = done.locked;
        paint();
        app.toast(locked ? 'Locked: the agent cannot change this, even if you ask it to.' : 'Unlocked: the agent may propose changes again.');
        changed?.(locked);
      } });
      const paint = () => {
        b.textContent = locked ? '🔒' : '🔓';
        b.classList.toggle('on', locked);
        b.setAttribute('aria-label', locked ? 'Locked against the agent. Unlock' : 'Not locked. Lock against the agent');
        b.setAttribute('aria-pressed', String(locked));
      };
      paint();
      return b;
    },

    badge(tab, on) {
      if (on && shown !== tab) badges.add(tab); else badges.delete(tab);
      paintBadges();
    },

    feed(ev, live) {
      if (ev.type === 'agent.status') {
        app.agent = ev as unknown as AgentStatus;
        paintBadges();
        for (const p of panels) p.agent?.();
        return;
      }
      // What is only told, not kept (what a worker is doing right now), goes to the panels and nowhere else.
      if (ev.n === 0) { for (const p of panels) p.event?.(ev, true); return; }
      app.events.push(ev);
      if (live) {
        // What the agent shows, it shows on the stage itself.
        if (ev.type === 'stage.point') app.point(Number(ev.x), Number(ev.y), String(ev.text ?? ''));
        if (ev.type === 'stage.open') app.open(String(ev.tab), ev.id ? String(ev.id) : undefined);
        if (ev.by !== 'me' && ['message', 'look', 'playtest'].includes(ev.type)) app.badge('chat', true);
        if (ev.type === 'proposal' && !ev.worker) app.badge('chat', true);
        // A worker's round is ready: that is news in the Art tab.
        if (ev.type === 'art.round') app.badge('art', true);
      }
      for (const p of panels) p.event?.(ev, live);
    },
  };
  for (const p of panels) p.init(app);
  return app;
}
