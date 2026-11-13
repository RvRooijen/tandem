// The conversation. Not only words: a proposal is a card with what it changes
// and buttons to play, accept or reject it; a look is a picture; a playtest is
// a small table. All of it is the event log, drawn.
import type { Event } from '../../core/events.ts';
import { run } from '../api.ts';
import type { App, Panel } from '../app.ts';
import { ago, clear, h, mins, prose, short } from '../dom.ts';

interface Change {
  id: string; kind: string; path: string; before?: Record<string, unknown>; after?: Record<string, unknown>; note: string;
  touches?: { id: string; name: string; stage: string }[];
  /** A drawing: what it looks like. */
  /** Code: the files the working copy changes. */
  files?: { path: string; added: number; removed: number; status: string }[];
  phase?: string; isNew?: boolean; pictures?: { before?: string; after?: string; looks?: { look: string; before?: string; after?: string }[] };
  /** Decided on its own or with the rest of its round; not set while it waits. */
  status?: 'accepted' | 'rejected';
}
/** A round is 'decided' when its pieces went different ways: some taken, some refused. */
interface Round {
  round: string; by: string; changes: Change[]; status: 'pending' | 'accepted' | 'rejected' | 'decided'; el?: HTMLElement;
  /** The files of a code change that were tapped open, with what changed in each. */
  read?: Map<string, string>;
}

