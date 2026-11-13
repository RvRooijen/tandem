// Concepts: the layer the person works in. A list of them, and one opened up:
// its words, its stage, what it is linked to and what makes it real, and a
// lock to keep the agent off it.
// From here a concept is handed to the agent to talk about.
import type { Concept, Stage } from '../../core/concepts.ts';
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';

const FIRM: { id: Stage; says: string }[] = [
  { id: 'idea', says: 'A thought: the agent explores and offers directions.' },
  { id: 'design', says: 'Being worked out in words: the agent helps settle what it is, and leaves the game alone.' },
  { id: 'build', says: 'Being made real: the agent codes it in its working copy and asks for the art.' },
  { id: 'playtest', says: 'In the game: the agent plays it, measures it and tunes it with small proposals.' },
];
const LINKS = ['part-of', 'leads-to', 'clashes-with'];

type Brief = { id: string; name: string; stage: Stage; locked: boolean; summary: string };

export function conceptsPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  /** Under the concept that is open: saving what was changed in it, or throwing that away. */
  let foot: HTMLElement | undefined;
  let open: string | undefined;
  let dirty = false;

  async function list() {
    if (!body) return;
    open = undefined;
    dirty = false;
    if (foot) clear(foot);
    const all = (await app.act<Brief[]>('concepts.list')) ?? [];
    if (!body || open) return;
    const name = h<'input'>('input', { placeholder: 'A new concept: name it', 'aria-label': 'Name of a new concept' });
    const create = async () => {
      if (!name.value.trim()) return;
      const made = await app.act<{ id: string }>('concepts.create', { name: name.value.trim() });
      if (made) void detail(made.id);
    };
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void create(); });
    clear(body,
      h('div.adder', {}, name, h<'button'>('button.primary', { onclick: create }, 'Add')),
      all.length
        ? all.map((c) => h('div.item', { onclick: () => void detail(c.id) },
          h('div.line', {}, h('b', {}, c.locked && '🔒 ', c.name), h('span.t-chip.stage', { data: { stage: c.stage } }, c.stage)),
          h('p', {}, c.summary || 'No words yet.')))
        : h('div.empty', {}, h('b', {}, 'No concepts yet.'),
          h('p', {}, 'A concept is a name and a few words of your own: an idea before it is anything concrete. Add one and talk it through with the agent.'),
          // A project that exists already has its ideas in its code and notes: the agent can write them down.
          h('p', {}, 'Or, for a project that exists already:'),
          h('div.t-row.center', {}, h<'button'>('button.primary', { onclick: async () => { if (await app.act('project.init')) app.open('chat'); } }, 'Let the agent read the project'))));
  }

  async function detail(id: string) {
    if (!body) return;
    open = id;
    const [c, all] = await Promise.all([
      app.act<Concept & { locked: boolean }>('concepts.get', { id }),
      app.act<Brief[]>('concepts.list'),
    ]);
    if (!body || open !== id) return;
    if (!c) return void list();
    dirty = false;
    const draft: Concept = JSON.parse(JSON.stringify(c));
    // What the person changes is theirs to keep or to throw away: the two buttons are there as soon as something is
    // different, and stay in view under the concept while it is worked on.
    const saveBtn = h<'button'>('button.primary', { onclick: () => void save() }, 'Save');
    const discardBtn = h<'button'>('button', { onclick: () => { dirty = false; void detail(id); } }, 'Discard');
    const unsaved = h('div.t-row.unsaved', { hidden: true }, h('span.k', {}, 'Not saved yet'), discardBtn, saveBtn);
    const touch = () => { dirty = true; unsaved.hidden = false; };

    async function save() {
      const input: Record<string, unknown> = { id };
      for (const k of ['name', 'text', 'stage', 'links', 'realised'] as const)
        if (JSON.stringify(draft[k]) !== JSON.stringify(c![k])) input[k] = draft[k];
      if (Object.keys(input).length > 1 && (await app.act('concepts.update', input)) === undefined) return;
      Object.assign(c!, JSON.parse(JSON.stringify(draft)));
      dirty = false;
      unsaved.hidden = true;
    }

    const name = h<'input'>('input.title', { value: draft.name, 'aria-label': 'Name', oninput: () => { draft.name = name.value; touch(); } });
    const text = h<'textarea'>('textarea.words', { value: draft.text, placeholder: 'In your own words: what is it, what should it feel like?', 'aria-label': 'Description',
      oninput: () => { draft.text = text.value; touch(); fit(); } });
    const fit = () => { text.style.height = 'auto'; text.style.height = `${Math.max(120, text.scrollHeight + 2)}px`; };

    const firmSays = h('p.t-hint');
    const firm = h('div.segments', {}, FIRM.map((f) => h<'button'>('button', { data: { id: f.id }, onclick: () => { draft.stage = f.id; touch(); paintFirm(); } }, f.id)));
    const paintFirm = () => {
      firm.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === draft.stage));
      firmSays.textContent = FIRM.find((f) => f.id === draft.stage)!.says;
    };

    const linksEl = h('div.rows');
    const others = (all ?? []).filter((o) => o.id !== id);
    const paintLinks = () => clear(linksEl, draft.links.map((l, i) => h('div.check', {},
      h('span.k', {}, l.kind.replace('-', ' ')),
      h('span.t-chip.tap', { onclick: () => void leave(() => detail(l.to)) }, others.find((o) => o.id === l.to)?.name ?? l.to),
      h<'button'>('button.icon', { 'aria-label': 'Remove', onclick: () => { draft.links.splice(i, 1); touch(); paintLinks(); } }, '✕'))));
    const kind = h<'select'>('select', { 'aria-label': 'Kind of link' }, LINKS.map((k) => h<'option'>('option', { value: k }, k.replace('-', ' '))));
    const to = h<'select'>('select', { 'aria-label': 'Linked concept' }, h<'option'>('option', { value: '' }, 'another concept…'), others.map((o) => h<'option'>('option', { value: o.id }, o.name)));
    to.addEventListener('change', () => {
      if (!to.value) return;
      draft.links.push({ to: to.value, kind: kind.value });
      to.value = '';
      touch(); paintLinks();
    });

    const realised = h<'textarea'>('textarea.small', { value: draft.realised.join('\n'), rows: Math.max(2, draft.realised.length), placeholder: 'One per line: a rule, a drawing, a test', 'aria-label': 'What makes it real',
      oninput: () => { draft.realised = realised.value.split('\n').map((s) => s.trim()).filter(Boolean); touch(); } });

    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void leave(list) }, '‹ Concepts'), h('span.grow'), app.lockButton(`concept:${id}`, c.locked)),
      name, firm, firmSays, text,
      h('h3', {}, 'Links'), linksEl, h('div.adder', {}, kind, to),
      h('h3', {}, 'What makes it real'), realised,
      h('div.t-row', {},
        h<'button'>('button.primary', { onclick: () => void leave(() => app.attach(`concept:${id}`)) }, 'Talk about this'),
        h<'button'>('button.danger', { onclick: async () => { if (confirm(`Throw "${c.name}" away?`) && (await app.act('concepts.remove', { id })) !== undefined) void list(); } }, 'Delete')));
    if (foot) clear(foot, unsaved);
    paintFirm(); paintLinks();
    requestAnimationFrame(fit);

    async function leave(then: () => unknown) {
      // Going somewhere else with something unsaved: asked, not decided for them.
      if (dirty) { if (confirm(`Save what you changed in "${draft.name}"? Cancel throws the changes away.`)) await save(); else dirty = false; }
      then();
    }
  }

  return {
    id: 'concepts', title: 'Concepts',
    init(a) { app = a; },
    show(b, f, id) {
      body = b;
      foot = f;
      void (id ? detail(id) : open ? detail(open) : list());
    },
    hide() { body = undefined; foot = undefined; },
    event(ev: Event, live) {
      if (!live || !body) return;
      // Somebody else changed what is on the screen: show it as it is now, unless it is being typed in.
      if ((ev.type === 'concept.changed' && ev.by !== 'me') || ev.type === 'proposal.decided') {
        if (!open) void list();
        else if (!dirty) void detail(open);
      }
    },
  };
}
