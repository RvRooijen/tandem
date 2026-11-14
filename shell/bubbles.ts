// What tandem has to say while the tools are shut: a speech bubble over the
// project's page, by the round button. Something the agent says shows for a
// moment and goes; something that is waiting for the person (a proposal, a
// drawing to approve, the offer to read a new project) stays, with the two
// answers on it, until it is answered. Opening the tools puts the bubbles away:
// everything in them is in the chat.
import type { Event } from '../core/events.ts';
import { clear, h } from './dom.ts';

/** Something that is waiting for an answer. */
interface Waiting {
  title: string;
  text: string;
  /** Where the whole of it is: a tab, and what to open there. */
  open: [tab: string, id?: string];
  yes: { label: string; run(): void };
  no: { label: string; run(): void };
}

export interface BubbleHost {
  act<T>(name: string, input?: Record<string, unknown>): Promise<T | undefined>;
  open(tab: string, id?: string): void;
  info?: { project: string | null };
}

/** Whether the offer to read a project was put off, here on this device. */
function putOff(name: string, now?: boolean): boolean {
  try {
    if (now) localStorage.setItem(`tandem-not-now:${name}`, '1');
    return localStorage.getItem(`tandem-not-now:${name}`) === '1';
  } catch { return false; }
}

const short = (s: string, max = 170) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

