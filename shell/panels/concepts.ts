// Concepts: the project's living design document, and the loose thoughts
// that are not part of it yet. The document reads as one: a concept that is
// part of nothing is a chapter, what is part of it stands under it, and each
// says what it is in one sentence until it is opened. Above it the person
// types what comes to mind, without a name or a place for it; a thought goes
// into the document when they want it to. One concept opened up to work on:
// its words, its stage, what it is linked to and what makes it real, and a
// lock to keep the agent off it.
import type { Concept, Stage } from '../../core/concepts.ts';
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { ago, clear, h, prose } from '../dom.ts';
import { icon } from '../icons.ts';

const FIRM: { id: Stage; says: string }[] = [
  { id: 'idea', says: 'A thought: the agent explores and offers directions.' },
  { id: 'design', says: 'Being worked out in words: the agent helps settle what it is, and leaves the game alone.' },
  { id: 'build', says: 'Being made real: the agent codes it in its working copy and asks for the art.' },
  { id: 'playtest', says: 'In the game: the agent plays it, measures it and tunes it with small proposals.' },
];
const LINKS = ['part-of', 'leads-to', 'clashes-with'];

type Brief = { id: string; name: string; stage: Stage; locked: boolean; summary: string; links?: { to: string; kind: string }[]; changes?: number; waiting?: boolean };
type Thought = { id: string; text: string; ts: number };

/**
 * The concepts as a document: one that is part of another stands under it, the rest are its chapters. (A ring of
 * parts has no top; the one that closes it is a chapter.)
 */
export function outline<T extends { id: string; links?: { to: string; kind: string }[] }>(all: T[]): { chapters: T[]; parts: Map<string, T[]> } {
  const ids = new Set(all.map((c) => c.id));
  const under = new Map<string, string>();
  for (const c of all) {
    const up = c.links?.find((l) => l.kind === 'part-of' && l.to !== c.id && ids.has(l.to));
    if (up) under.set(c.id, up.to);
  }
  for (const c of all) {
    const seen = new Set<string>();
    for (let at = under.get(c.id); at && !seen.has(at); at = under.get(at)) {
      if (at === c.id) { under.delete(c.id); break; }
      seen.add(at);
    }
  }
  const parts = new Map<string, T[]>();
  for (const c of all) { const up = under.get(c.id); if (up) parts.set(up, [...(parts.get(up) ?? []), c]); }
  return { chapters: all.filter((c) => !under.has(c.id)), parts };
}
/** What was changed in the project for a concept: the commits that name it, and the change set that waits. */
type History = { waiting?: { says: string; files: number }; changes: { hash: string; ts: number; says: string }[] };

