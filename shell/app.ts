// Tandem's layer over the project's page: a round button, a sheet with the
// tools in it, a ring for pointing at something in the project. On a phone the
// sheet covers the page while it is open; on a wide screen it is a panel beside
// the page, and both are in view at once.
import type { Event } from '../core/events.ts';
import type { AgentStatus } from '../core/runner.ts';
import { info as getInfo, run, type Info } from './api.ts';
import { createBubbles } from './bubbles.ts';
import { clear, h } from './dom.ts';
import { icon } from './icons.ts';
import type { Mascot } from './mascot.ts';
import type { Picked, Stage } from './stage.ts';
import { sound } from './prefs.ts';
import { createTweaks, type Tweak } from './tweaks.ts';
import { babble, mouth } from './voice.ts';

/** A file the core keeps with the conversation (chat.attach). */
export interface Kept { name: string; label: string; url: string; image: boolean }

export interface Panel {
  id: string;
  title: string;
  /** False for a panel that is not one of the tabs: it is opened some other way (the settings, by their button). */
  tab?: boolean;
  /** The panels are made before the app is; it hands itself over here. */
  init(app: App): void;
  /** Draw into the sheet. `id` is something to open straight away: a concept, a record, an entity. */
  show(body: HTMLElement, foot: HTMLElement, id?: string): void;
  hide?(): void;
  /** Something happened; called whether the panel is showing or not. */
  event?(ev: Event, live: boolean): void;
  agent?(): void;
  /** What the next message is about changed. */
  refs?(): void;
}

/** Where a change shows: the way there, as a person would go, and the thing itself. */
/** An example of a change set: a page of the working copy made to show it, and a few words on what it shows. */
export interface Example { path: string; text?: string }

