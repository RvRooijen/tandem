// Which project tandem is working on, and choosing another. Tandem is started
// once; from here it is pointed at a folder. Opening one starts the core again
// on it, and the page with it.
import { info as getInfo } from '../api.ts';
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';

interface Found { dir: string; name: string; git: boolean; known: boolean; page: boolean; adapter: boolean; open: boolean }
interface Listing { open: string | null; roots: string[]; projects: Found[] }
interface Folder { dir: string; parent: string | null; folders: string[]; home: string }

/** Wait for the core to be back on the project that was asked for, then load the page again on it. */
export async function reopen(dir: string) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await getInfo()).root === dir) break; } catch { /* the core is starting again */ }
  }
  location.reload();
}

export function projectsPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let opening = '';
  /** The new project being filled in: kept while the folders are walked. */
  let draft = { name: '', in: '' };

  /** Walk the folders, to say where a new project goes. */
  async function browse(dir?: string) {
    const got = await app.act<Folder>('projects.browse', dir ? { dir } : {});
    if (!body || !got) return;
    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void paint() }, '‹ Projects'), h('b', {}, 'Where does it go?')),
      h('p.k.here', {}, got.dir),
      h('div.t-row', {}, h<'button'>('button.primary', { onclick: () => { draft.in = got.dir; void paint(); } }, 'Here')),
      got.dir !== got.home && h('div.item.folder', { onclick: () => void browse(got.home) }, h('b', {}, '⌂ home'), h('small', {}, got.home)),
      got.parent && h('div.item.folder', { onclick: () => void browse(got.parent!) }, h('b', {}, '↑ up'), h('small', {}, got.parent)),
      got.folders.map((n) => h('div.item.folder', { onclick: () => void browse(`${got.dir === '/' ? '' : got.dir}/${n}`) }, h('b', {}, `📁 ${n}`))),
      !got.folders.length && h('p.t-hint', {}, 'No folders in here.'));
    body.scrollTop = 0;
  }

  async function paint() {
    if (!body) return;
    if (opening) return clear(body, h('div.working', {}, h('i.spin'), h('span', {}, `Opening ${opening}…`)));
    const got = await app.act<Listing>('projects.list');
    if (!body || !got) return;
    const open = async (p: Found) => {
      if (p.open) return app.close();
      const ok = await app.act<{ opening: string; restarting: boolean }>('projects.open', { dir: p.dir });
      if (!ok) return;
      if (!ok.restarting) return app.toast('It is chosen. Start tandem again to open it.');
      opening = p.name;
      void paint();
      void reopen(ok.opening);
    };
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
        h<'button'>('button', { onclick: () => void browse(draft.in || undefined) }, draft.in ? 'Somewhere else' : 'Choose a folder'));
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
      void reopen(ok.opening);
    };
    fresh.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void create(); });
    const other = h<'input'>('input', { placeholder: '/path/to/a/folder/with/projects', 'aria-label': 'Another folder to look for projects in', spellcheck: false });
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
      !got.projects.length && h('div.empty', {}, h('b', {}, 'No folders found.'), h('p', {}, 'Tell tandem where your projects are, below.')),
      h('h3', {}, 'Look somewhere else too'),
      h('div.adder', {}, other, h<'button'>('button', { onclick: async () => {
        if (!other.value.trim()) return;
        if (await app.act('projects.look', { dir: other.value.trim() })) void paint();
      } }, 'Add')),
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
