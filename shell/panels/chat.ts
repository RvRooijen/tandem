// The conversation. Not only words: a proposal is a card with what it changes
// and buttons to play, accept or reject it; a look is a picture; a playtest is
// a small table. All of it is the event log, drawn.
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { ago, clear, h, mins, prose, short } from '../dom.ts';

interface Change {
  id: string; kind: string; path: string; before?: Record<string, unknown>; after?: Record<string, unknown>; note: string;
  touches?: { id: string; name: string; stage: string }[];
  /** A drawing: what it looks like. */
  /** Code: the files the working copy changes. */
  files?: { path: string; added: number; removed: number; status: string }[];
  phase?: string; isNew?: boolean; pictures?: { before?: string; after?: string; looks?: { look: string; before?: string; after?: string }[] };
}
interface Round { round: string; by: string; changes: Change[]; status: 'pending' | 'accepted' | 'rejected'; el?: HTMLElement }

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
  const EMPTY = () => h('div.empty', {}, h('b', {}, 'Nothing said yet.'), h('p', {}, 'Talk about the game while you play it. Hang a concept or a drawing on a message from the other tabs.'));
  let body: HTMLElement | undefined;

  const nearBottom = () => !body || body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const toBottom = () => { if (body) body.scrollTop = body.scrollHeight; };

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    grow();
    const refs = app.refs.splice(0);
    paintRefs();
    const ok = await app.act('chat.send', { text, ...(refs.length && { refs }) });
    if (ok === undefined) { input.value = text; app.refs.push(...refs); paintRefs(); }
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }
  input.addEventListener('input', grow);
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

  /** Code is not read on a phone: which files, and how much of each. */
  function codeFiles(c: Change): HTMLElement[] {
    const files = c.files ?? [];
    return [
      ...files.slice(0, 14).map((f) => h('div.field', {}, h('span.k', {}, f.path.replace(/^games\/[^/]+\//, '')), f.status !== 'changed' && h('span.was.new', {}, f.status),
        h('span.pct', { data: { dir: 'up' } }, `+${f.added}`), f.removed > 0 && h('span.pct.minus', { data: { dir: 'down' } }, `−${f.removed}`))),
      ...(files.length > 14 ? [h('div.note', {}, `and ${files.length - 14} more files`)] : []),
    ];
  }

  /** The working copy has a page of its own: the game as the agent coded it, started from where the person is. */
  async function playCopy(btn: HTMLButtonElement) {
    btn.disabled = true;
    btn.textContent = 'Starting the copy…';
    const got = await app.act<{ url: string }>('code.play');
    btn.disabled = false;
    btn.textContent = 'Play the copy';
    if (got) window.open(got.url, 'tandem-copy');
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
    clear(el,
      h('div.t-head', {}, h('b', {}, coded ? 'A change to the game\'s code' : r.changes.length === 1 ? 'A proposal' : `A proposal, ${r.changes.length} changes`), h('span.state', {}, r.status)),
      r.changes.map((c) => h('div.change', {},
        h('div.path', { onclick: () => c.kind !== 'code' && app.open(c.kind === 'concept' ? 'concepts' : 'art', c.path) }, h('i', {}, c.kind), ' ', c.path),
        c.kind === 'drawing' ? pictures(c) : c.kind === 'code' ? codeFiles(c) : fieldLines(c),
        c.note && h('div.note', {}, c.note))),
      touched.size > 0 && h('div.touches', {}, 'touches ', [...touched].map(([id, t]) => h('span.t-chip.stage', { data: { stage: t.stage }, onclick: () => app.open('concepts', id) }, `${t.name} · ${t.stage}`))),
      r.status === 'pending' && h('div.t-row', {},
        coded && h<'button'>('button', { onclick: (ev: MouseEvent) => void playCopy(ev.currentTarget as HTMLButtonElement) }, 'Play the copy'),
        h<'button'>('button.primary', { onclick: () => void app.act('proposals.decide', { round: r.round, accept: true }) }, 'Accept'),
        h<'button'>('button.danger', { onclick: () => void app.act('proposals.decide', { round: r.round, accept: false }) }, 'Reject')));
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

  function card(ev: Event): HTMLElement | null {
    switch (ev.type) {
      case 'message':
        // What the engine tells the agent (art was accepted: bring it into the game) is shown, small: it is why the agent starts working.
        if (ev.by === 'engine') return h('div.sys.engine', {}, `⚙ to the agent: ${String(ev.text ?? '')}`);
        return h(`div.msg.${ev.by === 'me' ? 'me' : 'agent'}${ev.error ? '.error' : ''}`, {},
          Array.isArray(ev.refs) && h('div.refs', {}, (ev.refs as string[]).map((r) => refChip(app, r))),
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
        return h('div.sys', {}, `✓ the working copy is the game now: ${(ev.files as string[]).length} ${(ev.files as string[]).length === 1 ? 'file' : 'files'} changed. The core starts again with it`);
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
      if (r) { r.status = ev.status as Round['status']; roundCard(r); }
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
      foot.append(status, usage, refsEl, h('div.composer', {}, newBtn, input, sendBtn));
      paintRefs(); paintStatus();
      for (const r of rounds.values()) roundCard(r);
      requestAnimationFrame(toBottom);
    },
    hide() { body = undefined; },
    event(ev) {
      if (ev.type === 'chat.new') {
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