export function createBubbles(el: HTMLElement, app: BubbleHost) {
  const waiting = new Map<string, Waiting>();
  const said: { text: string; error: boolean; until: number }[] = [];
  /** The proposals of each open round, to say what the round is about. */
  const rounds = new Map<string, Map<string, Event>>();
  let shut = true, timer = 0;
  /** While the agent is at work its proposals are not shown one by one as they come: the round is shown when it is done. */
  let busy = false;
  const held = new Set<string>();
  /**
   * What the person put out of sight: it still waits in the chat, but not over the page. Kept on this device, per
   * project, until it is decided or something new comes with it.
   */
  const hideKey = `tandem-hidden:${app.info?.project ?? ''}`;
  const hidden = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(hideKey) ?? '[]') as string[]; } catch { return []; } })());
  const keepHidden = () => { try { localStorage.setItem(hideKey, JSON.stringify([...hidden].slice(-60))); } catch { /* not kept, then */ } };
  const hide = (keys: string[]) => { for (const k of keys) hidden.add(k); keepHidden(); paint(); };
  const unhide = (key: string) => { if (hidden.delete(key)) keepHidden(); };
  /** What the bubbles last showed: painted again only when that changed, so a bubble does not pop up anew for nothing. */
  let showing = '';

  function paint() {
    clearTimeout(timer);
    const now = Date.now();
    while (said.length && said[0].until <= now) said.shift();
    const list = [...waiting].filter(([key]) => !hidden.has(key));
    el.hidden = !shut || (!list.length && !said.length);
    if (el.hidden) { showing = ''; return void clear(el); }
    if (said.length) timer = window.setTimeout(paint, Math.max(200, said[0].until - now));
    const now_ = JSON.stringify([list.map(([key, w]) => [key, w.title, w.text, w.yes.label]), said.slice(-2).map((x) => x.text)]);
    if (now_ === showing) return;
    showing = now_;
    clear(el,
      // One thing waiting is said in full, with its two answers. Several are one bubble, a line each: what it is,
      // and its own two answers beside it.
      list.length === 1 && list.map(([key, w]) => h('div.bubble.waits', { data: { key } },
        h<'button'>('button.hide', { 'aria-label': 'Hide', title: 'Hide: it stays in the chat', onclick: () => hide([key]) }, '✕'),
        h('div.say', { onclick: () => app.open(...w.open) }, h('b', {}, w.title), w.text && h('p', {}, w.text)),
        h('div.answers', {},
          h<'button'>('button.primary', { onclick: () => w.yes.run() }, w.yes.label),
          h<'button'>('button', { onclick: () => w.no.run() }, w.no.label)))),
      list.length > 1 && h('div.bubble.waits.many', {},
        h<'button'>('button.hide', { 'aria-label': 'Hide', title: 'Hide: they stay in the chat', onclick: () => hide(list.map(([key]) => key)) }, '✕'),
        h('div.count', { onclick: () => app.open('chat') }, `${list.length} things wait for you`),
        list.map(([key, w]) => h('div.wait', { data: { key } },
          h('div.say', { onclick: () => app.open(...w.open) }, h('b', {}, w.title)),
          h('div.answers', {},
            h<'button'>('button.primary', { onclick: () => w.yes.run() }, w.yes.label),
            h<'button'>('button', { onclick: () => w.no.run() }, w.no.label))))),
      said.slice(-2).map((s) => h(`div.bubble.says${s.error ? '.error' : ''}`, { onclick: () => app.open('chat') }, h('p', {}, s.text))));
  }

  const conceptName = (ev: Event) => String((ev.after as { name?: string } | undefined)?.name ?? (ev.touches as { name: string }[] | undefined)?.[0]?.name ?? ev.path);
  /** What a round of proposals is, in a line, and what the two answers do. */
  function proposal(round: string) {
    const changes = [...(rounds.get(round)?.values() ?? [])];
    if (!changes.length) return void waiting.delete(round);
    // The agent is still at it: what it has proposed so far waits for the rest, and is asked about once.
    if (busy && !waiting.has(round)) return void held.add(round);
    const first = changes[0];
    const title = changes.some((c) => c.kind === 'code')
      ? `A change to the project · ${(first.files as unknown[] | undefined)?.length ?? 0} ${(first.files as unknown[] | undefined)?.length === 1 ? 'file' : 'files'}`
      : changes.length > 1 ? `A proposal · ${changes.length} changes`
        : first.kind === 'setup' ? 'A proposal · how tandem runs the project'
        // A concept goes by its name, as the person knows it.
        : first.kind === 'concept' ? (first.before ? `A change to the concept ${conceptName(first)}` : `A new concept · ${conceptName(first)}`)
          : `A proposal · ${first.kind} ${first.path}${first.before ? '' : ', new'}`;
    waiting.set(round, {
      title, text: short(String(changes.at(-1)!.note ?? '')), open: ['chat'],
      yes: { label: 'Approve', run: () => void app.act('proposals.decide', { round, accept: true }) },
      no: { label: 'Decline', run: () => void app.act('proposals.decide', { round, accept: false }) },
    });
  }

  return {
    /** The agent started or stopped working. Done, what it proposed meanwhile is asked about. */
    agent(now: boolean) {
      if (busy === now) return;
      busy = now;
      if (busy) return;
      for (const round of held) proposal(round);
      held.clear();
      paint();
    },

    /** The tools were opened or shut. */
    shut(now: boolean) {
      shut = now;
      // With the tools open the chat itself is in view: what was said is not said again when they are shut.
      if (!now) said.length = 0;
      paint();
    },

    /** Everything that happens passes here; `live` is false for what is read back from before the page was opened. */
    feed(ev: Event, live: boolean) {
      switch (ev.type) {
        case 'message':
          if (ev.by === 'me') waiting.delete('welcome');
          if (ev.by === 'engine' && ev.kind === 'init') waiting.delete('welcome');
          // What the agent says is shown for a while: longer for more words.
          if (String(ev.by).startsWith('agent') && live && shut) {
            const text = short(String(ev.text ?? ''), 220);
            said.push({ text, error: !!ev.error, until: Date.now() + 6000 + text.length * 45 });
          }
          break;
        case 'welcome':
          // The tools never open by themselves: the offer waits in a bubble. Put off, it stays put off (the page
          // remembers, per project); it is still the first line of the chat.
          if (ev.existing && !putOff(String(ev.name))) waiting.set('welcome', {
            title: `${ev.name} is new to tandem`, text: 'Shall I read the project and write down what it is made of, and how it is run?', open: ['chat'],
            // (Said at once that it starts: the offer goes, and a line says what is happening.)
            yes: { label: 'Yes, read it', run: () => { waiting.delete('welcome'); said.push({ text: 'I am reading the project. What I find comes here as one proposal.', error: false, until: Date.now() + 9000 }); paint(); void app.act('project.init'); } },
            no: { label: 'Not now', run: () => { putOff(String(ev.name), true); waiting.delete('welcome'); paint(); } },
          });
          break;
        case 'proposal': {
          // A drawing worker's round is answered when its round is done (art.round), not as it is being drawn.
          if (ev.worker) break;
          const round = String(ev.round);
          if (!rounds.has(round)) rounds.set(round, new Map());
          // Put out of sight, it comes back when there is something new in it: another piece, or other files.
          const was = rounds.get(round)!.get(String(ev.id));
          if (live && (!was || JSON.stringify(was.files ?? was.after) !== JSON.stringify(ev.files ?? ev.after))) unhide(round);
          rounds.get(round)!.set(String(ev.id), ev);
          proposal(round);
          break;
        }
        case 'questions':
          // The agent needs something said: that waits like a proposal does, and is answered in the chat.
          if (live && shut) said.push({ text: `The agent has ${(ev.questions as unknown[]).length === 1 ? 'a question' : 'questions'} for you: ${short(String((ev.questions as unknown[])[0]), 120)}`, error: false, until: Date.now() + 12000 });
          break;
        case 'proposal.decided': {
          // Decided piece by piece, the round keeps waiting for what is left of it.
          const round = String(ev.round), open = rounds.get(round);
          for (const id of (ev.ids as string[] | undefined) ?? []) open?.delete(id);
          if (open?.size && Number(ev.left) > 0) proposal(round);
          else { rounds.delete(round); waiting.delete(round); unhide(round); }
          break;
        }
        case 'art.round': {
          const id = String(ev.worker);
          if (live) unhide(id);
          if (ev.state !== 'waiting') {
            waiting.delete(id);
            if (live && shut && ev.state === 'failed') said.push({ text: `The worker on ${ev.name} failed.`, error: true, until: Date.now() + 9000 });
            break;
          }
          const sil = ev.phase === 'silhouette';
          waiting.set(id, {
            title: sil ? `${ev.name}: a silhouette to approve` : `${ev.name}: a drawing to accept`, text: short(String(ev.text ?? '')), open: ['art', `worker:${id}`],
            // A silhouette that is approved is not in the project yet: the worker goes on with colour.
            yes: { label: 'Approve', run: () => void (sil ? app.act('art.approve', { worker: id }) : app.act('proposals.decide', { round: id, accept: true })) },
            no: { label: 'Decline', run: () => void app.act('art.close', { worker: id }) },
          });
          break;
        }
        case 'art.status':
          // It is drawing again (feedback, or the silhouette was approved), or it is gone: nothing to answer now.
          if (ev.state === 'running' || ev.state === 'closed') waiting.delete(String(ev.worker));
          break;
        default:
          return;
      }
      paint();
    },
  };
}