export interface Show { steps: ({ go: string } | { tap: string } | { fill: string; text: string })[]; at?: string; text?: string }

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
  /** True on a wide screen: the tools are a panel beside the project's page, not over it. */
  beside(): boolean;
  /** Bring the project's page in view: where the tools cover it, they are shut. */
  reveal(): void;
  /** Hang something on the next message and go to the chat; with a picture of it (a data URL), that goes along too. */
  attach(ref: string, picture?: string): void;
  /** The pictures of what the next message is about, by what they are of: kept by the core, sent along as files. */
  pictures: Map<string, Kept>;
  /** Done when every picture that was handed over is kept; `picturing` is how many are still on their way. */
  pictured: Promise<void>;
  picturing: number;
  point(x: number, y: number, text?: string, at?: string): void;
  /** Show the agent's working copy in the frame instead of the project, and back. */
  /** Show the working copy, started from what the browser keeps of the project; with `show`, go to where the change is and mark it. */
  playCopy(show?: Show): Promise<void>;
  /** Show the example the agent made of its change set: a page of the working copy, as that page serves it. */
  playExample(example: Example): Promise<void>;
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
  // The figure in the button, where there is something to draw it with (a test's page has not): until it is there,
  // and where it cannot be, the button has its mark.
  let mascot: Mascot | undefined;
  /** The hole the figure is in, and the wait after which the button is no longer kept in view for it. */
  let lives: HTMLElement | undefined, kept = 0;
  if ('WebGL2RenderingContext' in window) {
    void import('./mascot.ts').then((m) => m.createMascot()).then((made) => {
      mascot = made;
      fab.classList.add('mascot');
      // (Out of the button, the button does not have to stay in view for it any longer: see `carrying`.)
      made.moved((hole) => { lives = hole; if (hole !== fab) fab.classList.remove('carrying'); });
      made.into(fab, { now: true });
      made.voice(mouth);
      made.agent(app.agent.busy, app.agent.doing);
      house();
    }).catch(() => {});
  }
  const tabs = h<'nav'>('nav#t-tabs');
  const body = h('div#t-body');
  const foot = h('div#t-foot');
  const sheet = h<'section'>('section#t-sheet.shut', {},
    h('header', {},
      tabs,
      h<'button'>('button.icon.settings', { 'aria-label': 'Settings', title: 'Settings', onclick: () => app.open('settings') }, icon('settings')),
      h<'button'>('button.icon', { 'aria-label': 'Close', onclick: () => app.close() }, icon('close'))),
    body, foot);
  const ring = h('div#t-ring', { hidden: true }, h('i'), h('span'));
  /** What the figure carries from the page to the chat: a picture of what was pointed at. */
  const carry = h('div#t-carry', { hidden: true });
  // (With an example of the change set there are two ways to see the copy: from one to the other, right here.)
  let toy: Example | undefined;
  const bannerSays = h('span', { title: 'What the agent made, not yet the project' }, 'The working copy');
  const bannerSwap = h<'button'>('button.swap', { hidden: true, onclick: () => { if (stage.example) void app.playCopy(); else if (toy) void app.playExample(toy); } });
  const banner = h('div#t-copy', { hidden: true }, bannerSays, bannerSwap, h<'button'>('button', { onclick: () => app.playProject() }, 'Back to the project'));
  const paintBanner = () => {
    banner.hidden = stage.showing !== 'copy';
    bannerSays.textContent = stage.example ? 'An example' : 'The working copy';
    bannerSwap.hidden = !toy;
    bannerSwap.textContent = stage.example ? 'The copy itself' : 'The example';
  };
  // The agent asks for the page, and has it: asked and said over the page, where the person is looking.
  const takeWhy = h('p');
  const takeEl = h('div#t-take', { hidden: true, role: 'dialog', 'aria-label': 'The agent asks to use the page' },
    h('b', {}, 'The agent asks to use the page for a moment'), takeWhy,
    h('div.answers', {},
      h<'button'>('button.yes', { onclick: () => void answerTake(true) }, 'Let it'),
      h<'button'>('button', { onclick: () => void answerTake(false) }, 'Not now')));
  const heldEl = h('div#t-held', { hidden: true }, h('span', { title: 'It taps and looks itself, to try what it made; you can watch' }, 'The agent is using the page'), h<'button'>('button', { onclick: () => void app.act('page.release') }, 'Take it back'));
  const marks = h('div#t-marks', {}, banner, heldEl);
  // The values of the change set that are the person's to turn, over the copy's page while it is the one shown:
  // there they see it change as they turn. Folded away, it is one small button.
  let turning: Tweak[] = [], folded = false;
  const trayRows = h('div.tweaks');
  const trayFold = h<'button'>('button.fold', { onclick: () => { folded = !folded; paintTray(); } });
  const tray = h('div#t-tweaks', { hidden: true }, trayFold, trayRows);
  const trayTweaks = createTweaks((name, input) => app.act(name, input));
  const paintTray = () => {
    tray.hidden = stage.showing !== 'copy' || !turning.length;
    if (tray.hidden) return;
    tray.classList.toggle('folded', folded);
    trayFold.textContent = folded ? `Turn · ${turning.length}` : 'Yours to turn';
    trayFold.setAttribute('aria-expanded', String(!folded));
    trayTweaks.into(trayRows, turning);
    trayRows.hidden = folded;
  };
  const takes = new Map<string, string>();
  let held = false;
  const answerTake = async (allow: boolean) => {
    const id = [...takes.keys()][0];
    if (id === undefined) return;
    // (Whatever the core says, this asking is answered here: one that came too late is gone too.)
    await app.act('page.let', { id, allow });
    takes.delete(id);
    paintTake();
  };
  const paintTake = () => {
    const why = [...takes.values()][0];
    takeEl.hidden = why === undefined;
    takeWhy.textContent = why ?? '';
    heldEl.hidden = !held;
    document.body.classList.toggle('t-held', held);
  };
  const toastEl = h('div#t-toast', { hidden: true });
  const zoomEl = h('div#t-zoom', { hidden: true, onclick: () => { zoomEl.hidden = true; } }, h<'img'>('img'));
  const bubbleEl = h('div#t-bubbles', { hidden: true });
  root.append(fab, bubbleEl, marks, tray, takeEl, ring, sheet, toastEl, zoomEl, carry);

  let shown: string | null = null, last = 'chat';
  // A wide screen has room for the tools beside the page. The stylesheet goes by these two classes on the body.
  const WIDE = '(min-width: 900px)';
  const paintLayout = () => {
    document.body.classList.toggle('t-wide', app.beside());
    document.body.classList.toggle('t-open', shown !== null);
  };
  window.matchMedia?.(WIDE).addEventListener?.('change', () => paintLayout());
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
    // A tab, or a button in the bar beside the tabs, opens a panel: what is loading then is the panel, and that is shown in it.
    if (pressed?.closest('#t-sheet > header')) pressed = null;
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

  // ---- where the figure is: while the chat is open, in the small hole beside what the agent said last, and it
  // goes from one to the next as the agent says more; otherwise, and while it points at something, in the button.
  let pointing = false;
  /** How long the figure takes over a letter of what the agent said, in milliseconds. */
  const LETTER = 70;
  /** When the agent last said something while this page was open, and how much: it talks only beside a line that is new, and as long as that takes to say. */
  let said = 0, words = '', housed: HTMLElement | undefined;
  const stand = h('div.t-stand');
  function house(now = false) {
    // (While it points at something it stays where it is: from the chat its arm comes out of the button.)
    if (!mascot || pointing) return;
    const list = shown === 'chat' ? body.querySelector('.chat') : null;
    const holes = list ? list.querySelectorAll<HTMLElement>('.msg .t-hole') : [];
    // Before the agent has said anything it stands at the top of the chat, large. (That hole is taken away again
    // once the figure has left it.)
    if (list && !holes.length) { if (stand.parentElement !== list) list.prepend(stand); } else if (!stand.contains(mascot.el) || !list) stand.remove();
    const to = holes.length ? holes[holes.length - 1]! : list ? stand : fab;
    fab.classList.toggle('away', to !== fab);
    const says = to !== fab && to !== housed && Date.now() - said < 4000;
    if (says) said = 0;
    housed = to;
    // (And it is heard, where the person turned that on: then its mouth goes by what is heard. Without sound it
    // goes for a while that is longer for a longer line.)
    const line = words, heard = sound();
    mascot.into(to, { now, small: holes.length > 0, bare: to === stand, ...(says && { says: heard ? 600 : Math.min(Math.max(line.length * 25, 700), 3500), ...(heard && { up: () => babble(line, LETTER) }) }) });
  }
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => house()).observe(body, { childList: true, subtree: true });

  // ---- the button dragged onto something on the page: "this, here". What is under it is marked while it is
  // dragged; let go, that thing goes with the next message, and the button is back where it was.
  let drag: { id: number; x: number; y: number; on: boolean; last: number } | undefined;
  let dragged = false;
  // (What says nothing itself, a canvas, is named by what is written around it.)
  const short = (text: string) => (text.length > 36 ? `${text.slice(0, 35)}…` : text);
  const naming = (got: Picked) => (got.words ? `"${short(got.words)}"` : got.near ? `${got.tag} by "${short(got.near)}"` : got.tag);
  fab.addEventListener('pointerdown', (ev) => { if (!shown || app.beside()) drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, on: false, last: 0 }; });
  fab.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.on) {
      if (Math.hypot(dx, dy) < 10) return;
      drag.on = true;
      fab.setPointerCapture?.(ev.pointerId);
      fab.classList.add('drag');
    }
    // With the figure in it the button stays where it is, and its arm goes to the finger with the glass.
    if (mascot) {
      pointing = true;
      mascot.reach(ev.clientX, ev.clientY, fab);
    } else fab.style.transform = `translate(${dx}px, ${dy}px)`;
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
    const back = () => { mascot?.release(); pointing = false; house(); };
    if (ev.type === 'pointercancel') { ring.hidden = true; back(); return; }
    void stage.pick(ev.clientX, ev.clientY, true).then(async (got) => {
      ring.hidden = true;
      if (!got) { back(); return app.toast(stage.can.find ? 'There is nothing there to point at.' : 'This page cannot be asked what is there.'); }
      // The figure takes it with its other hand and puts it in the chat, which is opened for that: the button stays
      // in view over the tools until it is done.
      if (mascot) {
        carry.style.backgroundImage = got.image ? `url("${got.image}")` : '';
        fab.classList.add('carrying');
        app.open('chat');
        await mascot.bring({ x: got.x + got.w / 2, y: got.y + got.h / 2 }, () => {
          const r = (foot.querySelector('.composer') ?? foot).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, carry);
        back();
        // The button stays until the figure has gone down in it, on its way to the chat: on a phone the button is
        // gone with the tools open, and the figure with it, before it got there. (Already in the chat, its arm only
        // has to be back; and never for long, whatever happens.)
        clearTimeout(kept);
        kept = window.setTimeout(() => fab.classList.remove('carrying'), lives === fab ? 3000 : 500);
      }
      app.attach(`page:${JSON.stringify({ words: got.words, ...(got.near && { near: got.near }), tag: got.tag, selector: got.selector, path: got.path, ...(got.three && { three: got.three }) })}`, got.image);
    });
  };
  fab.addEventListener('pointerup', drop);
  fab.addEventListener('pointercancel', drop);

  function paintBadges() {
    for (const [id, el] of tabEls) el.classList.toggle('news', badges.has(id));
    fab.classList.toggle('news', badges.size > 0);
    fab.classList.toggle('busy', app.agent.busy);
    mascot?.agent(app.agent.busy, app.agent.doing);
  }

  const app: App & { feed(ev: Event, live: boolean): void; stageChanged(): void } = {
    info, stage,
    events: [],
    agent: { busy: false, doing: '', text: '', waiting: 0, session: false, off: false, context: 0, limit: 0 },
    refs: [],
    pictures: new Map(),
    pictured: Promise.resolve(),
    picturing: 0,
    current: () => shown,
    beside: () => window.matchMedia?.(WIDE).matches ?? false,
    reveal() { if (!app.beside()) app.close(); },

    open(tab, id) {
      const panel = panels.find((p) => p.id === tab) ?? panels[0];
      if (shown && shown !== panel.id) panels.find((p) => p.id === shown)?.hide?.();
      // Beside the page the tools slide in from the edge: the figure pulls them open.
      if (!shown && app.beside()) mascot?.hold(() => sheet.getBoundingClientRect().left, false);
      shown = last = panel.id;
      badges.delete(panel.id);
      for (const [pid, el] of tabEls) el.classList.toggle('on', pid === panel.id);
      sheet.classList.remove('shut');
      fab.classList.add('open');
      paintLayout();
      clear(body); clear(foot);
      body.scrollTop = 0;
      panel.show(body, foot, id);
      // A panel that has to ask the core first has drawn nothing yet: it is loading, and says so where it will be.
      if (!body.childNodes.length) body.append(h('div.working.loading', {}, h('i.spin'), h('span', {}, 'Loading…')));
      paintBadges();
      bubbles.shut(false);
      house();
    },

    close() {
      if (shown) panels.find((p) => p.id === shown)?.hide?.();
      const was = shown;
      shown = null;
      // (Shut, it is in the button again, and from there it pushes them shut.)
      house(true);
      if (was && app.beside()) mascot?.hold(() => sheet.getBoundingClientRect().left, true);
      sheet.classList.add('shut');
      fab.classList.remove('open');
      paintLayout();
      bubbles.shut(true);
      // What was pointed at while the tools covered the page is shown now that the page can be seen.
      if (pointed) { const p = pointed; pointed = undefined; app.point(p.x, p.y, p.text, p.at); }
    },

    attach(ref, picture) {
      if (!app.refs.includes(ref)) app.refs.push(ref);
      app.open('chat');
      if (!picture) return;
      // The picture is handed to the core like a photo the person shares; it goes with the message as a file.
      let what = '';
      try { const p = JSON.parse(ref.slice(ref.indexOf(':') + 1)) as { words?: string; near?: string; tag?: string }; what = p.words || p.near || p.tag || ''; } catch { /* no name for it */ }
      const name = `pointed at ${what.replace(/[^\w\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'something'}.jpg`;
      app.picturing++;
      app.pictured = app.pictured.then(async () => {
        try {
          const kept = await run<Kept>('chat.attach', { name, data: picture.replace(/^data:[^,]*,/, '') });
          if (!app.refs.includes(ref)) return;
          app.pictures.set(ref, kept);
          for (const p of panels) p.refs?.();
        } catch { app.toast('The picture of what you pointed at could not be kept; it goes without one.'); }
        app.picturing--;
      });
    },

    point(x, y, text = '', at) {
      // Where the tools cover the page while they are open, the pointing waits until the page is in view.
      if (shown && !app.beside()) { pointed = { x, y, text, at }; return app.toast(`The agent points at something on the page${text ? `: ${text}` : ''}. Shut the tools to see it.`); }
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

    async playCopy(show) {
      const got = await app.act<{ url: string }>('code.play');
      if (!got) return;
      const wait = async (what: () => unknown, ms: number) => { for (let t = 0; t < ms && !what(); t += 150) await new Promise((r) => setTimeout(r, 150)); return !!what(); };
      const settle = () => new Promise((r) => setTimeout(r, 700));
      // What the browser keeps of the project (who is signed in, how far they are) and where they are in it: the
      // copy is started from that. What happens in the copy afterwards stays in the copy.
      const mine = stage.showing === 'project' ? await stage.act({ do: 'state' }) : null;
      let n = stage.loads;
      stage.showCopy(got.url);
      app.reveal();
      if (!(await wait(() => stage.loads > n, 40000))) return;
      if (mine?.ok) {
        n = stage.loads;
        if ((await stage.act({ do: 'load', local: mine.local, session: mine.session, path: show?.steps.length ? '/' : mine.path }))?.ok) await wait(() => stage.loads > n, 20000);
      }
      if (!show) return;
      // The way to the change, gone as a person would go it; then the thing itself, marked.
      await settle();
      for (const step of show.steps) {
        n = stage.loads;
        const what = 'go' in step ? { do: 'go', path: step.go } : 'tap' in step ? { do: 'tap', at: step.tap } : { do: 'type', at: step.fill, text: step.text };
        const did = await stage.act(what);
        if (did?.ok === false) return app.toast(`On the way to the change: ${String(did.error)}. This is as far as it got.`);
        await settle();
        // (A step that loads the page anew: wait for it to be there again.)
        if (!did) await wait(() => stage.loads > n, 8000);
      }
      if (show.at) app.point(0, 0, show.text ?? 'this is what changed', show.at);
    },

    async playExample(example) {
      const got = await app.act<{ url: string }>('code.play');
      if (!got) return;
      stage.showCopy(new URL(example.path, got.url).href, true);
      app.reveal();
    },

    playProject() { stage.showProject(); },

    /** The frame shows something else now: say so over it. */
    stageChanged() {
      paintBanner();
      document.body.classList.toggle('t-copy', stage.showing === 'copy');
      paintTray();
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
        b.replaceChildren(icon(locked ? 'lock' : 'unlock'));
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
      if (live && ev.type === 'message' && ev.by === 'agent') { said = Date.now(); words = String(ev.text ?? ''); }
      if (ev.type === 'agent.status') {
        setAgent(ev as unknown as AgentStatus);
        return;
      }
      // The agent uses the project's page as a person would: asked here, done in the frame, answered to the core.
      if (ev.type === 'page.ask') { if (live) void onPage(ev); return; }
      // What is only told, not kept (what a worker is doing right now), goes to the panels and nowhere else.
      if (ev.n === 0) { bubbles.feed(ev, true); for (const p of panels) p.event?.(ev, true); return; }
      app.events.push(ev);
      // The agent asking for the page, the answer, and the page given back: from the log, so a screen opened later knows.
      if (ev.type === 'page.take') { takes.set(String(ev.id), String(ev.why ?? '')); paintTake(); }
      if (ev.type === 'page.taken') { takes.delete(String(ev.id)); if (ev.allow) held = true; paintTake(); }
      if (ev.type === 'page.released') { held = false; paintTake(); }
      bubbles.feed(ev, live);
      // The change set that waits, and what of it is the person's to turn: over the copy's page while that is shown.
      if (ev.type === 'proposal' && ev.kind === 'code') { turning = (ev.tweaks as Tweak[] | undefined) ?? []; toy = ev.example as Example | undefined; paintTray(); paintBanner(); }
      // (The change set was decided, with what else waited, or withdrawn.)
      const coded = ev.type === 'proposal.decided' && Array.isArray(ev.paths) && (ev.paths as string[]).some((p) => p.startsWith('code:'));
      if (coded) { turning = []; toy = undefined; paintTray(); paintBanner(); }
      if (live) {
        // What the agent shows, it shows on the stage itself.
        if (ev.type === 'stage.point') app.point(Number(ev.x), Number(ev.y), String(ev.text ?? ''), typeof ev.at === 'string' ? ev.at : undefined);
        if (ev.type === 'stage.open') app.open(String(ev.tab), ev.id ? String(ev.id) : undefined);
        if (coded) app.playProject();
        // What was accepted is the project's code now: its page is loaded anew. A page served by something that
        // watches the files does that by itself; one served as plain files stays what it was until it is asked again.
        if (ev.type === 'code.changed' && !ev.restarting) stage.showProject(true);
        // How the project is run was changed: the core and the project's page start again, and this page with them.
        if (ev.type === 'setup.changed' && ev.restarting) void again();
        // The same when what the project depends on was installed with an accepted change.
        if (ev.type === 'code.changed' && ev.restarting) void again();
        if (ev.by !== 'me' && ['message', 'look', 'playtest', 'welcome'].includes(ev.type)) app.badge('chat', true);
        // A value was turned in the copy, and its page does not follow its own files: it is loaded anew to show it.
        if (ev.type === 'proposal' && ev.tweaked && ev.anew && stage.showing === 'copy') stage.again();
        // (What the person turned themselves is not news to them.)
        if (ev.type === 'proposal' && !ev.worker && !ev.tweaked) app.badge('chat', true);
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
        did = await stage.act({ do: what, at: ev.at, x: ev.x, y: ev.y, text: ev.text, submit: ev.submit, path: ev.path });
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
      // While the agent has the page, a picture of it goes along: what a canvas draws is not in the lines.
      const pic = ev.picture ? await stage.act({ do: 'picture' }, 8000) : null;
      void answer({ ok: true, did: did?.did ?? (did ? undefined : 'done, as far as can be told: the page loaded anew'), showing: stage.showing, path: now.path, title: now.title, lines: now.lines, ...(pic?.ok ? { image: pic.image, size: pic.size } : {}) });
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
  paintLayout();
  return app;
}
