// The conversation. Not only words: a proposal is a card with what it changes
// and buttons to play, accept or reject it; a look is a picture; a playtest is
// a small table. All of it is the event log, drawn.
import type { Event } from '../../core/events.ts';
import type { App, Panel } from '../app.ts';
import { ago, clear, h, mins, prose, short } from '../dom.ts';

interface Change { id: string; kind: string; path: string; before?: Record<string, unknown>; after: Record<string, unknown>; note: string; touches?: { id: string; name: string; firmness: string }[] }
interface Round { round: string; by: string; changes: Change[]; status: 'pending' | 'accepted' | 'rejected'; el?: HTMLElement }

export function refChip(app: App, ref: string, onRemove?: () => void): HTMLElement {
  const [kind, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  const open = () => {
    if (kind === 'concept') app.open('concepts', rest);
    else if (kind === 'record') app.open('content', rest);
    else if (kind === 'entity') app.open('inspect', rest);
    else if (kind === 'drawing') app.open('art', rest);
    else if (kind === 'point') { const [x, y] = rest.split(',').map(Number); app.point(x, y); }
  };
  return h('span.chip.ref', { data: { kind } },
    h('span', { onclick: open }, `${kind} ${rest}`),
    onRemove && h<'button'>('button', { 'aria-label': 'Take off', onclick: onRemove }, '✕'));
}

export function chatPanel(): Panel {
  let app!: App;
  const rounds = new Map<string, Round>();
  const list = h('div.chat');
  const status = h('div.agent-status', { hidden: true });
  const refsEl = h('div.refs');
  const input = h<'textarea'>('textarea', { rows: 1, placeholder: 'Say something…', 'aria-label': 'Message' });
  const sendBtn = h<'button'>('button.primary', { onclick: () => void send() }, 'Send');
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

  function paintStatus() {
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
    return Object.keys(c.after).map((k) => h('div.field', {},
      h('span.k', {}, k),
      c.before && k in c.before ? [h('span.was', {}, short(c.before[k], 40)), h('span.arrow', {}, '→')] : h('span.was.new', {}, 'new'),
      h('span.now', {}, short(c.after[k], k === 'text' ? 200 : 40))));
  }

  function roundCard(r: Round): HTMLElement {
    const el = r.el ?? h('div.card.prop');
    r.el = el;
    el.dataset.status = r.status;
    const touched = new Map<string, { name: string; firmness: string }>();
    for (const c of r.changes) for (const t of c.touches ?? []) touched.set(t.id, t);
    const records = r.changes.some((c) => c.kind === 'record');
    clear(el,
      h('div.head', {}, h('b', {}, r.changes.length === 1 ? 'A proposal' : `A proposal, ${r.changes.length} changes`), h('span.state', {}, r.status)),
      r.changes.map((c) => h('div.change', {},
        h('div.path', { onclick: () => app.open(c.kind === 'concept' ? 'concepts' : 'content', c.path) }, h('i', {}, c.kind), ' ', c.path),
        fieldLines(c),
        c.note && h('div.note', {}, c.note))),
      touched.size > 0 && h('div.touches', {}, 'touches ', [...touched].map(([id, t]) => h('span.chip.firm', { data: { firmness: t.firmness }, onclick: () => app.open('concepts', id) }, `${t.name} · ${t.firmness}`))),
      r.status === 'pending' && h('div.row', {},
        records && h<'button'>('button', { onclick: () => void app.play(r.round) }, app.playing === r.round ? 'Playing…' : 'Play it'),
        records && h<'button'>('button', { onclick: (ev: MouseEvent) => void compareRound(r, ev.currentTarget as HTMLButtonElement) }, 'Compare'),
        h<'button'>('button.primary', { onclick: () => void app.act('proposals.decide', { round: r.round, accept: true }) }, 'Accept'),
        h<'button'>('button.danger', { onclick: () => void app.act('proposals.decide', { round: r.round, accept: false }) }, 'Reject')));
    return el;
  }

  async function compareRound(r: Round, btn: HTMLButtonElement) {
    btn.disabled = true;
    btn.textContent = 'Playing twice…';
    await app.act('playtest.compare', { round: r.round });
    btn.disabled = false;
    btn.textContent = 'Compare';
  }

  function playtestCard(ev: Event): HTMLElement {
    if (ev.kind === 'compare') {
      const len = ev.length as { before?: number; after?: number };
      const moved = ev.moved as { milestone: string; before?: number; after?: number; change?: number }[];
      return h('div.card.test', {},
        h('div.head', {}, h('b', {}, 'Played twice'), h('span.state', {}, `${ev.profile} player`)),
        h('div.field', {}, h('span.k', {}, 'whole game'), h('span.was', {}, mins(len.before)), h('span.arrow', {}, '→'), h('span.now', {}, mins(len.after))),
        moved.length ? moved.slice(0, 12).map((m) => h('div.field', {}, h('span.k', {}, m.milestone), h('span.was', {}, mins(m.before)), h('span.arrow', {}, '→'), h('span.now', {}, mins(m.after)),
          m.change !== undefined && h('span.pct', { data: { dir: m.change < 0 ? 'down' : 'up' } }, `${m.change > 0 ? '+' : ''}${Math.round(m.change)}%`)))
          : h('div.note', {}, 'Nothing moved by more than a few percent.'),
        moved.length > 12 && h('div.note', {}, `and ${moved.length - 12} more`));
    }
    return h('div.card.test', {},
      h('div.head', {}, h('b', {}, 'Playtest'), h('span.state', {}, `${ev.profile} player${ev.proposed ? ', as proposed' : ''}`)),
      h('div.field', {}, h('span.k', {}, 'whole game'), h('span.now', {}, mins(ev.length as number | undefined))),
      h<'button'>('button.link', { onclick: () => app.open('playtest') }, 'Every milestone'));
  }

  function card(ev: Event): HTMLElement | null {
    switch (ev.type) {
      case 'message':
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
        return h('div.sys.tap', { onclick: () => { app.close(); app.point(Number(ev.x), Number(ev.y), String(ev.text ?? '')); } }, '◎ pointed at the garden', ev.text ? `: ${ev.text}` : '');
      case 'stage.open':
        return h('div.sys.tap', { onclick: () => app.open(String(ev.tab), ev.id ? String(ev.id) : undefined) }, `↗ opened ${ev.tab}${ev.id ? ` · ${ev.id}` : ''}`);
      case 'record.changed':
        return h('div.sys.tap', { onclick: () => app.open('content', String(ev.path)) }, `✎ ${ev.path} changed: ${Object.entries(ev.after as object).map(([k, v]) => `${k} ${short(v, 24)}`).join(', ')}`);
      case 'art.asked':
        return h('div.sys.tap', { onclick: () => app.open('art') }, `✎ ${ev.by === 'me' ? 'you' : 'the agent'} asked a pixeldraw worker (${ev.worker}) about ${ev.name}: ${String(ev.message).slice(0, 120)}`);
      case 'art.accepted':
        return h('div.sys.tap', { onclick: () => app.open('art') }, `✓ worker ${ev.worker} accepted in pixeldraw`);
      case 'art.imported':
        return h('div.sys', {}, `✓ ${ev.drawings} drawings brought into the game`);
      case 'concept.changed':
        return h('div.sys.tap', { onclick: () => ev.what !== 'removed' && app.open('concepts', String(ev.id)) }, `✎ concept ${ev.id} ${ev.what}`);
      default:
        return null;
    }
  }

  function addEvent(ev: Event) {
    if (ev.type === 'proposal') {
      const key = String(ev.round);
      let r = rounds.get(key);
      const stick = nearBottom();
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
      if (!list.children.length) list.append(h('div.empty', {}, h('b', {}, 'Nothing said yet.'), h('p', {}, 'Talk about the game while you play it. Hang a concept, a record or something in the garden on a message from the other tabs.')));
      foot.append(status, refsEl, h('div.composer', {}, input, sendBtn));
      paintRefs(); paintStatus();
      for (const r of rounds.values()) roundCard(r);
      requestAnimationFrame(toBottom);
    },
    hide() { body = undefined; },
    event(ev) {
      list.querySelector('.empty')?.remove();
      addEvent(ev);
    },
    agent: paintStatus,
    init(a) { app = a; },
  };
}