export function conceptsPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  /** Under the concept that is open: saving what was changed in it, or throwing that away. */
  let foot: HTMLElement | undefined;
  let open: string | undefined;
  let dirty = false;

  /** What is open in the document: the pieces being read, and the chapters whose parts are unfolded. */
  const reading = new Set<string>();
  const unfolded = new Set<string>();
  /** The words of the pieces that were opened, as they were when the list was last asked for. */
  let words = new Map<string, string>();
  let all: Brief[] = [];
  let loose: Thought[] = [];
  /** The loose thought that is being given a name, to become a piece of the document. */
  let naming: string | undefined;
  /** Whether a new piece is being named. */
  let adding = false;
  /** What is being typed as a loose thought: the list is drawn again when something changes, and it is not lost then. */
  let typing = '';

  async function list() {
    if (!body) return;
    open = undefined;
    dirty = false;
    if (foot) clear(foot);
    const [concepts, thoughts] = await Promise.all([app.act<Brief[]>('concepts.list'), app.act<Thought[]>('thoughts.list')]);
    if (!body || open) return;
    all = concepts ?? [];
    loose = thoughts ?? [];
    words = new Map();
    for (const id of reading) if (!all.some((c) => c.id === id)) reading.delete(id);
    await Promise.all([...reading].map(read));
    if (!body || open) return;
    paint();
  }

  async function read(id: string) {
    const c = await app.act<Concept>('concepts.get', { id });
    if (c) words.set(id, c.text);
  }

  /** A piece of the document: what it is in a sentence; opened, all of its words; under it, what is part of it. */
  function piece(c: Brief, parts: Map<string, Brief[]>, depth: number): HTMLElement {
    const mine = parts.get(c.id) ?? [];
    const isOpen = reading.has(c.id) && words.has(c.id);
    const toggle = async () => {
      if (reading.has(c.id)) reading.delete(c.id);
      else { reading.add(c.id); if (!words.has(c.id)) await read(c.id); }
      if (body && !open) paint();
    };
    return h(`div.piece.${depth ? 'part' : 'chapter'}`, { data: { id: c.id, open: String(isOpen) } },
      h('div.head', { onclick: () => void toggle() },
        h('div.line', {}, h('b', {}, c.locked && [icon('lock'), ' '], c.name), h('span.t-chip.stage', { data: { stage: c.stage } }, c.stage)),
        !isOpen && h('p.core', {}, c.summary || 'No words yet.'),
        // What was made for it in the project, and whether something for it waits to be decided.
        (c.changes || c.waiting) && h('small.made', {}, [c.waiting && 'a change waits', c.changes && `${c.changes} ${c.changes === 1 ? 'change' : 'changes'} made`].filter(Boolean).join(' · '))),
      isOpen && h('div.read', {},
        words.get(c.id)!.trim() ? prose(words.get(c.id)!) : h('p.core', {}, 'No words yet.'),
        h('div.t-row', {},
          h<'button'>('button', { onclick: () => void detail(c.id) }, icon('edit'), 'Edit'),
          h<'button'>('button', { onclick: () => app.attach(`concept:${c.id}`) }, 'Talk about this'))),
      mine.length > 0 && h('div.fold', { 'aria-expanded': String(unfolded.has(c.id)), onclick: () => { if (unfolded.has(c.id)) unfolded.delete(c.id); else unfolded.add(c.id); paint(); } },
        h('b', {}, `${mine.length} ${mine.length === 1 ? 'part' : 'parts'}`),
        !unfolded.has(c.id) && h('span', {}, mine.map((m) => m.name).join(', '))),
      mine.length > 0 && unfolded.has(c.id) && h('div.parts', {}, mine.map((m) => piece(m, parts, depth + 1))));
  }

  /** A loose thought: the words as they were typed, and what can be done with it. */
  function thought(t: Thought): HTMLElement {
    if (naming === t.id) {
      const name = h<'input'>('input', { placeholder: 'Name it', 'aria-label': 'Name of the piece this thought becomes' });
      const make = async () => {
        if (!name.value.trim()) return;
        const made = await app.act<{ id: string }>('concepts.create', { name: name.value.trim(), text: t.text, thought: t.id });
        if (!made) return;
        naming = undefined;
        reading.add(made.id);
        void list();
      };
      name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void make(); });
      queueMicrotask(() => name.focus());
      return h('div.thought.naming', { data: { id: t.id } }, h('p', {}, t.text),
        h('div.adder', {}, name, h<'button'>('button.primary', { onclick: make }, 'Add to the document'), h<'button'>('button.icon', { 'aria-label': 'Not now', onclick: () => { naming = undefined; paint(); } }, icon('close'))));
    }
    return h('div.thought', { data: { id: t.id } }, h('p', {}, t.text),
      h('div.line', {}, h('time', {}, ago(t.ts)), h('span.grow'),
        h<'button'>('button.link', { onclick: () => { naming = t.id; paint(); } }, 'Make it a piece'),
        h<'button'>('button.link', { onclick: () => app.attach(`thought:${t.id}`) }, 'Talk about this'),
        h<'button'>('button.icon', { 'aria-label': 'Throw this thought away', onclick: async () => { if ((await app.act('thoughts.remove', { id: t.id })) !== undefined) void list(); } }, icon('close'))));
  }

  function paint() {
    if (!body) return;
    // What comes to mind is typed here as it comes: it is kept, loose, until it is given a place.
    const was = body.querySelector<HTMLTextAreaElement>('.adder.mind textarea');
    const typed = !!was && document.activeElement === was;
    const mind = h<'textarea'>('textarea', { rows: 1, value: typing, placeholder: 'A loose thought: type it as it comes', 'aria-label': 'A loose thought' });
    const keep = async () => {
      const text = mind.value.trim();
      if (!text) return;
      if ((await app.act('thoughts.add', { text })) === undefined) return;
      if (typing.trim() === text) typing = '';
      void list();
    };
    mind.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void keep(); } });
    mind.addEventListener('input', () => { typing = mind.value; mind.style.height = 'auto'; mind.style.height = `${Math.min(140, mind.scrollHeight + 2)}px`; });

    const name = h<'input'>('input', { placeholder: 'A new piece: name it', 'aria-label': 'Name of a new concept' });
    const create = async () => {
      if (!name.value.trim()) return;
      const made = await app.act<{ id: string }>('concepts.create', { name: name.value.trim() });
      if (made) { adding = false; void detail(made.id); }
    };
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void create(); });
    const adder = h('div.adder', {}, name, h<'button'>('button.primary', { onclick: create }, 'Add'));

    const { chapters, parts } = outline(all);
    clear(body,
      h('div.adder.mind', {}, mind, h<'button'>('button.primary', { onclick: keep }, 'Keep')),
      loose.length > 0 && h('div.thoughts', {}, [...loose].reverse().map(thought)),
      h('div.doc-head', {}, h('h3', {}, 'The document'),
        all.length > 0 && h<'button'>('button.link', { 'aria-expanded': String(adding), onclick: () => { adding = !adding; paint(); } }, adding ? 'Not now' : 'Add a piece')),
      (adding || !all.length) && adder,
      all.length
        ? h('div.doc', {}, chapters.map((c) => piece(c, parts, 0)))
        : h('div.empty', {}, h('b', {}, 'Nothing in it yet.'),
          h('p', {}, 'The document says what the project is, in your own words: a piece for each idea, each a name and a few words. Name one, turn a loose thought into one, or talk it through with the agent.'),
          // A project that exists already has its ideas in its code and notes: the agent can write them down.
          h('p', {}, 'Or, for a project that exists already:'),
          h('div.t-row.center', {}, h<'button'>('button.primary', { onclick: async () => { if (await app.act('project.init')) app.open('chat'); } }, 'Let the agent read the project'))));
    if (adding) name.focus(); else if (typed) mind.focus();
  }

  async function detail(id: string) {
    if (!body) return;
    open = id;
    const [c, others_, made] = await Promise.all([
      app.act<Concept & { locked: boolean }>('concepts.get', { id }),
      app.act<Brief[]>('concepts.list'),
      app.act<History>('concepts.history', { id }),
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
    const others = (others_ ?? []).filter((o) => o.id !== id);
    const paintLinks = () => clear(linksEl, draft.links.map((l, i) => h('div.check', {},
      h('span.k', {}, l.kind.replace('-', ' ')),
      h('span.t-chip.tap', { onclick: () => void leave(() => detail(l.to)) }, others.find((o) => o.id === l.to)?.name ?? l.to),
      h<'button'>('button.icon', { 'aria-label': 'Remove', onclick: () => { draft.links.splice(i, 1); touch(); paintLinks(); } }, icon('close')))));
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
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void leave(list) }, icon('back'), 'The document'), h('span.grow'), app.lockButton(`concept:${id}`, c.locked)),
      name, firm, firmSays, text,
      h('h3', {}, 'Links'), linksEl, h('div.adder', {}, kind, to),
      h('h3', {}, 'What makes it real'), realised,
      // What the project gained for it: the change that waits (in the chat, where it is decided), and what was accepted.
      (made?.waiting || made?.changes.length) ? [
        h('h3', {}, 'Changes for it'),
        h('div.rows.made', {},
          made.waiting && h('div.check.waits', { onclick: () => void leave(() => app.open('chat')) },
            h('span.k', {}, made.waiting.says || 'A change to the project'), h('span.t-chip', {}, 'waiting')),
          made.changes.map((m) => h('div.check', { title: m.hash }, h('span.k', {}, m.says), h('time', {}, ago(m.ts))))),
      ] : null,
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
      if ((ev.type === 'concept.changed' && ev.by !== 'me') || ev.type === 'proposal.decided' || (ev.type === 'proposal' && ev.kind === 'code') || (ev.type === 'thought.changed' && ev.by !== 'me')) {
        if (!open) void list();
        else if (!dirty) void detail(open);
      }
    },
  };
}
