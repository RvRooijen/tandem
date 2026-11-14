// The fields a concept is worked on with: its name, its stage, its words,
// what it is linked to and what makes it real. The same in the document, where
// a concept that is there is changed, and on a proposal's card, where one that
// is still proposed is.
import type { Stage } from '../core/concepts.ts';
import { clear, h } from './dom.ts';
import { icon } from './icons.ts';

export const FIRM: { id: Stage; says: string }[] = [
  { id: 'idea', says: 'A thought: the agent explores and offers directions.' },
  { id: 'design', says: 'Being worked out in words: the agent helps settle what it is, and leaves the game alone.' },
  { id: 'build', says: 'Being made real: the agent codes it in its working copy and asks for the art.' },
  { id: 'playtest', says: 'In the game: the agent plays it, measures it and tunes it with small proposals.' },
];
export const LINKS = ['part-of', 'leads-to', 'clashes-with'];

export interface ConceptDraft { name: string; stage: Stage; text: string; links: { to: string; kind: string }[]; realised: string[] }

/**
 * The fields, filled from `draft` and writing into it as they are typed in; `touch` is called on every change.
 * `others` are the concepts it can be linked to; `open` goes to one that is tapped, where that can be done.
 */
export function conceptForm(draft: ConceptDraft, o: { others: { id: string; name: string }[]; touch(): void; open?(id: string): void }): { fields: (HTMLElement | HTMLElement[])[]; fit(): void } {
  const name = h<'input'>('input.title', { value: draft.name, placeholder: 'Name it', 'aria-label': 'Name', oninput: () => { draft.name = name.value; o.touch(); } });
  const text = h<'textarea'>('textarea.words', { value: draft.text, placeholder: 'In your own words: what is it, what should it feel like?', 'aria-label': 'Description',
    oninput: () => { draft.text = text.value; o.touch(); fit(); } });
  const fit = () => { text.style.height = 'auto'; text.style.height = `${Math.max(120, text.scrollHeight + 2)}px`; };

  const firmSays = h('p.t-hint');
  const firm = h('div.segments', {}, FIRM.map((f) => h<'button'>('button', { data: { id: f.id }, onclick: () => { draft.stage = f.id; o.touch(); paintFirm(); } }, f.id)));
  const paintFirm = () => {
    firm.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === draft.stage));
    firmSays.textContent = FIRM.find((f) => f.id === draft.stage)?.says ?? '';
  };

  const linksEl = h('div.rows');
  const paintLinks = () => clear(linksEl, draft.links.map((l, i) => h('div.check', {},
    h('span.k', {}, l.kind.replace('-', ' ')),
    h(`span.t-chip${o.open ? '.tap' : ''}`, { onclick: () => o.open?.(l.to) }, o.others.find((x) => x.id === l.to)?.name ?? l.to),
    h<'button'>('button.icon', { 'aria-label': 'Remove', onclick: () => { draft.links.splice(i, 1); o.touch(); paintLinks(); } }, icon('close')))));
  const kind = h<'select'>('select', { 'aria-label': 'Kind of link' }, LINKS.map((k) => h<'option'>('option', { value: k }, k.replace('-', ' '))));
  const to = h<'select'>('select', { 'aria-label': 'Linked concept' }, h<'option'>('option', { value: '' }, 'another concept…'), o.others.map((x) => h<'option'>('option', { value: x.id }, x.name)));
  to.addEventListener('change', () => {
    if (!to.value) return;
    draft.links.push({ to: to.value, kind: kind.value });
    to.value = '';
    o.touch(); paintLinks();
  });

  const realised = h<'textarea'>('textarea.small', { value: draft.realised.join('\n'), rows: Math.max(2, draft.realised.length), placeholder: 'One per line: a rule, a drawing, a test', 'aria-label': 'What makes it real',
    oninput: () => { draft.realised = realised.value.split('\n').map((s) => s.trim()).filter(Boolean); o.touch(); } });

  paintFirm(); paintLinks();
  return {
    fields: [name, firm, firmSays, text, h('h3', {}, 'Links'), linksEl, h('div.adder', {}, kind, to), h('h3', {}, 'What makes it real'), realised],
    fit,
  };
}
