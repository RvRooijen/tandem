// Which project tandem is working on, and choosing another. Tandem is started
// once; from here it is pointed at a folder. Opening one starts the core again
// on it, and the page with it.
import { coreUp } from '../api.ts';
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';

interface Found { dir: string; name: string; git: boolean; known: boolean; page: boolean; adapter: boolean; open: boolean }
interface Listing { open: string | null; roots: string[]; projects: Found[] }
interface Folder { dir: string; parent: string | null; folders: string[]; home: string; git: boolean }

/** Wait for the core to be back on the project that was asked for, then load the page again on it. */
export async function reopen(dir: string, says: (text: string) => void = () => {}) {
  await new Promise((r) => setTimeout(r, 500));
  await coreUp((text) => says(text), dir);
  location.reload();
}

export function projectsPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let opening = '', openingDoing = '';
  /** What is being done for the project that is being opened, as it is told. */
  const doing = (text: string) => { openingDoing = text; const el = body?.querySelector('.working .doing'); if (el) el.textContent = text; };
  /** The new project being filled in: kept while the folders are walked. */
  let draft = { name: '', in: '' };

  /** Open the project in a folder: the core starts again on it, and the page with it. */
  async function openDir(dir: string, name: string) {
    const ok = await app.act<{ opening: string; restarting: boolean }>('projects.open', { dir });
    if (!ok) return;
    if (!ok.restarting) { app.toast('It is chosen. Start tandem again to open it.'); return void paint(); }
    opening = name;
    void paint();
    void reopen(ok.opening, doing);
  }

  /**
   * Walk the folders. For a new project: to say where it goes. For finding one that is there already: to say which
   * folder the projects are in, or, standing in a repository, to open that one.
   */
  async function browse(why: 'new' | 'find', dir?: string) {
    const got = await app.act<Folder>('projects.browse', dir ? { dir } : {});
    if (!body || !got) return;
    const into = (d: string) => () => void browse(why, d);
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void paint() }, '‹ Projects'), h('b', {}, why === 'new' ? 'Where does it go?' : 'Where are they?')),
      h('p.k.here', {}, got.dir),
      why === 'new'
        ? h('div.t-row', {}, h<'button'>('button.primary', { onclick: () => { draft.in = got.dir; void paint(); } }, 'Here'))
        : h('div.t-row', {},
          h<'button'>('button.primary', { onclick: async () => { if (await app.act('projects.look', { dir: got.dir })) void paint(); } }, 'My projects are in here'),
          got.git && h<'button'>('button', { onclick: () => void openDir(got.dir, got.dir.split('/').pop() || got.dir) }, 'Open this one')),
      got.dir !== got.home && h('div.item.folder', { onclick: into(got.home) }, h('b', {}, '⌂ home'), h('small', {}, got.home)),
      got.parent && h('div.item.folder', { onclick: into(got.parent) }, h('b', {}, '↑ up'), h('small', {}, got.parent)),
      got.folders.map((n) => h('div.item.folder', { onclick: into(`${got.dir === '/' ? '' : got.dir}/${n}`) }, h('b', {}, `📁 ${n}`))),
      !got.folders.length && h('p.t-hint', {}, 'No folders in here.'));
    body.scrollTop = 0;
  }

  async function paint() {
    if (!body) return;
    if (opening) return clear(body, h('div.working', {}, h('i.spin'), h('span', {}, h('b', {}, `Opening ${opening}…`), h('small.doing', {}, openingDoing))));
    const got = await app.act<Listing>('projects.list');
    if (!body || !got) return;
    const open = (p: Found) => (p.open ? app.close() : void openDir(p.dir, p.name));
    const what = (p: Found) => [p.open ? 'open now' : p.known ? 'been here before' : 'new to tandem', p.page && 'has a page', p.adapter && 'can be seen inside',
      !p.git && 'no git repository yet: tandem starts one when you open it'].filter(Boolean).join(' · ');
    // A new project: what it is called, and where it goes. Where is always the person's to choose: the folders of
    // this machine are walked from here, and the project is made in the one they say.
    const fresh = h<'input'>('input', { placeholder: 'What is it called?', 'aria-label': 'Name of a new project', value: draft.name, oninput: () => { draft.name = fresh.value; } });
    const whereEl = h('div.where');
    const createBtn = h<'button'>('button.primary', { onclick: () => void create() }, 'Create');
    const paintWhere = () => {
      createBtn.disabled = !draft.in;
      clear(whereEl,
        h('span.k', {}, draft.in ? `In ${draft.in}` : 'Where? Not chosen yet.'),
        h<'button'>('button', { onclick: () => void browse('new', draft.in || undefined) }, draft.in ? 'Somewhere else' : 'Choose a folder'));
    };
    const create = async () => {
      if (!fresh.value.trim()) return app.toast('Give it a name.');
      if (!draft.in) return app.toast('Choose the folder it goes in.');
      const ok = await app.act<{ opening: string; restarting: boolean }>('projects.create', { name: fresh.value.trim(), in: draft.in });
      if (!ok) return;
      draft = { name: '', in: '' };
      if (!ok.restarting) return app.toast('It is made. Start tandem again to open it.');
      opening = fresh.value.trim();
      void paint();
      void reopen(ok.opening, doing);
    };
    fresh.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void create(); });
    clear(body,
      h('h3', {}, 'A new project'),
      fresh, whereEl,
      h('div.t-row', {}, createBtn),
      h('p.t-hint', {}, 'A new folder with that name, in the folder you choose, with a git repository in it.'),
      h('h3', {}, 'Open a project'),
      got.projects.map((p) => h(`div.item.project${p.open ? '.open' : ''}`, { onclick: () => void open(p) },
        h('div.line', {}, h('b', {}, p.name), p.open && h('span.t-chip', {}, 'open')),
        h('p', {}, what(p)),
        h('small', {}, p.dir),
        // The open project can be set up from here: the agent reads it and proposes its concepts and how it is run.
        p.open && h('div.t-row', {}, h<'button'>('button', { onclick: async (ev: MouseEvent) => { ev.stopPropagation(); if (await app.act('project.init')) app.open('chat'); } }, 'Set tandem up for it')))),
      !got.projects.length && h('div.empty', {}, h('b', {}, 'No folders found.'), h('p', {}, 'Show tandem where your projects are, below.')),
      h('h3', {}, 'Look somewhere else too'),
      h('div.t-row', {}, h<'button'>('button', { onclick: () => void browse('find') }, 'Find a folder')),
      h('p.t-hint', {}, `Looking in: ${got.roots.join(', ')}`));
    paintWhere();
  }

  return {
    id: 'projects', title: 'Projects', tab: false,
    init(a) { app = a; },
    show(b) { body = b; void paint(); },
    hide() { body = undefined; },
  };
}
