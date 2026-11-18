// The stage: the project's own page, in a frame that fills the screen, with
// tandem's tools over it. The frame shows the project, or the agent's working
// copy of it. Every page is shown through tandem and gets a few lines of
// tandem's on the way (bridge/page.js): with those, something on it can be
// found by the words on it. A page that uses the bridge
// (bridge/tandem.bridge.ts) also tells tandem the world being played and where
// things in that world are.
//
// Beside the page there can be views (core/views.ts): what the project's server
// says, its endpoints, a database, a page made for the project. Each is a tab
// over the stage and a frame of its own, in a sandbox: a view asks for what it
// shows through here (bridge/view.js), and only for what a view may ask. What
// is pointed at, looked at or tapped is in the frame of the tab that is shown.
import { reachable, run, type Info } from './api.ts';
import { clear, h } from './dom.ts';

/** Something on the project's page, as the page says it is: where, what is written on it, and how the code would name it. */
/** Something on the project's page: what it says, and what is written around it (the card a picture is on). */
export interface Picked {
  x: number; y: number; w: number; h: number; words: string; near: string; tag: string; selector: string; path: string;
  /** A thing in a scene three.js draws there: what it is, its geometry and material, where it is, which one of how many like it. */
  three?: Record<string, unknown>;
  /** A picture of it as it is on the screen (a data URL), when one was asked for and could be made. */
  image?: string;
}

/** A view, as views.list says it. */
export interface ViewInfo { name: string; kind: string; url: string; proposed?: boolean }

/** What a view may ask for, and whether it is asked of the working copy when the stage shows that. */
export const VIEW_ASKS: Record<string, boolean> = {
  'views.list': false, 'logs.read': true, 'data.tables': true, 'data.query': true, 'api.endpoints': true,
  'page.request': true, 'page.read': false, 'project.commands': false, 'project.run': true,
};

export interface Stage {
  /** What the frame shows now. */
  showing: 'project' | 'copy';
  /** The view whose tab is shown; null for the page. */
  tab: string | null;
  views: ViewInfo[];
  /** The views there are now: their tabs. `anew` loads the ones that are open again (one of them may have changed). */
  setViews(list: ViewInfo[], anew?: boolean): void;
  /** Show a view's tab, or the page's (null). False when there is no such view. */
  showTab(name: string | null): boolean;
  /** The copy is shown by an example of its change set (a page made to show it), not from where the app opens. */
  example: boolean;
  /** How many times a page in the frame has said it is there: one more each time a page is loaded in it. */
  loads: number;
  /** What the page in the frame can do, as far as it has said. */
  can: { snapshot: boolean; point: boolean; find: boolean };
  /**
   * Show the agent's working copy, started from the world the person is in; or the project again. With `anew` the
   * project's page is loaded again when it is the one shown already: its code changed, and not every page a project
   * is served with loads itself again for that.
   */
  showCopy(url: string, example?: boolean): void;
  showProject(anew?: boolean): void;
  /** Load the page that is shown anew, where it is: a file of it changed, and it does not follow its files itself. */
  again(): void;
  /** Where the frame is on this screen; null while no page is shown in it. */
  rect(): { x: number; y: number; w: number; h: number } | null;
  /** Where a point of the project's world is on this screen; null when the page does not say. */
  where(x: number, y: number): Promise<{ x: number; y: number } | null>;
  /**
   * Where something on the page is on this screen, by the words on it or a selector; the page moves to it.
   * 'missing' when the page has no such thing, null when the page does not answer.
   */
  find(at: string): Promise<{ x: number; y: number; w: number; h: number } | 'missing' | null>;
  /**
   * Something done on the page as a person would (look, tap, type, go; picture: a picture of it): what the page
   * answers, with a place on this screen when it is about one thing; null when the page does not answer in time.
   */
  act(what: Record<string, unknown>, wait?: number): Promise<Record<string, unknown> | null>;
  /** What is at a place of this screen, on the project's page; null when nothing is, or the page does not answer. With `image`, a picture of it comes along. */
  pick(x: number, y: number, image?: boolean): Promise<Picked | null>;
}

type Can = { snapshot: boolean; point: boolean; find: boolean };
/** A frame on the stage: the page's, or a view's. */
interface Pane { frame: HTMLIFrameElement; can: Can; view: string | null }

