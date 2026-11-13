// Time, without having to sit through it: a bot plays the whole game and the
// result is a list of when things happened. It says, it does not judge. And a
// look at the game at any minute.
import type { App, Panel } from '../app.ts';
import { clear, h, mins } from '../dom.ts';

interface Run { profile: string; length?: number; minutes: Record<string, number>; took: number }

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

  function paint() {
    if (!body) return;
    if (busy) return clear(out, h('div.working', {}, h('i.spin'), h('span', {}, busy)));
    if (!last) return clear(out, h('div.empty', {}, h('b', {}, 'Nothing played yet.'), h('p', {}, 'A run takes about ten seconds and plays the whole game, start to end.')));
    const { run } = last;
    const rows = Object.entries(run.minutes).sort((a, b) => a[1] - b[1]);
    clear(out,
      h('div.card.test', {},
        h('div.head', {}, h('b', {}, `The ${run.profile} player${last.proposed ? ', as proposed' : ''}`), h('span.state', {}, `played in ${run.took}s`)),
        h('div.field', {}, h('span.k', {}, 'whole game'), h('span.now', {}, mins(run.length)))),
      h('h3', {}, 'Every milestone'),
      rows.map(([id, at]) => h('div.ms', { onclick: () => void lookAt(Math.max(0, Math.round(at) + 1), last!.proposed) },
        h('span.t', {}, mins(at)), h('span.k', {}, id))),
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
      paint();
    },
    hide() { body = undefined; },
  };
}
