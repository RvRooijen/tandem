// Concepts: the project's living design document, and the loose thoughts
// that are not part of it yet. The document reads as one: a concept that is
// part of nothing is a chapter, what is part of it stands under it, and all of
// it is there to read: a piece is folded to its one sentence, and a chapter's
// parts put away, only when the person does that. Above it the person
// types what comes to mind, without a name or a place for it; a thought goes
// into the document when they want it to. One concept opened up to work on:
// its words, its stage, what it is linked to and what makes it real, and a
// lock to keep the agent off it.
import type { Concept, Stage } from '../../core/concepts.ts';
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { ago, clear, h, prose } from '../dom.ts';
import { conceptForm } from '../conceptform.ts';
import { icon } from '../icons.ts';

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

  /** What the person folded away in the document: the pieces shut to their one sentence, and the chapters whose parts are put away. Everything else is open. */
  const shut = new Set<string>();
  const folded = new Set<string>();
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

  /** What the document was made of when it was last asked for: it is shown at once when the tab is opened, and asked again behind it. */
  let heard: string | undefined;

  async function list(atOnce = false) {
    if (!body) return;
    open = undefined;
    dirty = false;
    if (foot) clear(foot);
    // The tab is opened: what was there last time is there at once, and is drawn again only if it turns out to be
    // different now. (Not on the way back from a piece: what was done there is waited for.)
    if (atOnce && heard !== undefined) paint();
    const [concepts, thoughts] = await Promise.all([app.act<Brief[]>('concepts.list'), app.act<Thought[]>('thoughts.list')]);
    if (!concepts || !thoughts) return;
    const texts = new Map<string, string>();
    await Promise.all(concepts.filter((c) => !shut.has(c.id)).map(async (c) => { const got = await app.act<Concept>('concepts.get', { id: c.id }); if (got) texts.set(c.id, got.text); }));
    const now = JSON.stringify([concepts, thoughts, [...texts].sort()]);
    const same = now === heard;
    heard = now;
    all = concepts;
    loose = thoughts;
    // (A piece that was opened by hand meanwhile keeps the words that were read for it.)
    words = new Map([...words, ...texts].filter(([id]) => all.some((c) => c.id === id)));
    for (const set of [shut, folded]) for (const id of set) if (!all.some((c) => c.id === id)) set.delete(id);
    if (!body || open) return;
    if (!same || !body.querySelector('.adder.mind')) paint();
  }

  async function read(id: string) {
    const c = await app.act<Concept>('concepts.get', { id });
    if (c) words.set(id, c.text);
  }

  /** A piece of the document: what it is in a sentence; opened, all of its words; under it, what is part of it. */
  function piece(c: Brief, parts: Map<string, Brief[]>, depth: number): HTMLElement {
    const mine = parts.get(c.id) ?? [];
    const isOpen = !shut.has(c.id) && words.has(c.id);
    const toggle = async () => {
      if (!shut.has(c.id)) shut.add(c.id);
      else { shut.delete(c.id); if (!words.has(c.id)) await read(c.id); }
      if (body && !open) paint();
    };
    const flip = () => { if (folded.has(c.id)) folded.delete(c.id); else folded.add(c.id); paint(); };
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
      // Its parts hang on a line down their left side, as a block of code does on its braces: the line is what puts them away.
      mine.length > 0 && h('div.nest', {},
        h<'button'>('button.rail', { 'aria-expanded': String(!folded.has(c.id)), 'aria-label': `${folded.has(c.id) ? 'Show' : 'Put away'} the parts of ${c.name}`, onclick: flip }),
        folded.has(c.id)
          ? h('small.away', { onclick: flip }, `${mine.length} ${mine.length === 1 ? 'part' : 'parts'}`)
          : h('div.parts', {}, mine.map((m) => piece(m, parts, depth + 1)))));
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

    const others = (others_ ?? []).filter((o) => o.id !== id);
    const form = conceptForm(draft, { others, touch, open: (to) => void leave(() => detail(to)) });

    clear(body,
      h('div.bar', {}, h<'button'>('button.link', { onclick: () => void leave(list) }, icon('back'), 'The document'), h('span.grow'), app.lockButton(`concept:${id}`, c.locked)),
      form.fields,
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
    requestAnimationFrame(form.fit);

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
      void (id ? detail(id) : open ? detail(open) : list(true));
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