export function createStage(root: HTMLElement, info: Info, on: { snapshot(snapshot: unknown): void; changed(): void; copy?(want: boolean): void }): Stage {
  const frame = h<'iframe'>('iframe#t-frame', { title: info.name, allow: 'autoplay; fullscreen; vibrate', hidden: true });
  const none = h('div#t-nopage');
  const bar = h<'nav'>('nav#t-views', { hidden: true, 'aria-label': 'What there is to see' });
  root.append(frame, none, bar);
  const main: Pane = { frame, can: { snapshot: false, point: false, find: false }, view: null };
  const panes = new Map<string, Pane>();
  let active = main;

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

  /** A project without a page: this space says so. (Also when the copy's page was shown and they go back.) */
  const nothing = () => {
    wanted = '';
    frame.hidden = true;
    frame.removeAttribute('src');
    none.hidden = false;
    clear(none,
      h('b', {}, `${info.name} has no page here.`),
      h('p', {}, 'Tandem shows a project\'s own page in this space. Ask the agent to set tandem up for it, or say how it is started in .tandem/tandem.json: "page": "npm run dev -- --port {port}".'),
      h('p', {}, 'The tools work without it: open them with the round button.'));
  };
  if (info.page) void show(info.page, `${info.name}`);
  else if (info.project) nothing();
  // No project at all: the page is there to choose one.
  else clear(none, h('b', {}, 'Which project?'), h('p', {}, 'Tandem works on a project: a folder with a git repository in it. Choose one from the list.'));

  /** The last world the project's page shared: what the copy is started from. */
  let world: unknown;
  let asked = 0;
  const waiting = new Map<number, (at: { x: number; y: number } | null) => void>();
  const picking = new Map<number, (got: Picked | null) => void>();
  const acting = new Map<number, (got: Record<string, unknown> | null) => void>();
  const finding = new Map<number, (at: { x: number; y: number; w: number; h: number } | 'missing' | null) => void>();
  const send = (msg: Record<string, unknown>) => active.frame.contentWindow?.postMessage({ tandem: 1, ...msg }, '*');
  const viewUrl = (v: ViewInfo) => `${v.url}${stage.showing === 'copy' ? '?copy=1' : ''}`;
  /** Where the page and the views are seen: a tab for each, and project or working copy for all of them. */
  function paintBar() {
    bar.hidden = !stage.views.length;
    document.body.classList.toggle('t-viewed', !bar.hidden);
    if (bar.hidden) return;
    const tab = (name: string | null, label: string, v?: ViewInfo) => h<'button'>(`button.t-vtab${stage.tab === name ? '.on' : ''}${v?.proposed ? '.proposed' : ''}`,
      { onclick: () => stage.showTab(name), title: v?.proposed ? 'Proposed: as the change to how the project is run would make it' : v ? `${v.kind === 'view' ? 'A page made for this project' : v.kind}` : 'The project\'s page' },
      label, v?.proposed && h('i', {}, 'proposed'));
    clear(bar,
      h('div.tabs', {}, tab(null, 'Page'), stage.views.map((v) => tab(v.name, v.name, v))),
      info.copy && on.copy && h('div.which', {},
        h<'button'>(`button${stage.showing === 'project' ? '.on' : ''}`, { onclick: () => on.copy!(false), title: 'The project as it is' }, 'Project'),
        h<'button'>(`button${stage.showing === 'copy' ? '.on' : ''}`, { onclick: () => on.copy!(true), title: 'The agent\'s working copy' }, 'Copy')));
  }
  /** A view's frame, made when its tab is first shown; in a sandbox, so it cannot reach tandem by itself. */
  function paneFor(v: ViewInfo): Pane {
    let pane = panes.get(v.name);
    if (!pane) {
      const f = h<'iframe'>('iframe.t-view', { title: v.name, hidden: true, sandbox: 'allow-scripts allow-forms allow-modals allow-popups', src: viewUrl(v) });
      root.insertBefore(f, bar);
      pane = { frame: f, can: { snapshot: false, point: false, find: false }, view: v.name };
      panes.set(v.name, pane);
    }
    return pane;
  }
  /** A view asks for something: only what a view may, and of the working copy when that is what is shown. */
  async function ask(pane: Pane, m: { id?: number; name?: string; input?: Record<string, unknown> }) {
    const answer = (out: Record<string, unknown>) => pane.frame.contentWindow?.postMessage({ tandem: 1, type: 'ran', id: m.id, ...out }, '*');
    const name = String(m.name ?? '');
    if (!(name in VIEW_ASKS)) return answer({ ok: false, code: 'permission', error: `a view cannot ask for ${name}; it may ask for ${Object.keys(VIEW_ASKS).join(', ')}` });
    const input = { ...(m.input && typeof m.input === 'object' ? m.input : {}) };
    if (VIEW_ASKS[name] && input.copy === undefined && stage.showing === 'copy') input.copy = true;
    try { answer({ ok: true, result: await run(name, input) }); } catch (e) { answer({ ok: false, code: (e as { code?: string }).code ?? 'error', error: e instanceof Error ? e.message : String(e) }); }
  }

  /** The views follow the page to the working copy and back: what is open of them is loaded again for that. */
  const viewsFollow = () => { for (const [name, pane] of panes) { const v = stage.views.find((x) => x.name === name); if (v) { pane.can = { snapshot: false, point: false, find: false }; pane.frame.src = viewUrl(v); } } };
  const stage: Stage = {
    showing: 'project',
    example: false,
    loads: 0,
    tab: null,
    views: [],
    get can() { return active.can; },
    set can(can: Can) { active.can = can; },
    setViews(list, anew = false) {
      stage.views = list;
      for (const [name, pane] of panes) {
        const v = list.find((x) => x.name === name);
        if (!v) { pane.frame.remove(); panes.delete(name); } else if (anew) { pane.can = { snapshot: false, point: false, find: false }; pane.frame.src = viewUrl(v); }
      }
      if (stage.tab !== null && !panes.has(stage.tab)) stage.showTab(null);
      paintBar();
    },
    showTab(name) {
      const v = name === null ? undefined : stage.views.find((x) => x.name === name);
      if (name !== null && !v) return false;
      active = v ? paneFor(v) : main;
      stage.tab = v ? v.name : null;
      for (const pane of [main, ...panes.values()]) if (pane !== main) pane.frame.hidden = pane !== active;
      // (The page's frame keeps what it shows behind a view: it is only out of sight.)
      root.classList.toggle('t-on-view', active !== main);
      paintBar();
      on.changed();
      return true;
    },
    showCopy(url, example = false) {
      const was = stage.showing;
      stage.showing = 'copy';
      stage.example = example;
      main.can = { snapshot: false, point: false, find: false };
      void show(url, 'the working copy');
      if (was !== 'copy') viewsFollow();
      paintBar();
      on.changed();
    },
    showProject(anew = false) {
      if (stage.showing === 'project' && !anew) return;
      const was = stage.showing;
      stage.showing = 'project';
      stage.example = false;
      main.can = { snapshot: false, point: false, find: false };
      if (info.page) void show(info.page, info.name); else if (info.project) nothing();
      if (was !== 'project') viewsFollow();
      paintBar();
      on.changed();
    },
    rect() {
      if (active.frame.hidden) return null;
      const r = active.frame.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    },
    again() {
      // (Not through show(): the page is up, and the frame is not hidden while it comes back.)
      if (!frame.hidden && frame.src) frame.src = wanted;
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
    act(what, wait = 2500) {
      if (!stage.can.find) return Promise.resolve(null);
      const id = ++asked;
      return new Promise((resolve) => {
        acting.set(id, resolve);
        send({ ...what, type: 'do', id });
        setTimeout(() => { if (acting.delete(id)) resolve(null); }, wait);
      });
    },
    pick(x, y, image = false) {
      if (!stage.can.find) return Promise.resolve(null);
      const id = ++asked;
      const r = active.frame.getBoundingClientRect();
      return new Promise((resolve) => {
        picking.set(id, resolve);
        send({ type: 'pick', id, x: x - r.left, y: y - r.top, ...(image && { image: true }) });
        // (A picture takes a moment to make.)
        setTimeout(() => { if (picking.delete(id)) resolve(null); }, image ? 5000 : 800);
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
    const m = ev.data as { tandem?: number; type?: string; id?: number; x?: number; y?: number; w?: number; h?: number; missing?: boolean; snapshot?: unknown; loaded?: boolean; can?: Partial<Stage['can']>; name?: string; input?: Record<string, unknown> } | null;
    if (!m || m.tandem !== 1) return;
    const pane = ev.source === frame.contentWindow ? main : [...panes.values()].find((p) => p.frame.contentWindow === ev.source);
    if (!pane) return;
    const frameOf = pane.frame;
    if (pane !== main) {
      if (m.type === 'run') void ask(pane, m);
      else if (m.type === 'page') { pane.can = { ...pane.can, find: !!m.can?.find }; if (pane === active) stage.loads++; }
    }
    if (pane !== main && !['did', 'picked', 'found'].includes(String(m.type))) return;
    if (m.type === 'hello') {
      main.can = { ...main.can, snapshot: !!m.can?.snapshot, point: !!m.can?.point };
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
      main.can = { ...main.can, find: !!m.can?.find };
      stage.loads++;
    } else if (m.type === 'did' && m.id !== undefined) {
      const r = frameOf.getBoundingClientRect();
      const { tandem: _t, type: _y, id: _i, ...got } = m as Record<string, unknown>;
      // A place on the page is a place on this screen, moved by where the frame is.
      if (typeof got.x === 'number' && typeof got.y === 'number') { got.x += r.left; got.y += r.top; }
      acting.get(m.id)?.(got);
      acting.delete(m.id);
    } else if (m.type === 'picked' && m.id !== undefined) {
      const r = frameOf.getBoundingClientRect();
      const p = m as unknown as Picked;
      picking.get(m.id)?.(m.missing ? null : { x: r.left + Number(p.x), y: r.top + Number(p.y), w: Number(p.w), h: Number(p.h), words: String(p.words ?? ''), near: String(p.near ?? ''), tag: String(p.tag ?? ''), selector: String(p.selector ?? ''), path: String(p.path ?? ''), ...(p.three && typeof p.three === 'object' && { three: p.three }), ...(typeof p.image === 'string' && p.image.startsWith('data:image/') && { image: p.image }) });
      picking.delete(m.id);
    } else if (m.type === 'found' && m.id !== undefined) {
      const r = frameOf.getBoundingClientRect();
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
