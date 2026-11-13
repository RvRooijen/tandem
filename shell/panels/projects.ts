// Which project tandem is working on, and choosing another. Tandem is started
// once; from here it is pointed at a folder. Opening one starts the core again
// on it, and the page with it.
import { info as getInfo } from '../api.ts';
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';

interface Found { dir: string; name: string; git: boolean; known: boolean; page: boolean; adapter: boolean; open: boolean }
interface Listing { open: string | null; roots: string[]; projects: Found[] }

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
    const what = (p: Found) => (!p.git ? 'not a git repository yet: run git init there first'
      : [p.open ? 'open now' : p.known ? 'been here before' : 'new to tandem', p.page && 'has a page', p.adapter && 'can be seen inside'].filter(Boolean).join(' · '));
    const other = h<'input'>('input', { placeholder: '/path/to/a/folder/with/projects', 'aria-label': 'Another folder to look for projects in', spellcheck: false });
    clear(body,
      got.projects.map((p) => h(`div.item.project${p.open ? '.open' : ''}${p.git ? '' : '.off'}`, { onclick: () => p.git && void open(p) },
        h('div.line', {}, h('b', {}, p.name), p.open && h('span.t-chip', {}, 'open')),
        h('p', {}, what(p)),
        h('small', {}, p.dir))),
      !got.projects.length && h('div.empty', {}, h('b', {}, 'No folders found.'), h('p', {}, 'Tell tandem where your projects are, below.')),
      h('h3', {}, 'Look somewhere else too'),
      h('div.adder', {}, other, h<'button'>('button', { onclick: async () => {
        if (!other.value.trim()) return;
        if (await app.act('projects.look', { dir: other.value.trim() })) void paint();
      } }, 'Add')),
      h('p.t-hint', {}, `Looking in: ${got.roots.join(', ')}`));
  }

  return {
    id: 'projects', title: 'Projects',
    init(a) { app = a; },
    show(b) { body = b; void paint(); },
    hide() { body = undefined; },
  };
}
