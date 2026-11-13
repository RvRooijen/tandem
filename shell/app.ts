// Tandem's layer over the project's page: a round button, a sheet that slides
// up over the lower part of the screen with the tools in it, a ring for
// pointing at something in the project. The project underneath keeps running
// and stays in view, so it can be used and talked about at once.
import type { Event } from '../core/events.ts';
import type { AgentStatus } from '../core/runner.ts';
import { info as getInfo, run, type Info } from './api.ts';
import { createBubbles } from './bubbles.ts';
import { clear, h } from './dom.ts';
import type { Picked, Stage } from './stage.ts';

export interface Panel {
  id: string;
  title: string;
  /** False for a panel that is not one of the tabs: it is opened some other way (the project chooser, by its button). */
  tab?: boolean;
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
  /** The project's page, in its frame. */
  stage: Stage;
  events: Event[];
  agent: AgentStatus;
  /** What the next message is about: "concept:<id>", "drawing:<name>", "point:<x>,<y>", "page:<json>" (something on the project's page). */
  refs: string[];
  open(tab: string, id?: string): void;
  close(): void;
  current(): string | null;
  /** Hang something on the next message and go to the chat. */
  attach(ref: string): void;
  point(x: number, y: number, text?: string, at?: string): void;
  /** Show the agent's working copy in the frame instead of the project, and back. */
  playCopy(): Promise<void>;
  playProject(): void;
  zoom(url: string): void;
  toast(text: string): void;
  /** Run a command for a button: failures are said, not thrown. */
  act<T>(name: string, input?: Record<string, unknown>): Promise<T | undefined>;
  badge(tab: string, on: boolean): void;
  /** A button that locks or unlocks something ("concept:<id>", "drawing:<name>") against the agent. */
  lockButton(ref: string, locked: boolean, changed?: (locked: boolean) => void): HTMLButtonElement;
}

