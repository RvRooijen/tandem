// The conversation. Not only words: a proposal is a card with what it changes
// and buttons to play, accept or reject it; a look is a picture; a playtest is
// a small table. All of it is the event log, drawn.
import type { Event } from '../../core/events.ts';
import { run } from '../api.ts';
import type { App, Panel, Show } from '../app.ts';
import { conceptForm, type ConceptDraft } from '../conceptform.ts';
import { ago, clear, h, mins, prose, short } from '../dom.ts';
import { icon } from '../icons.ts';

interface Change {
  /** Who proposed it: the agent, or the person, who added a concept of their own to the round. */
  by?: string;
  id: string; kind: string; path: string; before?: Record<string, unknown>; after?: Record<string, unknown>; note: string;
  touches?: { id: string; name: string; stage: string }[];
  /** A drawing: what it looks like. */
  /** Code: the files the working copy changes. */
  files?: { path: string; added: number; removed: number; status: string }[];
  phase?: string; isNew?: boolean; pictures?: { before?: string; after?: string; looks?: { look: string; before?: string; after?: string }[] };
  /** Decided on its own or with the rest of its round; not set while it waits. */
  status?: 'accepted' | 'rejected';
  /** What the agent asks the person about it: each answered in a field on the card. */
  questions?: string[];
  /** Code: where the change can be seen, when the agent said so. */
  show?: Show;
  /** A concept: the loose thought of the person it takes in, in their words. */
  thought?: string;
  /** A concept: the fields the person changed on the card, when they did. */
  edited?: string[];
}
const FIELDS = ['name', 'stage', 'text', 'links', 'realised'] as const;
/** Of a concept, or of what is proposed for one: the fields a concept has, where they are given. */
const fieldsOf = (v: Record<string, unknown> | undefined) => Object.fromEntries(FIELDS.filter((k) => v?.[k] !== undefined).map((k) => [k, v![k]])) as Partial<ConceptDraft>;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** A round is 'decided' when its pieces went different ways: some taken, some refused. */
interface Round {
  round: string; by: string; changes: Change[]; status: 'pending' | 'accepted' | 'rejected' | 'decided'; el?: HTMLElement;
  /** The files of a code change that were tapped open, with what changed in each. */
  read?: Map<string, string>;
}

export function refChip(app: App, ref: string, onRemove?: () => void): HTMLElement {
  const [kind, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  // Something on the project's page: what is written on it, or what kind of thing it is.
  let onPage: { words?: string; near?: string; tag?: string; selector?: string; three?: { uuid?: string } } = {};
  if (kind === 'page') { try { onPage = JSON.parse(rest); } catch { /* shown as it is */ } }
  const open = () => {
    if (kind === 'concept') app.open('concepts', rest);
    else if (kind === 'thought') app.open('concepts');
    else if (kind === 'drawing') app.open('art', rest);
    else if (kind === 'point') { const [x, y] = rest.split(',').map(Number); app.point(x, y); }
    else if (kind === 'page' && (onPage.three?.uuid || onPage.selector)) { app.reveal(); app.point(0, 0, '', onPage.three?.uuid ? `three:${onPage.three.uuid}` : onPage.selector); }
  };
  const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);
  // (The picture that goes with it, while it is not sent yet.)
  const picture = onRemove ? app.pictures.get(ref) : undefined;
  const label = kind === 'page' && onPage.three ? `in the scene: ${short(onPage.words ?? 'something')}` : kind === 'page' ? `on the page: ${onPage.words ? `"${short(onPage.words)}"` : `${onPage.tag ?? 'something'}${onPage.near ? ` by "${short(onPage.near)}"` : ''}`}` : kind === 'thought' ? 'a loose thought' : `${kind} ${rest}`;
  return h('span.t-chip.ref', { data: { kind } },
    picture && h<'img'>('img', { src: picture.url, alt: 'A picture of it', onclick: () => app.zoom(picture.url) }),
    h('span', { onclick: open }, label),
    onRemove && h<'button'>('button', { 'aria-label': 'Take off', onclick: onRemove }, icon('close')));
}

