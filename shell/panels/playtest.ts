// Time, without having to sit through it: a bot plays the whole game and the
// result is a list of when things happened, held against what the concepts
// promise. And a look at the game at any minute.
import type { Concept } from '../../core/concepts.ts';
import type { App, Panel } from '../app.ts';
import { clear, h, mins } from '../dom.ts';

interface Run { profile: string; length?: number; minutes: Record<string, number>; checks: { total: number; failed: { concept: string; says: string }[] }; took: number }

export function playtestPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  let last: { run: Run; proposed: boolean } | undefined;
  let busy = '';
  const out = h('div.results');

  async function play(profile: string, proposed: boolean) {
    busy = `A ${profile} player is playing the whole game${proposed ? ' as proposed' : ''}…`;
    paint();
    const run = await app.act<Run>('playtest.run', { profile, proposed });
    busy = '';
    if (run) last = { run, proposed };
    paint();
  }

  async function compare() {
    busy = 'Playing it twice: as it is, and as proposed…';
    paint();
    const done = await app.act('playtest.compare');
    busy = '';
    paint();
    if (done) app.open('chat');
  }

  async function lookAt(minutes: number, proposed: boolean) {
    busy = `Playing up to minute ${minutes} to take a picture…`;
    paint();
    const look = await app.act<{ url: string }>('game.lookAt', { minutes, proposed });
    busy = '';
    paint();
    if (look) app.zoom(look.url);
  }

  async function paint() {
    if (!body) return;
    if (busy) return clear(out, h('div.working', {}, h('i.spin'), h('span', {}, busy)));
    if (!last) return clear(out, h('div.empty', {}, h('b', {}, 'Nothing played yet.'), h('p', {}, 'A run takes about ten seconds and plays the whole game, start to end.')));
    const concepts = (await app.act<{ id: string }[]>('concepts.list')) ?? [];
    const full = (await Promise.all(concepts.map((c) => app.act<Concept>('concepts.get', { id: c.id })))).filter(Boolean) as Concept[];
    if (!body || busy) return;
    const { run } = last;
    const windows = new Map<string, { concept: string; min?: number; max?: number }>();
    for (const c of full) for (const k of c.checks) if ((k.profile ?? 'eager') === run.profile) windows.set(k.milestone, { concept: c.name, min: k.min, max: k.max });
    const rows = Object.entries(run.minutes).sort((a, b) => a[1] - b[1]);
    clear(out,
      h('div.card.test', {},
        h('div.head', {}, h('b', {}, `The ${run.profile} player${last.proposed ? ', as proposed' : ''}`), h('span.state', {}, `played in ${run.took}s`)),
        h('div.field', {}, h('span.k', {}, 'whole game'), h('span.now', {}, mins(run.length))),
        run.checks.failed.map((f) => h('div.fail', {}, h('b', {}, f.concept), ': ', f.says)),
        !run.checks.failed.length && h('div.pass', {}, run.checks.total ? `${run.checks.total} promises, all hold.` : 'No concept promises anything yet.')),
      h('h3', {}, 'Every milestone'),
      rows.map(([id, at]) => {
        const w = windows.get(id);
        const ok = !w || ((w.min === undefined || at >= w.min) && (w.max === undefined || at <= w.max));
        return h(`div.ms${w ? (ok ? '.ok' : '.bad') : ''}`, { onclick: () => void lookAt(Math.max(0, Math.round(at) + 1), last!.proposed) },
          h('span.t', {}, mins(at)), h('span.k', {}, id),
          w && h('span.w', { title: w.concept }, `${w.min ?? '…'}–${w.max ?? '…'}`));
      }),
      h('p.hint', {}, 'Touch a milestone to see the game just after it.'));
  }

  return {
    id: 'playtest', title: 'Playtest',
    init(a) { app = a; },
    show(b) {
      body = b;
      const minute = h<'input'>('input.n', { type: 'number', inputMode: 'numeric', value: '30', min: '0', 'aria-label': 'Minute' });
      b.append(
        h('div.row', {},
          app.info.profiles.map((p) => h<'button'>('button', { onclick: () => void play(p, false) }, `Play it: ${p}`))),
        h('div.row', {},
          h<'button'>('button', { onclick: () => void play('eager', true) }, 'Play as proposed'),
          h<'button'>('button', { onclick: () => void compare() }, 'Compare with proposals')),
        h('div.row.look-at', {}, h('span', {}, 'Look at minute'), minute, h<'button'>('button', { onclick: () => void lookAt(Number(minute.value) || 0, false) }, 'Look')),
        out);
      void paint();
    },
    hide() { body = undefined; },
  };
}