export function createApp(root: HTMLElement, info: Info, stage: Stage, panels: Panel[]): App & { feed(ev: Event, live: boolean): void; stageChanged(): void } {
  const fab = h<'button'>('button#t-fab', { 'aria-label': 'Open the tools', title: 'Tap to open the tools; drag onto something on the page to point at it', onclick: () => { if (dragged) { dragged = false; return; } if (shown) app.close(); else app.open(last); } }, h('i.mark'), h('i.badge'));
  const tabs = h<'nav'>('nav#t-tabs');
  const body = h('div#t-body');
  const foot = h('div#t-foot');
  const sheet = h<'section'>('section#t-sheet.shut', {},
    h('header', {},
      tabs,
      h<'button'>('button.icon.projects', { 'aria-label': 'Open another project', title: 'Open another project', onclick: () => app.open('projects') }, '📁'),
      h<'button'>('button.icon', { 'aria-label': 'Close', onclick: () => app.close() }, '✕')),
    body, foot);
  const ring = h('div#t-ring', { hidden: true }, h('i'), h('span'));
  const banner = h('div#t-copy', { hidden: true }, h('span', {}, 'The working copy: what the agent made, not yet the project'), h<'button'>('button', { onclick: () => app.playProject() }, 'Back to the project'));
  const toastEl = h('div#t-toast', { hidden: true });
  const zoomEl = h('div#t-zoom', { hidden: true, onclick: () => { zoomEl.hidden = true; } }, h<'img'>('img'));
  const bubbleEl = h('div#t-bubbles', { hidden: true });
  root.append(fab, bubbleEl, banner, ring, sheet, toastEl, zoomEl);

  let shown: string | null = null, last = 'chat';
  let ringTimer = 0, toastTimer = 0;
  let pointed: { x: number; y: number; text: string; at?: string } | undefined;
  const badges = new Set<string>();

  const tabEls = new Map<string, HTMLButtonElement>();
  for (const p of panels) {
    if (p.tab === false) continue;
    const b = h<'button'>('button.t-tab', { onclick: () => app.open(p.id) }, p.title, h('i.dot'));
    tabEls.set(p.id, b);
    tabs.append(b);
  }

  /** The commands that set the agent to work. */
  const STARTS = new Set(['chat.send', 'chat.answer', 'project.init']);
  function setAgent(now: AgentStatus) {
    app.agent = now;
    bubbles.agent(now.busy);
    paintBadges();
    for (const p of panels) p.agent?.();
  }
  /** The button that was last pressed, and when: a command run right after is that button's. */
  let pressed: HTMLButtonElement | null = null, pressedAt = 0;
  root.addEventListener('click', (ev) => {
    pressed = (ev.target as Element | null)?.closest?.('button') as HTMLButtonElement | null;
    pressedAt = Date.now();
  }, true);

  /** The ring: a round mark on a place in the world, or a box around a thing on the page; `stays` a few seconds, or until it is taken away. */
  function showRing(px: number, py: number, w: number, h: number, text: string, box: boolean, stays: boolean) {
    ring.style.left = `${px}px`;
    ring.style.top = `${py}px`;
    const mark = ring.querySelector('i') as HTMLElement;
    mark.style.width = `${Math.max(46, Math.min(w + 14, window.innerWidth - 8))}px`;
    mark.style.height = `${Math.max(46, Math.min(h + 14, window.innerHeight - 8))}px`;
    ring.classList.toggle('box', box);
    ring.querySelector('span')!.textContent = text;
    ring.hidden = false;
    ring.classList.remove('go');
    clearTimeout(ringTimer);
    if (!stays) return;
    void ring.offsetWidth;
    ring.classList.add('go');
    ringTimer = window.setTimeout(() => { ring.hidden = true; }, 7000);
  }

  // ---- the button dragged onto something on the page: "this, here". What is under it is marked while it is
  // dragged; let go, that thing goes with the next message, and the button is back where it was.
  let drag: { id: number; x: number; y: number; on: boolean; last: number } | undefined;
  let dragged = false;
  const naming = (got: Picked) => (got.words ? `"${got.words.length > 36 ? `${got.words.slice(0, 35)}…` : got.words}"` : got.tag);
  fab.addEventListener('pointerdown', (ev) => { if (!shown) drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, on: false, last: 0 }; });
  fab.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.on) {
      if (Math.hypot(dx, dy) < 10) return;
      drag.on = true;
      fab.setPointerCapture?.(ev.pointerId);
      fab.classList.add('drag');
    }
    fab.style.transform = `translate(${dx}px, ${dy}px)`;
    if (Date.now() - drag.last < 90) return;
    drag.last = Date.now();
    const mine = drag;
    void stage.pick(ev.clientX, ev.clientY).then((got) => {
      if (drag !== mine) return;
      if (got) showRing(got.x + got.w / 2, got.y + got.h / 2, got.w, got.h, naming(got), true, false); else ring.hidden = true;
    });
  });
  const drop = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const was = drag;
    drag = undefined;
    // Not moved: a tap, and the click opens the tools.
    if (!was.on) return;
    // (The click that comes after a drag is not a tap.)
    dragged = true;
    setTimeout(() => { dragged = false; }, 350);
    fab.classList.remove('drag');
    fab.style.transform = '';
    if (ev.type === 'pointercancel') { ring.hidden = true; return; }
    void stage.pick(ev.clientX, ev.clientY).then((got) => {
      ring.hidden = true;
      if (!got) return app.toast(stage.can.find ? 'There is nothing there to point at.' : 'This page cannot be asked what is there.');
      app.attach(`page:${JSON.stringify({ words: got.words, tag: got.tag, selector: got.selector, path: got.path })}`);
    });
  };
  fab.addEventListener('pointerup', drop);
  fab.addEventListener('pointercancel', drop);

  function paintBadges() {
    for (const [id, el] of tabEls) el.classList.toggle('news', badges.has(id));
    fab.classList.toggle('news', badges.size > 0);
    fab.classList.toggle('busy', app.agent.busy);
  }

  const app: App & { feed(ev: Event, live: boolean): void; stageChanged(): void } = {
    info, stage,
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
      bubbles.shut(false);
    },

    close() {
      if (shown) panels.find((p) => p.id === shown)?.hide?.();
      shown = null;
      sheet.classList.add('shut');
      fab.classList.remove('open');
      bubbles.shut(true);
      // What was pointed at while the tools covered the page is shown now that the page can be seen.
      if (pointed) { const p = pointed; pointed = undefined; app.point(p.x, p.y, p.text, p.at); }
    },

    attach(ref) {
      if (!app.refs.includes(ref)) app.refs.push(ref);
      app.open('chat');
    },

    point(x, y, text = '', at) {
      // The tools are the whole screen while they are open: the pointing waits until the page is in view.
      if (shown) { pointed = { x, y, text, at }; return app.toast(`The agent points at something on the page${text ? `: ${text}` : ''}. Shut the tools to see it.`); }
      const ringAt = (px: number, py: number, w = 46, h = 46) => showRing(px, py, w, h, text, at !== undefined, true);
      if (at !== undefined) {
        void stage.find(at).then((r) => {
          if (r === 'missing') return app.toast(`The agent points at "${at}"${text ? ` (${text})` : ''}, but that is not on the page now.`);
          if (!r) return app.toast(`The agent points at "${at}"${text ? `: ${text}` : ''}, but this page cannot be asked where that is.`);
          ringAt(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h);
        });
        return;
      }
      void stage.where(x, y).then((p) => {
        if (!p) return app.toast(text ? `The agent points at something: ${text}` : 'The agent points at something, but this page does not say where things are.');
        ringAt(p.x, p.y);
      });
    },

    async playCopy() {
      const got = await app.act<{ url: string }>('code.play');
      if (!got) return;
      stage.showCopy(got.url);
      app.close();
    },

    playProject() { stage.showProject(); },

    /** The frame shows something else now: say so over it. */
    stageChanged() {
      banner.hidden = stage.showing !== 'copy';
      document.body.classList.toggle('t-copy', stage.showing === 'copy');
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
      // What was pressed says at once that it was: the button works until the answer is there.
      const button = pressed && Date.now() - pressedAt < 120 && pressed.isConnected ? pressed : null;
      pressed = null;
      const wasOff = button?.disabled ?? false;
      if (button) { button.classList.add('working'); button.disabled = true; }
      // And what sets the agent to work shows it at work at once, not when the core says so.
      const before = app.agent;
      if (STARTS.has(name) && !before.off && !before.busy) setAgent({ ...before, busy: true, doing: 'starting', text: '' });
      try {
        return await run<T>(name, input);
      } catch (e) {
        if (app.agent.doing === 'starting' && !before.busy) setAgent(before);
        app.toast(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        if (button) { button.classList.remove('working'); button.disabled = wasOff; }
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
        setAgent(ev as unknown as AgentStatus);
        return;
      }
      // The agent uses the project's page as a person would: asked here, done in the frame, answered to the core.
      if (ev.type === 'page.ask') { if (live) void onPage(ev); return; }
      // What is only told, not kept (what a worker is doing right now), goes to the panels and nowhere else.
      if (ev.n === 0) { bubbles.feed(ev, true); for (const p of panels) p.event?.(ev, true); return; }
      app.events.push(ev);
      bubbles.feed(ev, live);
      if (live) {
        // What the agent shows, it shows on the stage itself.
        if (ev.type === 'stage.point') app.point(Number(ev.x), Number(ev.y), String(ev.text ?? ''), typeof ev.at === 'string' ? ev.at : undefined);
        if (ev.type === 'stage.open') app.open(String(ev.tab), ev.id ? String(ev.id) : undefined);
        if (ev.type === 'proposal.decided' && ev.round === 'code') app.playProject();
        // How the project is run was changed: the core and the project's page start again, and this page with them.
        if (ev.type === 'setup.changed' && ev.restarting) void again();
        if (ev.by !== 'me' && ['message', 'look', 'playtest', 'welcome'].includes(ev.type)) app.badge('chat', true);
        if (ev.type === 'proposal' && !ev.worker) app.badge('chat', true);
        // A worker's round is ready: that is news in the Art tab.
        if (ev.type === 'art.round') app.badge('art', true);
      }
      for (const p of panels) p.event?.(ev, live);
    },
  };
  /**
   * Something the agent does on the project's page (look, tap, type, go). It is done on what this screen shows, the
   * project or the working copy (`copy` switches to one or the other first); the thing it touches is marked, so
   * the person sees it happen.
   */
  async function onPage(ev: Event) {
    const answer = (result: Record<string, unknown>) => run('page.answer', { id: String(ev.id), result }).catch(() => {});
    const wait = async (what: () => unknown, ms: number) => { for (let t = 0; t < ms && !what(); t += 150) await new Promise((r) => setTimeout(r, 150)); return !!what(); };
    try {
      if (!info.page) return void answer({ ok: false, error: 'this project has no page set up in tandem (project.configure: page)' });
      if (typeof ev.copy === 'boolean' && ev.copy !== (stage.showing === 'copy')) {
        if (ev.copy) { const got = await run<{ url: string }>('code.play'); stage.showCopy(got.url); } else stage.showProject();
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!(await wait(() => stage.can.find, 20000))) return void answer({ ok: false, error: 'the page on the person\'s screen does not answer: it is still starting, or it did not come up' });
      const what = String(ev.do);
      let did: Record<string, unknown> | null = { ok: true };
      if (what !== 'look') {
        did = await stage.act({ do: what, at: ev.at, text: ev.text, submit: ev.submit, path: ev.path });
        if (did && did.ok === false) return void answer({ ...did, showing: stage.showing });
        if (did && typeof did.x === 'number') showRing(Number(did.x) + Number(did.w) / 2, Number(did.y) + Number(did.h) / 2, Number(did.w), Number(did.h), what === 'tap' ? 'the agent taps this' : 'the agent fills this in', true, true);
        // What it did may have loaded the page anew: wait for it to be there again, and for the page to settle.
        await new Promise((r) => setTimeout(r, 900));
        await wait(() => stage.can.find, 15000);
      }
      // (A page that is loading anew does not answer at once: asked a few times.)
      let now: Record<string, unknown> | null = null;
      for (let i = 0; i < 4 && !now; i++) now = await stage.act({ do: 'look' });
      if (!now) return void answer({ ok: false, error: 'the page did not answer', showing: stage.showing });
      void answer({ ok: true, did: did?.did ?? (did ? undefined : 'done, as far as can be told: the page loaded anew'), showing: stage.showing, path: now.path, title: now.title, lines: now.lines });
    } catch (e) {
      void answer({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Wait for the core to be gone and back, then load this page again on what it is now. */
  async function again() {
    await new Promise((r) => setTimeout(r, 2500));
    for (let i = 0; i < 120; i++) {
      try { await getInfo(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    location.reload();
  }
  // What tandem says while the tools are shut.
  const bubbles = createBubbles(bubbleEl, app);
  for (const p of panels) p.init(app);
  return app;
}