export function chatPanel(): Panel {
  let app!: App;
  const rounds = new Map<string, Round>();
  /** Questions the agent asked, by what they came with (a proposal, or a card of their own): what was answered, and what is being typed. */
  const answered = new Map<string, string[]>();
  const drafts = new Map<string, string[]>();
  const asks = new Map<string, { questions: string[]; about?: string; el: HTMLElement }>();
  /**
   * Proposed concepts the person is changing on their card, by the proposal's id, and a concept of their own they
   * are adding to a round, by `new:<round>`: what is typed, what it was when they started, and what it can be linked to.
   */
  const editing = new Map<string, { draft: ConceptDraft; base: ConceptDraft; others: { id: string; name: string }[]; el?: HTMLElement }>();
  const list = h('div.chat');
  /**
   * What is still to be decided stays in sight: a line at the top of the conversation for every round that waits,
   * while its card is scrolled out of view. Tapped, it goes to the card.
   */
  const pins = h('div.pins');
  function paintPins() {
    const view = body?.getBoundingClientRect();
    clear(pins, [...rounds.values()].filter((r) => r.status === 'pending' && r.el?.isConnected).map((r) => {
      const at = r.el!.getBoundingClientRect();
      if (view && at.bottom > view.top + 24 && at.top < view.bottom - 24) return null;
      const code = r.changes.find((c) => c.kind === 'code');
      const left = r.changes.filter((c) => !c.status).length;
      const what = code ? String(code.note ?? '').split('\n')[0] || 'what the working copy changed' : r.changes.filter((c) => !c.status).map((c) => String(c.after?.name ?? c.path)).join(', ');
      return h('div.pin', { onclick: () => r.el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }) },
        h('div.what', {}, h('b', {}, code ? 'A change to the project waits' : left === 1 ? 'A proposal waits' : `${left} proposals wait`), h('span', {}, what)),
        code && app.info.page && h<'button'>('button', { onclick: (e: MouseEvent) => { e.stopPropagation(); void app.playCopy(code.show); } }, 'Play'),
        h<'button'>('button.primary', { onclick: (e: MouseEvent) => { e.stopPropagation(); void decide(r, true); } }, left === 1 ? 'Accept' : 'Accept all'));
    }));
  }
  const status = h('div.agent-status', { hidden: true });
  const refsEl = h('div.refs');
  const usage = h('div.usage');
  const input = h<'textarea'>('textarea', { rows: 1, placeholder: 'Say something…', 'aria-label': 'Message' });
  const sendBtn = h<'button'>('button.primary', { onclick: () => void send() }, 'Send');
  const newBtn = h<'button'>('button.icon.new-chat', { 'aria-label': 'New conversation', title: 'New conversation', onclick: () => {
    if (confirm('Start a new conversation? The chat is cleared and the agent forgets what was said. Pending proposals stay.')) void app.act('chat.new');
  } }, icon('again'));
  const EMPTY = () => h('div.empty', {}, h('b', {}, 'Nothing said yet.'), h('p', {}, 'Talk about the project while you use it. Type @ to point at a concept or a drawing, and use the paperclip to share a photo or a file.'));

  // ---------------------------------------------------------------- what goes along with a message

  /** Photos and files that go with the next message: kept by the core when they are picked, sent along by name. */
  interface Shared { name: string; label: string; url: string; image: boolean }
  let shared: Shared[] = [];
  const sharedEl = h('div.shared', { hidden: true });
  const picker = h<'input'>('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Photos or files to share' });
  const clip = h<'button'>('button.icon.clip', { 'aria-label': 'Share a photo or a file', title: 'Share a photo or a file', onclick: () => picker.click() }, icon('clip'));
  const fileChip = (f: Shared, onRemove?: () => void) => h(`span.file${f.image ? '.image' : ''}`, {},
    f.image ? h<'img'>('img', { src: f.url, alt: f.label, loading: 'lazy', onclick: () => app.zoom(f.url) }) : h<'a'>('a', { href: f.url, target: '_blank', rel: 'noopener' }, icon('file'), ` ${f.label}`),
    onRemove && h<'button'>('button', { 'aria-label': `Take ${f.label} off`, onclick: onRemove }, icon('close')));
  function paintShared() {
    clear(sharedEl, shared.map((f) => fileChip(f, () => { shared = shared.filter((x) => x !== f); paintShared(); })));
    sharedEl.hidden = !shared.length;
  }
  const base64 = (file: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  /** Hand files to the core, one by one; what it gives back goes along with the next message. */
  async function share(files: Iterable<File>) {
    for (const file of files) {
      if (file.size > 40e6) { app.toast(`${file.name} is too big to share (40 MB at most).`); continue; }
      clip.classList.add('busy');
      try {
        const kept = await app.act<Shared>('chat.attach', { name: file.name || 'photo.jpg', data: await base64(file) });
        if (kept) { shared.push(kept); paintShared(); }
      } catch { app.toast(`${file.name} could not be read.`); }
      clip.classList.remove('busy');
    }
  }
  picker.addEventListener('change', () => { void share([...(picker.files ?? [])]); picker.value = ''; });

  /**
   * Pointing at things by name: typing @ offers the concepts and the drawings. What is picked is written into the
   * message as @name and goes along as what the message is about, so the agent has it in front of it.
   */
  interface Thing { ref: string; name: string; id: string; kind: string }
  let things: Thing[] = [], fetched = 0;
  const offerEl = h('div.offer', { hidden: true });
  async function known(): Promise<Thing[]> {
    if (Date.now() - fetched < 15_000) return things;
    fetched = Date.now();
    const [concepts, drawings] = await Promise.all([
      run<{ id: string; name: string }[]>('concepts.list').catch(() => []),
      run<{ name: string }[]>('art.list').catch(() => []),
    ]);
    things = [
      ...concepts.map((c) => ({ ref: `concept:${c.id}`, name: c.name, id: c.id, kind: 'concept' })),
      ...drawings.map((d) => ({ ref: `drawing:${d.name}`, name: d.name, id: d.name, kind: 'drawing' })),
    ];
    return things;
  }
  /** The @word the caret is in, if it is in one. */
  function typing(): { from: number; word: string } | null {
    const at = input.selectionStart ?? input.value.length;
    const m = input.value.slice(0, at).match(/(^|\s)@([\w-]*)$/);
    return m ? { from: at - m[2].length - 1, word: m[2].toLowerCase() } : null;
  }
  async function offer() {
    const t = typing();
    if (!t) { offerEl.hidden = true; return; }
    const all = await known();
    const now = typing();
    if (!now) { offerEl.hidden = true; return; }
    const hits = all.filter((x) => x.id.includes(now.word) || x.name.toLowerCase().includes(now.word)).slice(0, 8);
    clear(offerEl, hits.map((x) => h<'button'>('button', { onclick: () => pick(x) }, h('i', {}, x.kind), ' ', x.name)),
      !hits.length && h('span.none', {}, 'No concept or drawing by that name.'));
    offerEl.hidden = false;
  }
  function pick(x: Thing) {
    const t = typing();
    const at = input.selectionStart ?? input.value.length;
    const from = t ? t.from : at;
    input.value = `${input.value.slice(0, from)}@${x.id} ${input.value.slice(at)}`;
    const caret = from + x.id.length + 2;
    input.setSelectionRange(caret, caret);
    if (!app.refs.includes(x.ref)) app.refs.push(x.ref);
    paintRefs();
    offerEl.hidden = true;
    input.focus();
    grow();
  }
  let body: HTMLElement | undefined;

  const nearBottom = () => !body || body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const toBottom = () => { if (body) body.scrollTop = body.scrollHeight; };

  async function send() {
    // A photo can go without words.
    const text = input.value.trim() || (shared.length ? (shared.length === 1 ? 'Have a look at this.' : 'Have a look at these.') : '');
    if (!text) return;
    // (A picture of something pointed at that is still on its way to the core is waited for.)
    if (app.picturing) await app.pictured;
    input.value = '';
    grow();
    // What was written as @name by hand counts as pointed at, too.
    for (const m of text.matchAll(/(?:^|\s)@([\w-]+)/g)) {
      const x = (await known()).find((k) => k.id === m[1]);
      if (x && !app.refs.includes(x.ref)) app.refs.push(x.ref);
    }
    // What was pointed at goes with its picture, like a photo the person shared.
    const refs = app.refs.splice(0), files = shared;
    const pictures = new Map(app.pictures);
    app.pictures.clear();
    const sent = [...files, ...refs.map((r) => pictures.get(r)).filter((p) => p !== undefined)];
    shared = [];
    paintRefs(); paintShared();
    offerEl.hidden = true;
    const ok = await app.act('chat.send', { text, ...(refs.length && { refs }), ...(sent.length && { files: sent }) });
    if (ok === undefined) { input.value = text; app.refs.push(...refs); for (const [r, p] of pictures) app.pictures.set(r, p); shared = files; paintRefs(); paintShared(); }
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }
  input.addEventListener('input', () => { grow(); void offer(); });
  // A photo pasted or dropped into the message is shared like one picked with the paperclip.
  input.addEventListener('paste', (ev) => { const files = [...(ev.clipboardData?.files ?? [])]; if (files.length) { ev.preventDefault(); void share(files); } });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void send(); } });

  function paintRefs() {
    clear(refsEl, app.refs.map((r) => refChip(app, r, () => { app.refs.splice(app.refs.indexOf(r), 1); app.pictures.delete(r); paintRefs(); })));
    refsEl.hidden = !app.refs.length;
  }

  /** How full the conversation is: its context in tokens against where it starts over. */
  function paintUsage() {
    const a = app.agent;
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    if (!a.limit) return clear(usage);
    if (!a.context) return clear(usage, h('span', {}, 'New conversation: nothing in context yet'));
    clear(usage, h('span', {}, `${k(a.context)} / ${k(a.limit)} tokens`), h('span.bar', {}, h('i', { style: `width:${Math.min(100, (a.context / a.limit) * 100).toFixed(1)}%` })));
  }

  function paintStatus() {
    paintUsage();
    const a = app.agent;
    status.hidden = !a.busy && !a.off;
    if (a.off) return clear(status, h('span', {}, 'The agent is switched off on this server.'));
    if (!a.busy) return;
    clear(status,
      h('i.spin'),
      h('div.doing', {}, h('b', {}, a.doing || 'working'), a.waiting ? ` · ${a.waiting} waiting` : '', a.text && h('p', {}, a.text.slice(-220))),
      h<'button'>('button', { onclick: () => void app.act('agent.stop') }, 'Stop'));
    if (nearBottom()) toBottom();
  }
  /** The agent's state changed, or it said it is still at it: how long the last thing has been running is said anew. */
  function paintAgent() {
    paintStatus();
    if (acts && list.lastElementChild === acts.el) paintActs(acts);
  }

  // ---------------------------------------------------------------- cards

  function fieldLines(c: Change): HTMLElement[] {
    return Object.keys(c.after ?? {}).map((k) => h('div.field', {},
      h('span.k', {}, k),
      c.before && k in c.before ? [h('span.was', {}, short(c.before[k], 40)), h('span.arrow', {}, '→')] : h('span.was.new', {}, 'new'),
      h('span.now', {}, short(c.after![k], k === 'text' ? 200 : 40))));
  }

  /** The agent's questions, each with a field for the answer; once answered, with what was said. */
  function questionFields(to: string, questions: string[]): HTMLElement {
    const done = answered.get(to);
    if (done) return h('div.questions.done', {}, questions.map((q, n) => h('div.q', {}, h('p.qtext', {}, q), h('p.qanswer', {}, done[n] || '(not answered)'))));
    const draft = drafts.get(to) ?? questions.map(() => '');
    drafts.set(to, draft);
    const send = async () => {
      if (!draft.some((d) => d.trim())) return app.toast('Answer at least one.');
      await app.act('chat.answer', { to, answers: draft });
    };
    return h('div.questions', {},
      questions.map((q, n) => {
        const area = h<'textarea'>('textarea', { rows: 2, placeholder: 'Your answer', 'aria-label': `Answer: ${q}`, oninput: () => { draft[n] = area.value; } });
        area.value = draft[n] ?? '';
        return h('div.q', {}, h('p.qtext', {}, q), area);
      }),
      h('div.t-row', {}, h<'button'>('button.primary', { onclick: () => void send() }, questions.length === 1 ? 'Send answer' : 'Send answers')));
  }

  /** Questions that came on their own: a card of their own in the conversation. */
  function askCard(id: string): HTMLElement {
    const a = asks.get(id)!;
    clear(a.el,
      h('div.t-head', {}, h('b', {}, a.questions.length === 1 ? 'A question for you' : 'Questions for you'), answered.has(id) && h('span.state', {}, 'answered')),
      a.about && h('div.refs', {}, refChip(app, a.about)),
      questionFields(id, a.questions));
    return a.el;
  }

  /** Text as it was written, in full: its paragraphs, and what is marked in it. */
  const whole = (text: unknown, cls: string) => h(`div.${cls}`, {}, prose(String(text ?? '').trim()));
  const LINKS: Record<string, string> = { 'part-of': 'part of', 'leads-to': 'leads to', 'clashes-with': 'clashes with' };

  /**
   * A concept as it would be, to read: what it says in full, where it stands, what it belongs with and what makes
   * it real. For a change to one that exists, what it says now is kept one tap away.
   */
  function conceptLines(c: Change): HTMLElement[] {
    const a = c.after ?? {}, b = c.before;
    const links = Array.isArray(a.links) ? a.links as { to: string; kind: string }[] : [];
    const real = Array.isArray(a.realised) ? (a.realised as unknown[]).map(String) : [];
    return [
      b && 'name' in a && h('div.cline', {}, h('span.k', {}, 'renamed'), h('span.was', {}, String(b.name ?? '')), h('span.arrow', {}, '→'), h('b', {}, String(a.name))),
      b && 'stage' in a && h('div.cline', {}, h('span.k', {}, 'stage'), h('span.t-chip.stage', { data: { stage: String(b.stage) } }, String(b.stage)), h('span.arrow', {}, '→'), h('span.t-chip.stage', { data: { stage: String(a.stage) } }, String(a.stage))),
      'text' in a && (String(a.text ?? '').trim() ? whole(a.text, 'ctext') : h('div.note', {}, b ? 'Its description would be taken away.' : 'No description yet.')),
      b && 'text' in a && String(b.text ?? '').trim() && h('details.cwas', {}, h('summary', {}, 'What it says now'), whole(b.text, 'ctext.old')),
      'links' in a && (links.length > 0 || b) && h('div.cline', {}, h('span.k', {}, 'belongs with'),
        links.length ? links.map((l) => h('span.t-chip.link', { onclick: () => app.open('concepts', l.to) }, `${LINKS[l.kind] ?? l.kind} ${l.to.replaceAll('-', ' ')}`)) : h('span.was.new', {}, 'nothing any more')),
      'realised' in a && (real.length > 0 || b) && h('div.cline.real', {}, h('span.k', {}, 'made real by'),
        real.length ? h('ul', {}, real.map((r) => h('li', {}, r))) : h('span.was.new', {}, 'nothing any more')),
    ].filter(Boolean) as HTMLElement[];
  }

  /** How tandem runs the project: each field in full, and the script that starts its page as it is written. */
  function setupLines(c: Change): HTMLElement[] {
    const say = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
    return Object.keys(c.after ?? {}).flatMap((k) => k === 'script'
      ? [h('div.field', {}, h('span.k', {}, 'page.sh'), !(c.before && k in c.before) && h('span.was.new', {}, 'new')),
        h('pre.diff', {}, String(c.after![k]).replace(/\n$/, '').split('\n').map((l) => h('span', { data: { how: 'same' } }, l || ' ')))]
      : [h('div.field.whole', {},
        h('span.k', {}, k),
        c.before && k in c.before ? h('span.was', {}, say(c.before[k])) : h('span.was.new', {}, 'new'),
        h('span.now', {}, say(c.after![k]) || '(taken away)'))]);
  }

  /** What changed in a file, line by line: what came in green, what went in red. */
  function diffLines(diff: string): HTMLElement {
    const lines = diff.split('\n');
    // (What git says about the file itself is left out: the lines are what is read.)
    const from = lines.findIndex((l) => l.startsWith('@@'));
    const body = (from < 0 ? [] : lines.slice(from)).filter((l) => !l.startsWith('\\'));
    while (body.length && !body.at(-1)) body.pop();
    if (!body.length) return h('div.note', {}, 'Nothing to read in it: it is not text, or it only moved.');
    return h('pre.diff', {}, body.map((l) => h('span', { data: { how: l.startsWith('@@') ? 'at' : l.startsWith('+') ? 'in' : l.startsWith('-') ? 'out' : 'same' } },
      l.startsWith('@@') ? '⋯' : `${l || ' '}`)));
  }

  /** The files of a code change, and how much of each. One that is tapped opens: what changed in it. */
  function codeFiles(c: Change, r: Round): HTMLElement[] {
    const files = c.files ?? [];
    const can = r.status === 'pending';
    const toggle = async (path: string) => {
      r.read ??= new Map();
      if (r.read.has(path)) r.read.delete(path);
      else {
        const got = await app.act<{ diff: string }>('code.changes', { path });
        if (!got) return;
        r.read.set(path, got.diff);
      }
      roundCard(r);
    };
    return [
      ...files.slice(0, 14).flatMap((f) => [
        h(`div.field${can ? '.file' : ''}`, can ? { onclick: () => void toggle(f.path), role: 'button', 'aria-expanded': String(!!r.read?.has(f.path)) } : {},
          h('span.k', {}, f.path), f.status !== 'changed' && h('span.was.new', {}, f.status),
          h('span.pct', { data: { dir: 'up' } }, `+${f.added}`), f.removed > 0 && h('span.pct.minus', { data: { dir: 'down' } }, `−${f.removed}`)),
        ...(can && r.read?.has(f.path) ? [diffLines(r.read.get(f.path)!)] : []),
      ]),
      ...(files.length > 14 ? [h('div.note', {}, `and ${files.length - 14} more files`)] : []),
      ...(can && files.length ? [h('div.t-hint.tapfile', {}, 'Tap a file to see what changed in it.')] : []),
    ];
  }

  /** A drawing is shown, not spelled out: as it was and as it would be. */
  function pictures(c: Change): HTMLElement {
    const pic = (url: string | undefined, label: string) => url && h('figure', { onclick: () => app.zoom(url) }, h<'img'>('img', { src: url, alt: `${c.path}, ${label}`, loading: 'lazy' }), h('figcaption', {}, label));
    if (c.pictures?.looks?.length)
      return h('div', {},
        !c.pictures.looks.some((l) => l.before) && c.pictures.before && h('div.pictures', {}, pic(c.pictures.before, 'as it is')),
        c.pictures.looks.map((l) => h('div.pictures', {}, pic(l.before, `${l.look}, as it is`), pic(l.after, l.before ? `${l.look}, as proposed` : `${l.look}, new`))));
    return h('div.pictures', {}, pic(c.pictures?.before, 'as it is'), pic(c.pictures?.after, c.phase === 'silhouette' ? 'the silhouette' : c.isNew ? 'new' : 'as proposed'), !c.pictures?.after && h('div.note', {}, 'No picture could be made of it.'));
  }

  /** A proposed concept is opened to be changed, or a new one is started in the round: with the fields a concept has. */
  async function startEdit(r: Round, c?: Change) {
    const [now, there] = await Promise.all([
      c?.before ? app.act<Record<string, unknown>>('concepts.get', { id: c.path }) : undefined,
      app.act<{ id: string; name: string }[]>('concepts.list'),
    ]);
    if (c?.before && !now) return;
    // A change to a concept that is there names only what it changes: the rest is the concept as it is.
    const base: ConceptDraft = { name: '', stage: 'idea', text: '', links: [], realised: [], ...fieldsOf(now), ...fieldsOf(c?.after) };
    // It can be linked to what is in the document, and to what else is new in this round.
    const coming = r.changes.filter((x) => x.kind === 'concept' && !x.before && x.status !== 'rejected').map((x) => ({ id: x.path, name: String(x.after?.name ?? x.path) }));
    const others = [...(there ?? []).map((x) => ({ id: x.id, name: x.name })), ...coming].filter((x, n, all) => x.id !== c?.path && all.findIndex((y) => y.id === x.id) === n);
    editing.set(c ? c.id : `new:${r.round}`, { draft: copy(base), base, others });
    roundCard(r);
  }

  /** What was typed on a card goes into the proposal. False when it could not: it stays open, as it was typed. */
  async function keep(r: Round, key: string): Promise<boolean> {
    const e = editing.get(key);
    if (!e) return true;
    if (key.startsWith('new:')) {
      if (!e.draft.name.trim()) { app.toast('Name it first.'); return false; }
      if ((await app.act('proposals.add', { round: r.round, ...e.draft })) === undefined) return false;
    } else {
      const input: Record<string, unknown> = {};
      for (const k of FIELDS) if (JSON.stringify(e.draft[k]) !== JSON.stringify(e.base[k])) input[k] = e.draft[k];
      if (Object.keys(input).length && (await app.act('proposals.edit', { id: key, ...input })) === undefined) return false;
    }
    editing.delete(key);
    roundCard(r);
    return true;
  }

  /** A round is decided, or one piece of it. What is still being typed in what is accepted is kept first: it is part of it. */
  async function decide(r: Round, accept: boolean, only?: Change) {
    const mine = [...editing.keys()].filter((key) => (key === `new:${r.round}` ? !only : r.changes.some((c) => c.id === key && (!only || only === c))));
    for (const key of mine) {
      const e = editing.get(key)!;
      // (A concept that was started and left empty is nothing to add.)
      if (!accept || (key.startsWith('new:') && !e.draft.name.trim() && !e.draft.text.trim())) editing.delete(key);
      else if (!(await keep(r, key))) return;
    }
    await app.act('proposals.decide', { round: r.round, accept, ...(only && { only: [only.id] }) });
  }

  /** The fields of a concept on its card, to type in: kept in the proposal with Save, as it was with Cancel. */
  function conceptEditor(r: Round, key: string): HTMLElement {
    const e = editing.get(key)!;
    if (e.el) return e.el;
    const form = conceptForm(e.draft, { others: e.others, touch: () => {} });
    requestAnimationFrame(form.fit);
    e.el = h('div.cedit', {}, form.fields,
      h('div.t-row', {},
        h<'button'>('button', { onclick: () => { editing.delete(key); roundCard(r); } }, 'Cancel'),
        h<'button'>('button.primary', { onclick: () => void keep(r, key) }, key.startsWith('new:') ? 'Add to the proposal' : 'Save')));
    return e.el;
  }

  function roundCard(r: Round): HTMLElement {
    const el = r.el ?? h('div.card.prop');
    r.el = el;
    el.dataset.status = r.status;
    const touched = new Map<string, { name: string; stage: string }>();
    for (const c of r.changes) for (const t of c.touches ?? []) touched.set(t.id, t);
    const coded = r.changes.some((c) => c.kind === 'code');
    const total = r.changes.length;
    const left = r.changes.filter((c) => !c.status).length;
    const count = (st: string) => r.changes.filter((c) => c.status === st).length;
    const state = r.status === 'decided' ? `${count('accepted')} accepted · ${count('rejected')} rejected`
      : r.status === 'pending' && left < total ? `${left} of ${total} waiting` : r.status;
    // A round of several is decided as one or piece by piece: each piece has its own yes and no.
    const each = total > 1 && r.status === 'pending';
    // A concept that still waits is the person's to change first, and they can add one of their own to the round.
    const open = (c: Change) => r.status === 'pending' && !c.status && c.kind === 'concept';
    const adding = `new:${r.round}`;
    // (What is being typed in stays the same field when the card is drawn again, and stays typed in.)
    const typing = el.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    clear(el,
      h('div.t-head', {}, h('b', {}, coded ? 'A change to the project' : total === 1 ? 'A proposal' : `A proposal, ${total} changes`), h('span.state', {}, state)),
      r.changes.map((c) => h('div.change', { data: { status: c.status ?? 'pending' } },
        h('div.pathline', {},
          c.kind === 'concept'
            // A concept goes by its name, with where it stands; one that is not there yet has nothing to open.
            ? h('div.path.concept', { data: { id: c.path }, onclick: () => c.before && app.open('concepts', c.path) },
              h('b', {}, String(c.after?.name ?? c.touches?.[0]?.name ?? c.path)),
              !c.before && c.after?.stage ? h('span.t-chip.stage', { data: { stage: String(c.after.stage) } }, String(c.after.stage)) : null,
              !c.before && h('span.was.new', {}, c.by === 'me' ? 'added by you' : 'new'))
            : h('div.path', { onclick: () => c.kind === 'drawing' && app.open('art', c.path) }, h('i', {}, c.kind), ' ', c.path),
          total > 1 && c.status && h('span.state', {}, c.status),
          (open(c) || (each && !c.status)) && h('span.each', {},
            open(c) && !editing.has(c.id) && h<'button'>('button.edit', { 'aria-label': `Edit ${c.path}`, onclick: () => void startEdit(r, c) }, icon('edit')),
            each && !c.status && h<'button'>('button.yes', { 'aria-label': `Accept ${c.path}`, onclick: () => void decide(r, true, c) }, icon('yes')),
            each && !c.status && h<'button'>('button.no', { 'aria-label': `Reject ${c.path}`, onclick: () => void decide(r, false, c) }, icon('close')))),
        c.kind === 'drawing' ? pictures(c) : c.kind === 'code' ? codeFiles(c, r) : c.kind === 'setup' ? setupLines(c)
          : c.kind !== 'concept' ? fieldLines(c) : open(c) && editing.has(c.id) ? conceptEditor(r, c.id) : conceptLines(c),
        c.kind === 'concept' && c.edited?.length && h('div.note.yours', {}, `You changed its ${c.edited.join(', ')}.`),
        c.thought && h('div.note.from', {}, 'From your thought: ', h('i', {}, c.thought.length > 160 ? `${c.thought.slice(0, 159)}…` : c.thought)),
        c.note && c.note !== 'a new concept' && h('div.note', {}, c.note),
        // What the agent needs to hear about this piece is asked with it, while it is still to be decided or was taken.
        c.questions?.length && c.status !== 'rejected' ? questionFields(c.id, c.questions) : null)),
      r.status === 'pending' && editing.has(adding) && h('div.change.adding', {},
        h('div.pathline', {}, h('div.path.concept', {}, h('b', {}, 'A concept of your own'))),
        conceptEditor(r, adding)),
      touched.size > 0 && h('div.touches', {}, 'touches ', [...touched].map(([id, t]) => h('span.t-chip.stage', { data: { stage: t.stage }, onclick: () => app.open('concepts', id) }, `${t.name} · ${t.stage}`))),
      r.status === 'pending' && h('div.t-row', {},
        // With the way to the change, playing the copy goes there and marks it.
        coded && app.info.page && h<'button'>('button', { onclick: () => void app.playCopy(r.changes.find((c) => c.kind === 'code')?.show) }, r.changes.some((c) => c.show) ? 'Show me in the copy' : 'Play the copy'),
        r.changes.some((c) => c.kind === 'concept') && !editing.has(adding) && h<'button'>('button', { onclick: () => void startEdit(r) }, 'Add a concept'),
        h<'button'>('button.primary', { onclick: () => void decide(r, true) }, total === 1 ? 'Accept' : left < total ? 'Accept the rest' : 'Accept all'),
        h<'button'>('button.danger', { onclick: () => void decide(r, false) }, total === 1 ? 'Reject' : left < total ? 'Reject the rest' : 'Reject all')));
    if (typing?.isConnected) typing.focus();
    queueMicrotask(paintPins);
    return el;
  }

  function playtestCard(ev: Event): HTMLElement {
    if (ev.kind === 'compare') {
      const len = ev.length as { before?: number; after?: number };
      const moved = ev.moved as { milestone: string; before?: number; after?: number; change?: number }[];
      return h('div.card.test', {},
        h('div.t-head', {}, h('b', {}, 'Played twice: the game, and the working copy'), h('span.state', {}, `${ev.profile} player`)),
        h('div.field', {}, h('span.k', {}, 'whole game'), h('span.was', {}, mins(len.before)), h('span.arrow', {}, '→'), h('span.now', {}, mins(len.after))),
        moved.length ? moved.slice(0, 12).map((m) => h('div.field', {}, h('span.k', {}, m.milestone), h('span.was', {}, mins(m.before)), h('span.arrow', {}, '→'), h('span.now', {}, mins(m.after)),
          m.change !== undefined && h('span.pct', { data: { dir: m.change < 0 ? 'down' : 'up' } }, `${m.change > 0 ? '+' : ''}${Math.round(m.change)}%`)))
          : h('div.note', {}, 'Nothing moved by more than a few percent.'),
        moved.length > 12 && h('div.note', {}, `and ${moved.length - 12} more`));
    }
    return h('div.card.test', {},
      h('div.t-head', {}, h('b', {}, 'Playtest'), h('span.state', {}, `${ev.profile} player${ev.copy ? ', the working copy' : ''}`)),
      h('div.field', {}, h('span.k', {}, 'whole game'), h('span.now', {}, mins(ev.length as number | undefined))));
  }

  /** In a project tandem has not been in before: the offer to read it, or where to begin. */
  let asked = false;
  const welcomes: HTMLElement[] = [];
  function welcomeCard(ev: Event): HTMLElement {
    const el = h('div.msg.agent.welcome', {},
      ev.existing
        ? prose(`**${ev.name}** is new to tandem. Shall I read the project and write down what it is made of (its concepts) and how it is run? I propose; you accept what is right. Or just start talking.`)
        : prose(`**${ev.name}** is a fresh project. Tell me what you want to make, and we start by writing the idea down as a concept.`),
      !!ev.existing && !asked && h('div.t-row', {}, h<'button'>('button.primary', { onclick: () => void app.act('project.init') }, 'Yes, read the project')));
    welcomes.push(el);
    return el;
  }

  function card(ev: Event): HTMLElement | null {
    switch (ev.type) {
      case 'welcome':
        return welcomeCard(ev);
      case 'message':
        // What the engine tells the agent (art was accepted: bring it into the game) is shown, small: it is why the agent starts working.
        // Once the agent has been asked to read the project, the offer to do so is no longer one.
        if (ev.by === 'engine' && ev.kind === 'init') { asked = true; for (const w of welcomes) w.querySelector('.t-row')?.remove(); }
        if (ev.by === 'engine' && ev.kind === 'resume') return h('div.sys.engine', {}, icon('engine'), ' Tandem was started again while the agent was at work: it carries on where it was.');
        // (That a worker's round ended is said by the line of the round itself, right above.)
        if (ev.by === 'engine' && ev.kind === 'art') return null;
        if (ev.by === 'engine' && ev.kind === 'accepted') return h('div.sys.engine', {}, icon('engine'), ` The agent was told what you accepted${ev.changed ? ', and what you made different in it' : ''}.`);
        if (ev.by === 'engine') return h('div.sys.engine', {}, icon('engine'), ev.kind === 'init' ? ' The agent was asked to read this project and set tandem up for it: its concepts, and how it is run.' : ` to the agent: ${String(ev.text ?? '')}`);
        return h(`div.msg.${ev.by === 'me' ? 'me' : 'agent'}${ev.error ? '.error' : ''}`, {},
          Array.isArray(ev.refs) && h('div.refs', {}, (ev.refs as string[]).map((r) => refChip(app, r))),
          Array.isArray(ev.files) && h('div.shared', {}, (ev.files as Shared[]).map((f) => fileChip(f))),
          prose(String(ev.text ?? '')),
          h('time', {}, ago(ev.ts)));
      case 'look':
        return h('figure.card.look', { onclick: () => app.zoom(String(ev.url)) },
          h<'img'>('img', { src: String(ev.url), alt: String(ev.caption ?? 'a look at the game'), loading: 'lazy' }),
          h('figcaption', {}, String(ev.caption ?? ''), ev.by !== 'me' && h('i', {}, ' · the agent looked')));
      case 'playtest':
        return playtestCard(ev);
      case 'stage.point':
        return h('div.sys.tap', { onclick: () => { app.reveal(); app.point(Number(ev.x), Number(ev.y), String(ev.text ?? ''), typeof ev.at === 'string' ? ev.at : undefined); } },
          icon('page'), typeof ev.at === 'string' ? ` pointed at "${ev.at}" on the page` : ' pointed at the game', ev.text ? `: ${ev.text}` : '');
      case 'stage.open':
        return h('div.sys.tap', { onclick: () => app.open(String(ev.tab), ev.id ? String(ev.id) : undefined) }, icon('open'), ` opened ${ev.tab}${ev.id ? ` · ${ev.id}` : ''}`);
      // Drawing work lives in the Art tab; here it is one line that leads there.
      case 'art.asked':
        return h('div.sys.tap', { onclick: () => app.open('art', `worker:${ev.worker}`) }, icon('art'), ` ${ev.by === 'me' ? 'you' : 'the agent'} asked a worker ${ev.isNew ? 'for a new drawing,' : 'to change'} ${ev.name}: ${String(ev.message).slice(0, 140)}`);
      case 'art.round':
        return h(`div.sys.tap${ev.state === 'failed' ? '.fail' : ''}`, { onclick: () => app.open('art', `worker:${ev.worker}`) },
          icon('art'), ev.state === 'failed' ? ` the worker on ${ev.name} failed` : ev.state === 'stopped' ? ` the worker on ${ev.name} was stopped` : ` ${ev.name}: ${ev.phase === 'silhouette' ? 'the silhouette is ready' : 'the drawing is ready'}; the agent looks at it`);
      case 'page.take':
        return h('div.sys', {}, icon('page'), ` the agent asked to use the page: ${String(ev.why ?? '')}`);
      case 'page.taken':
        return h('div.sys', {}, icon('page'), ev.allow ? ' you let the agent use the page' : ev.by === 'me' ? ' you said not now' : ' the agent\'s asking for the page went unanswered');
      case 'page.released':
        return h('div.sys', {}, icon('page'), ev.by === 'me' ? ' you took the page back' : ` the page is yours again${ev.why ? `: ${ev.why}` : ''}`);
      case 'setup.changed':
        return h('div.sys', {}, icon('yes'), ` how tandem runs the project was changed (${(ev.fields as string[]).join(', ')})${ev.restarting ? '. Its page starts again with it' : ''}`);
      case 'remote.changed':
        return h('div.sys', {}, icon('yes'), ev.url ? ` the project is pushed to ${ev.url} from now on` : ' the project has no remote any more');
      case 'project.pushed':
        return h(`div.sys${ev.ok ? '' : '.fail'}`, {}, icon(ev.ok ? 'yes' : 'close'), ev.ok ? ` pushed to ${ev.remote} (${ev.branch})` : ` what was accepted is committed, but could not be pushed${ev.remote ? ` to ${ev.remote}` : ''}: ${String(ev.says ?? '')}`);
      case 'code.changed':
        return h('div.sys', {}, icon('yes'), ` the working copy is the project now: ${(ev.files as string[]).length} ${(ev.files as string[]).length === 1 ? 'file' : 'files'} changed${ev.installed === true ? ', and what it depends on was installed' : ''}. The core starts again with it${ev.restarting ? ', and the project\'s page too' : ''}${typeof ev.installed === 'string' ? `. What it depends on could not be installed (${ev.installed}): run npm install in the project` : ''}`);
      case 'art.changed':
        return (ev.names as string[]).length ? h('div.sys.tap', { onclick: () => app.open('art', (ev.names as string[])[0]) }, icon('yes'), ` ${(ev.names as string[]).join(', ')}: ${ev.built === false ? 'accepted into the art files; the agent brings it into the game' : 'in the game now'}`) : null;
      case 'lock.changed':
        return h('div.sys', {}, icon(ev.locked ? 'lock' : 'unlock'), ` ${ev.locked ? 'locked' : 'unlocked'}: ${ev.ref}`);
      case 'concept.changed':
        return h('div.sys.tap', { onclick: () => ev.what !== 'removed' && app.open('concepts', String(ev.id)) }, icon('edit'), ` concept ${ev.id} ${ev.what}`);
      default:
        return null;
    }
  }

  /**
   * What the agent did, one thing after another (what it read, searched for, ran, tapped on the page): one line
   * when it is one thing, a group when there are more. The last group stands open, with what the last thing in it
   * answered under it (what a command printed), or how long it has been at it; an earlier line shows its answer
   * when tapped. Groups before the last are folded to one line.
   */
  interface Act { did: string; id?: string; ts: number; out?: string; error?: boolean; change?: boolean; picture?: string; shown?: boolean; added?: number; removed?: number }
  interface Acts { el: HTMLElement; did: Act[]; open: boolean }
  let acts: Acts | undefined;
  const calls = new Map<string, { group: Acts; act: Act }>();
  const took = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
  /** What kind of thing it was, by its first word: it is read at a glance by that word and its colour. */
  const KIND: Record<string, string> = { read: 'read', looked: 'read', searched: 'read', changed: 'edit', wrote: 'edit', ran: 'run', used: 'run', tapped: 'page', filled: 'page', went: 'page', sent: 'page' };
  function parts(did: string): { verb: string; rest: string; kind: string } {
    const m = /^(\S+)(?:\s+(at|for|to|in)(?=\s))?\s*(.*)$/s.exec(did) ?? [did, did, undefined, ''];
    return { verb: m[2] ? `${m[1]} ${m[2]}` : String(m[1]), rest: String(m[3] ?? ''), kind: KIND[String(m[1])] ?? 'other' };
  }
  /** What it was done to: a command as one, a file with its name standing out from the folders before it. */
  function target(rest: string, kind: string): HTMLElement {
    const cmd = /^`([\s\S]*)`$/.exec(rest);
    if (cmd) return h('span.what.cmd', { title: cmd[1] }, cmd[1]);
    if ((kind === 'read' || kind === 'edit') && /^[^\s"]+$/.test(rest) && /[/.]/.test(rest)) {
      const at = rest.lastIndexOf('/');
      return h('span.what.path', { title: rest }, at >= 0 && h('i', {}, rest.slice(0, at + 1)), rest.slice(at + 1));
    }
    return h('span.what', { title: rest }, rest);
  }
  const answerOf = (a: Act) => (a.picture
    ? h<'img'>('img.seen', { src: a.picture, alt: 'What the agent looked at', onclick: () => app.zoom(a.picture!) })
    // A change to a file: the lines that went and the lines that came.
    : a.change ? h('pre.out.diff', {}, (a.out ?? '').split('\n').map((l) => h('span', { data: { how: l.startsWith('+') ? 'in' : l.startsWith('-') ? 'out' : 'same' } }, l.startsWith('+') || l.startsWith('-') ? `${l[0]} ${l.slice(1)}` : l)))
    : h(`pre.out${a.error ? '.fail' : ''}`, {}, a.out ?? ''));
  const hasAnswer = (a: Act) => a.out !== undefined || !!a.picture;
  /** The same thing done several times in a row (a file changed in nine places) is one line. */
  function runs(did: Act[]): Act[][] {
    const out: Act[][] = [];
    for (const a of did) { if (out.length && out.at(-1)![0].did === a.did) out.at(-1)!.push(a); else out.push([a]); }
    return out;
  }
  function actRow(g: Acts, run: Act[], last: boolean, inBox: Act | undefined): HTMLElement[] {
    const a = run[0], end = run.at(-1)!;
    const { verb, rest, kind } = parts(a.did);
    // Still at it: asked of a tool, no answer yet, and the agent is at work.
    const running = last && g === acts && end.id !== undefined && end.out === undefined && app.agent.busy;
    const has = run.some(hasAnswer), failed = run.some((x) => x.error);
    const added = run.reduce((n, x) => n + (x.added ?? 0), 0), removed = run.reduce((n, x) => n + (x.removed ?? 0), 0);
    const row = h(`div.act${has ? '.tap' : ''}${failed ? '.fail' : ''}${running ? '.running' : ''}${a.shown ? '.open' : ''}${inBox && run.includes(inBox) ? '.inbox' : ''}`,
      { data: { kind }, onclick: () => { if (!has) return; a.shown = !a.shown; paintActs(g); } },
      h('span.verb', {}, verb), target(rest, kind),
      h('span.meta', {},
        run.length > 1 && h('i.times', {}, `×${run.length}`),
        run.some((x) => x.added !== undefined) && h('span.count', {}, h('b.in', {}, `+${added}`), removed ? h('b.out', {}, `−${removed}`) : null),
        running && h('i.for', {}, took(Date.now() - end.ts)),
        failed && h('i.bad', {}, 'failed'),
        has && h('i.more', {}, icon('more'))));
    return a.shown && has ? [row, ...run.filter(hasAnswer).map(answerOf)] : [row];
  }
  function paintActs(g: Acts) {
    const stick = nearBottom();
    const list_ = runs(g.did);
    // Under the last group, in a place of its own that keeps its size (so the conversation does not jump with every
    // new thing): what the last thing answered, or, until it has, what the one before it did.
    const latest = g === acts && g.did.some((a) => a.id !== undefined);
    const inBox = latest ? [...g.did].reverse().find(hasAnswer) : undefined;
    const rows = list_.flatMap((run, n) => actRow(g, run, n === list_.length - 1, inBox));
    const box = latest ? h(`div.answer${inBox && inBox !== g.did.at(-1) ? '.stale' : ''}`, {}, inBox ? [h('div.of', {}, inBox.did), answerOf(inBox)] : h('div.of', {}, 'nothing back yet')) : null;
    if (g.did.length === 1) clear(g.el, ...rows, box);
    else {
      // What it was, in a line: how many things, and of which kinds.
      const kinds = new Map<string, number>();
      for (const a of g.did) { const v = parts(a.did).verb; kinds.set(v, (kinds.get(v) ?? 0) + 1); }
      const fold = h<'details'>('details', { open: g.open, ontoggle: () => { g.open = fold.open; } },
        h('summary', {}, icon('more'), h('b', {}, `${g.did.length} things done`), h('span.kinds', {}, [...kinds].map(([v, n]) => `${n} ${v}`).join(' · ')), h('span.last', {}, g.did.at(-1)!.did)),
        ...rows, box);
      clear(g.el, fold);
    }
    g.el.classList.toggle('latest', g === acts);
    // (What a command printed is read from its end.)
    const pre = box?.querySelector('pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
    if (stick) toBottom();
  }
  function addAct(act: Act) {
    if (!acts || list.lastElementChild !== acts.el) {
      // A new group: the one before it is folded, and no longer shows what its last thing answered.
      const before = acts;
      acts = { el: h('div.acts'), did: [], open: true };
      if (before) { before.open = false; paintActs(before); }
      list.append(acts.el);
    }
    acts.did.push(act);
    if (act.id) calls.set(act.id, { group: acts, act });
    paintActs(acts);
  }

  function addEvent(ev: Event) {
    if (ev.type === 'agent.did') return addAct({ did: String(ev.did ?? ''), ts: ev.ts, ...(typeof ev.id === 'string' && { id: ev.id }), ...(typeof ev.picture === 'string' && { picture: ev.picture }), ...(typeof ev.added === 'number' && { added: ev.added, removed: Number(ev.removed) || 0 }) });
    if (ev.type === 'page.did') return addAct({ did: `${ev.did || ev.what}${ev.showing === 'copy' ? ', in the working copy' : ''}`, ts: ev.ts });
    if (ev.type === 'agent.out') {
      const call = calls.get(String(ev.id));
      if (!call) return;
      call.act.out = String(ev.out ?? '');
      call.act.error = !!ev.error;
      call.act.change = !!ev.change;
      if (typeof ev.picture === 'string') call.act.picture ??= ev.picture;
      return paintActs(call.group);
    }
    // What a drawing worker proposes is looked at and decided in the Art tab, where it can be watched.
    if (ev.type === 'art.status' || ev.type === 'art.draft' || (ev.type === 'proposal' && ev.worker)) return;
    if (ev.type === 'proposal') {
      const key = String(ev.round);
      let r = rounds.get(key);
      const stick = nearBottom();
      // The working copy is one round that comes back: once decided, what it proposes next is a new card.
      if (r && r.status !== 'pending') r = undefined;
      if (!r) {
        r = { round: key, by: String(ev.by), changes: [], status: 'pending' };
        rounds.set(key, r);
        list.append(roundCard(r));
      }
      const change = ev as unknown as Change;
      const at = r.changes.findIndex((c) => c.id === change.id);
      if (at >= 0) r.changes[at] = change; else r.changes.push(change);
      roundCard(r);
      if (stick) toBottom();
      return;
    }
    if (ev.type === 'proposal.decided') {
      const r = rounds.get(String(ev.round));
      if (r && r.status === 'pending') {
        // All that was waiting, or only the pieces named.
        const ids = ev.ids as string[] | undefined;
        for (const c of r.changes) if (!c.status && (!ids || ids.includes(c.id))) { c.status = ev.status as Change['status']; editing.delete(c.id); }
        const ways = new Set(r.changes.map((c) => c.status ?? 'pending'));
        r.status = ways.has('pending') ? 'pending' : ways.size === 1 ? [...ways][0] as Round['status'] : 'decided';
        if (r.status !== 'pending') editing.delete(`new:${r.round}`);
        roundCard(r);
      }
      return;
    }
    if (ev.type === 'answered') {
      // What was typed is what was said now: the fields make way for it, wherever the questions stand.
      const to = String(ev.to);
      answered.set(to, (ev.answers as unknown[]).map(String));
      drafts.delete(to);
      if (asks.has(to)) askCard(to);
      for (const r of rounds.values()) if (r.changes.some((c) => c.id === to)) roundCard(r);
      return;
    }
    if (ev.type === 'questions') {
      const id = String(ev.id);
      asks.set(id, { questions: (ev.questions as unknown[]).map(String), about: typeof ev.about === 'string' ? ev.about : undefined, el: h('div.card.ask') });
      const stick = nearBottom();
      list.append(askCard(id));
      if (stick) toBottom();
      return;
    }
    const el = card(ev);
    if (!el) return;
    const stick = nearBottom();
    list.append(el);
    if (stick) toBottom();
  }

  return {
    id: 'chat', title: 'Chat',
    show(b, foot) {
      body = b;
      b.append(pins, list);
      b.onscroll = () => paintPins();
      if (!list.children.length) list.append(EMPTY());
      foot.append(status, usage, offerEl, sharedEl, refsEl, picker, h('div.composer', {}, newBtn, clip, input, sendBtn));
      paintShared();
      paintRefs(); paintStatus();
      for (const r of rounds.values()) roundCard(r);
      requestAnimationFrame(toBottom);
    },
    hide() { if (body) body.onscroll = null; body = undefined; },
    refs() { if (body) paintRefs(); },
    event(ev) {
      if (ev.type === 'chat.new') {
        asked = false; welcomes.length = 0; acts = undefined; calls.clear();
        // A new conversation: everything said goes, what is still to be decided stays.
        for (const [key, r] of rounds) if (r.status !== 'pending') rounds.delete(key);
        list.replaceChildren(...[...rounds.values()].map((r) => r.el!).filter(Boolean));
        if (!list.children.length) list.append(EMPTY());
        paintPins();
        return;
      }
      list.querySelector('.empty')?.remove();
      addEvent(ev);
    },
    agent: paintAgent,
    init(a) { app = a; },
  };
}