export function refChip(app: App, ref: string, onRemove?: () => void): HTMLElement {
  const [kind, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  const open = () => {
    if (kind === 'concept') app.open('concepts', rest);
    else if (kind === 'drawing') app.open('art', rest);
    else if (kind === 'point') { const [x, y] = rest.split(',').map(Number); app.point(x, y); }
  };
  return h('span.t-chip.ref', { data: { kind } },
    h('span', { onclick: open }, `${kind} ${rest}`),
    onRemove && h<'button'>('button', { 'aria-label': 'Take off', onclick: onRemove }, '✕'));
}

export function chatPanel(): Panel {
  let app!: App;
  const rounds = new Map<string, Round>();
  const list = h('div.chat');
  const status = h('div.agent-status', { hidden: true });
  const refsEl = h('div.refs');
  const usage = h('div.usage');
  const input = h<'textarea'>('textarea', { rows: 1, placeholder: 'Say something…', 'aria-label': 'Message' });
  const sendBtn = h<'button'>('button.primary', { onclick: () => void send() }, 'Send');
  const newBtn = h<'button'>('button.icon.new-chat', { 'aria-label': 'New conversation', title: 'New conversation', onclick: () => {
    if (confirm('Start a new conversation? The chat is cleared and the agent forgets what was said. Pending proposals stay.')) void app.act('chat.new');
  } }, '↺');
  const EMPTY = () => h('div.empty', {}, h('b', {}, 'Nothing said yet.'), h('p', {}, 'Talk about the project while you use it. Type @ to point at a concept or a drawing, and use the paperclip to share a photo or a file.'));

  // ---------------------------------------------------------------- what goes along with a message

  /** Photos and files that go with the next message: kept by the core when they are picked, sent along by name. */
  interface Shared { name: string; label: string; url: string; image: boolean }
  let shared: Shared[] = [];
  const sharedEl = h('div.shared', { hidden: true });
  const picker = h<'input'>('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Photos or files to share' });
  const clip = h<'button'>('button.icon.clip', { 'aria-label': 'Share a photo or a file', title: 'Share a photo or a file', onclick: () => picker.click() }, '📎');
  const fileChip = (f: Shared, onRemove?: () => void) => h(`span.file${f.image ? '.image' : ''}`, {},
    f.image ? h<'img'>('img', { src: f.url, alt: f.label, loading: 'lazy', onclick: () => app.zoom(f.url) }) : h<'a'>('a', { href: f.url, target: '_blank', rel: 'noopener' }, `📄 ${f.label}`),
    onRemove && h<'button'>('button', { 'aria-label': `Take ${f.label} off`, onclick: onRemove }, '✕'));
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
    input.value = '';
    grow();
    // What was written as @name by hand counts as pointed at, too.
    for (const m of text.matchAll(/(?:^|\s)@([\w-]+)/g)) {
      const x = (await known()).find((k) => k.id === m[1]);
      if (x && !app.refs.includes(x.ref)) app.refs.push(x.ref);
    }
    const refs = app.refs.splice(0), files = shared;
    shared = [];
    paintRefs(); paintShared();
    offerEl.hidden = true;
    const ok = await app.act('chat.send', { text, ...(refs.length && { refs }), ...(files.length && { files }) });
    if (ok === undefined) { input.value = text; app.refs.push(...refs); shared = files; paintRefs(); paintShared(); }
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }
  input.addEventListener('input', () => { grow(); void offer(); });
  // A photo pasted or dropped into the message is shared like one picked with the paperclip.
  input.addEventListener('paste', (ev) => { const files = [...(ev.clipboardData?.files ?? [])]; if (files.length) { ev.preventDefault(); void share(files); } });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) void send(); });

  function paintRefs() {
    clear(refsEl, app.refs.map((r) => refChip(app, r, () => { app.refs.splice(app.refs.indexOf(r), 1); paintRefs(); })));
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

  // ---------------------------------------------------------------- cards

  function fieldLines(c: Change): HTMLElement[] {
    return Object.keys(c.after ?? {}).map((k) => h('div.field', {},
      h('span.k', {}, k),
      c.before && k in c.before ? [h('span.was', {}, short(c.before[k], 40)), h('span.arrow', {}, '→')] : h('span.was.new', {}, 'new'),
      h('span.now', {}, short(c.after![k], k === 'text' ? 200 : 40))));
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
    const decide = (accept: boolean, only?: Change) => void app.act('proposals.decide', { round: r.round, accept, ...(only && { only: [only.id] }) });
    // A round of several is decided as one or piece by piece: each piece has its own yes and no.
    const each = total > 1 && r.status === 'pending';
    clear(el,
      h('div.t-head', {}, h('b', {}, coded ? 'A change to the project' : total === 1 ? 'A proposal' : `A proposal, ${total} changes`), h('span.state', {}, state)),
      r.changes.map((c) => h('div.change', { data: { status: c.status ?? 'pending' } },
        h('div.pathline', {},
          h('div.path', { onclick: () => c.kind !== 'code' && app.open(c.kind === 'concept' ? 'concepts' : 'art', c.path) }, h('i', {}, c.kind), ' ', c.path),
          total > 1 && c.status && h('span.state', {}, c.status),
          each && !c.status && h('span.each', {},
            h<'button'>('button.yes', { 'aria-label': `Accept ${c.path}`, onclick: () => decide(true, c) }, '✓'),
            h<'button'>('button.no', { 'aria-label': `Reject ${c.path}`, onclick: () => decide(false, c) }, '✕'))),
        c.kind === 'drawing' ? pictures(c) : c.kind === 'code' ? codeFiles(c, r) : fieldLines(c),
        c.note && h('div.note', {}, c.note))),
      touched.size > 0 && h('div.touches', {}, 'touches ', [...touched].map(([id, t]) => h('span.t-chip.stage', { data: { stage: t.stage }, onclick: () => app.open('concepts', id) }, `${t.name} · ${t.stage}`))),
      r.status === 'pending' && h('div.t-row', {},
        coded && app.info.page && h<'button'>('button', { onclick: () => void app.playCopy() }, 'Play the copy'),
        h<'button'>('button.primary', { onclick: () => decide(true) }, total === 1 ? 'Accept' : left < total ? 'Accept the rest' : 'Accept all'),
        h<'button'>('button.danger', { onclick: () => decide(false) }, total === 1 ? 'Reject' : left < total ? 'Reject the rest' : 'Reject all')));
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
        if (ev.by === 'engine') return h('div.sys.engine', {}, ev.kind === 'init' ? '⚙ The agent was asked to read this project and set tandem up for it: its concepts, and how it is run.' : `⚙ to the agent: ${String(ev.text ?? '')}`);
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
        return h('div.sys.tap', { onclick: () => { app.close(); app.point(Number(ev.x), Number(ev.y), String(ev.text ?? '')); } }, '◎ pointed at the game', ev.text ? `: ${ev.text}` : '');
      case 'stage.open':
        return h('div.sys.tap', { onclick: () => app.open(String(ev.tab), ev.id ? String(ev.id) : undefined) }, `↗ opened ${ev.tab}${ev.id ? ` · ${ev.id}` : ''}`);
      // Drawing work lives in the Art tab; here it is one line that leads there.
      case 'art.asked':
        return h('div.sys.tap', { onclick: () => app.open('art', `worker:${ev.worker}`) }, `🖌 ${ev.by === 'me' ? 'you' : 'the agent'} asked a worker ${ev.isNew ? 'for a new drawing,' : 'to change'} ${ev.name}: ${String(ev.message).slice(0, 140)}`);
      case 'art.round':
        return h(`div.sys.tap${ev.state === 'failed' ? '.fail' : ''}`, { onclick: () => app.open('art', `worker:${ev.worker}`) },
          ev.state === 'failed' ? `🖌 the worker on ${ev.name} failed` : ev.state === 'stopped' ? `🖌 the worker on ${ev.name} was stopped` : `🖌 ${ev.name}: ${ev.phase === 'silhouette' ? 'a silhouette to approve' : 'a drawing to accept'}. Look in Art`);
      case 'code.changed':
        return h('div.sys', {}, `✓ the working copy is the project now: ${(ev.files as string[]).length} ${(ev.files as string[]).length === 1 ? 'file' : 'files'} changed. The core starts again with it`);
      case 'art.changed':
        return (ev.names as string[]).length ? h('div.sys.tap', { onclick: () => app.open('art', (ev.names as string[])[0]) }, `✓ ${(ev.names as string[]).join(', ')}: ${ev.built === false ? 'accepted into the art files; the agent brings it into the game' : 'in the game now'}`) : null;
      case 'lock.changed':
        return h('div.sys', {}, `${ev.locked ? '🔒 locked' : '🔓 unlocked'}: ${ev.ref}`);
      case 'concept.changed':
        return h('div.sys.tap', { onclick: () => ev.what !== 'removed' && app.open('concepts', String(ev.id)) }, `✎ concept ${ev.id} ${ev.what}`);
      default:
        return null;
    }
  }

  function addEvent(ev: Event) {
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
        for (const c of r.changes) if (!c.status && (!ids || ids.includes(c.id))) c.status = ev.status as Change['status'];
        const ways = new Set(r.changes.map((c) => c.status ?? 'pending'));
        r.status = ways.has('pending') ? 'pending' : ways.size === 1 ? [...ways][0] as Round['status'] : 'decided';
        roundCard(r);
      }
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
      b.append(list);
      if (!list.children.length) list.append(EMPTY());
      foot.append(status, usage, offerEl, sharedEl, refsEl, picker, h('div.composer', {}, newBtn, clip, input, sendBtn));
      paintShared();
      paintRefs(); paintStatus();
      for (const r of rounds.values()) roundCard(r);
      requestAnimationFrame(toBottom);
    },
    hide() { body = undefined; },
    event(ev) {
      if (ev.type === 'chat.new') {
        asked = false; welcomes.length = 0;
        // A new conversation: everything said goes, what is still to be decided stays.
        for (const [key, r] of rounds) if (r.status !== 'pending') rounds.delete(key);
        list.replaceChildren(...[...rounds.values()].map((r) => r.el!).filter(Boolean));
        if (!list.children.length) list.append(EMPTY());
        return;
      }
      list.querySelector('.empty')?.remove();
      addEvent(ev);
    },
    agent: paintStatus,
    init(a) { app = a; },
  };
}
