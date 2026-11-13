// Gnome Garden as a module of the engine: its components, its content as
// records, how to make a world, draw it, and let a bot play it.
import type { CommandDef } from '../../core/commands.ts';
import type { GameModule, Picture, World } from '../../core/game.ts';
import { Critter, Flower, Gnome, Move, Pos, Spark, Visitor } from './src/sim/components.ts';
import { ABILITIES, BEATS, FLOWERS, GNOMES, UPGRADES, type RoleId } from './src/sim/content.ts';
import { totalGnomes } from './src/sim/economy.ts';
import { createGame, type Game } from './src/sim/game.ts';
import { applyRecords, exportRecords } from './src/sim/records.ts';
import { newState } from './src/sim/state.ts';
import { WORLD_H, WORLD_W } from './src/sim/world.ts';
import { ZOOM, createScene, type Scene } from './src/render/scene.ts';
import { ALPHABET, ART } from './src/render/art.gen.ts';
import { hex } from './src/render/fb.ts';
import { fmt, fmtTime } from './src/util.ts';
import { PROFILES, playthrough } from './tools/bot.ts';

const scenes = new Map<string, Scene>();
/** A blank state, for reading the diary lines that are written from one. */
const SAMPLE = newState();

function describe(g: Game): string {
  const s = g.s;
  const up = Object.entries(s.up).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  return [
    `Owner ${s.runs + 1}, day ${s.day}, ${fmtTime(s.clock)} played by this owner. It is ${g.dark >= 0.5 ? 'night' : 'day'}${g.asleep ? ' and the player is asleep' : ''}${g.rain > 0.05 ? ', raining' : ''}.`,
    `Peace of mind ${Math.round(s.peace)}%. Blooms ${fmt(s.blooms)} (${fmt(s.rate.blooms)}/s), teeth ${fmt(s.teeth)} (${fmt(s.rate.teeth)}/s), whispers ${fmt(s.whispers)} (${fmt(s.rate.whispers)}/s), hats ${s.hats}.`,
    `Gnomes ${totalGnomes(s)}: ${s.gnomes.gardener} gardeners, ${s.gnomes.digger} diggers, ${s.gnomes.lantern} lantern bearers, ${s.gnomes.choir} in the choir; ${s.guests} guests stayed. They are ${g.frozen ? 'standing still' : 'moving'}.`,
    `Beds ${s.plots}, growing ${FLOWERS[s.seed].name}. The hole is ${s.depth} m deep. Jobs crossed off: ${s.done}.`,
    `Upgrades: ${up}.`,
    `Unlocked: ${Object.keys(s.flags).join(', ') || 'nothing yet'}.`,
    `To do: ${s.todo.map((t) => `${t.kind} ${t.have}/${t.goal}${t.ready ? ' (done, not crossed off)' : ''}`).join('; ') || 'nothing'}.`,
    `Last in the diary: ${s.log.slice(-3).map((l) => `"${l.text}"`).join(' ')}`,
  ].join('\n');
}

/** A game that is already running, as a world of the engine. */
export function adopt(g: Game): World {
  return wrap(g);
}

function wrap(g: Game): World {
  return {
    em: g.em,
    step: (dt) => { g.step(dt); g.events.length = 0; },
    snapshot: () => JSON.parse(g.save()),
    describe: () => describe(g),
    game: g,
    systems: g.systems,
  };
}

const gameOf = (w: World) => w.game as Game;

/** One frame of a drawing as a picture. */
function drawingFrame(name: string, text: string): Picture {
  const s = ART[name];
  const colors = s.pal.map(hex);
  const px = new Uint32Array(s.w * s.h);
  for (let i = 0; i < px.length; i++) {
    const at = i * s.cpp;
    if (text[at] === '.') continue;
    px[i] = colors[s.cpp === 1 ? ALPHABET.indexOf(text[at]) : ALPHABET.indexOf(text[at]) * ALPHABET.length + ALPHABET.indexOf(text[at + 1])];
  }
  return { w: s.w, h: s.h, px };
}

export const game: GameModule = {
  id: 'gnome-garden',
  name: 'Gnome Garden',
  components: { Pos, Move, Gnome, Flower, Visitor, Critter, Spark },
  position: { component: 'Pos', x: 'x', y: 'y' },
  size: { w: WORLD_W, h: WORLD_H, zoom: ZOOM },
  milestones: () => [
    ...BEATS.map((b) => ({ id: b.id, about: `diary: ${typeof b.text === 'string' ? b.text : b.text(SAMPLE)}`.slice(0, 110) })),
    ...FLOWERS.slice(1).map((f) => ({ id: `seed:${f.id}`, about: `the first ${f.name.toLowerCase()} are planted` })),
    ...GNOMES.map((d) => ({ id: `gnome:${d.id}`, about: `the first ${d.id} gnome is bought` })),
    { id: 'unearth', about: 'the last rite: this owner is done' },
  ],
  exportRecords,
  applyRecords,
  createWorld: (saved, opts = {}) => wrap(createGame(saved, { seed: opts.seed ?? 1, quiet: true })),
  render(world, opts = {}) {
    const w = opts.w ?? WORLD_W * ZOOM, h = opts.h ?? WORLD_H * ZOOM;
    const key = `${w}x${h}`;
    let scene = scenes.get(key);
    if (!scene) { scene = createScene(w, h); scenes.set(key, scene); }
    scene.render(gameOf(world), opts.time ?? 3.3);
    return { w, h, px: scene.fb.px };
  },
  profiles: Object.keys(PROFILES),
  art: {
    list: () => Object.entries(ART).map(([name, s]) => ({
      name, w: s.w, h: s.h,
      looks: Object.fromEntries(Object.entries(s.looks).map(([look, anims]) => [look, Object.fromEntries(Object.entries(anims).map(([a, f]) => [a, f.length]))])),
    })),
    frames(name, look, anim) {
      const s = ART[name];
      if (!s) throw new Error(`there is no drawing called ${name}; there are: ${Object.keys(ART).join(', ')}`);
      const anims = s.looks[look ?? Object.keys(s.looks)[0]];
      if (!anims) throw new Error(`${name} has no look called ${look}; it has: ${Object.keys(s.looks).join(', ')}`);
      if (anim) {
        if (!anims[anim]) throw new Error(`${name} has no animation called ${anim}; it has: ${Object.keys(anims).join(', ')}`);
        return anims[anim].map((f, i) => ({ label: `${anim} ${i + 1}`, pic: drawingFrame(name, f) }));
      }
      // The last frame says most: a flower in bloom, not its sprout.
      return Object.entries(anims).map(([a, f]) => ({ label: a, pic: drawingFrame(name, f[f.length - 1]) }));
    },
  },
  playthrough(world, profile, opts) {
    const g = gameOf(world);
    const until = opts.untilSeconds;
    const run = playthrough(g, PROFILES[profile] ?? PROFILES.eager, {
      owners: opts.owners ?? 1, seed: opts.seed ?? 1, dt: 0.2,
      maxHours: until !== undefined ? until / 3600 : opts.maxHours ?? 40,
    });
    return { profile, owners: run.owners, seconds: run.seconds };
  },
  commands(world): CommandDef[] {
    const g = (room?: string) => gameOf(world(room));
    return [
      {
        name: 'game.tap', kind: 'write', agent: 'free',
        about: 'Put a finger on the garden at a point (garden units, 144 wide by 224 tall): picks ripe flowers, pulls weeds, catches what flits by, greets visitors.',
        input: { x: 'number', y: 'number', room: 'string?' },
        run: (_c, i) => ({ did: g(i.room).tap(i.x, i.y) }),
      },
      {
        name: 'game.buy', kind: 'write', agent: 'free',
        about: `Buy something in the shop. what is plot, seed, a gnome (${GNOMES.map((d) => d.id).join(', ')}), an upgrade id (${UPGRADES.map((u) => u.id).join(', ')}), or an heirloom id. n is how many (default 1).`,
        input: { what: 'string', n: 'number?', room: 'string?' },
        run(_c, i) {
          const gm = g(i.room), n = i.n ?? 1;
          if (i.what === 'plot') return { bought: gm.buyPlot(n) };
          if (i.what === 'seed') return { bought: gm.buySeed() ? 1 : 0 };
          if (GNOMES.some((d) => d.id === i.what)) return { bought: gm.buyGnome(i.what as RoleId, n) };
          if (UPGRADES.some((u) => u.id === i.what)) return { bought: gm.buyUpgrade(i.what, n) };
          return { bought: gm.buyHeirloom(i.what) ? 1 : 0 };
        },
      },
      {
        name: 'game.use', kind: 'write', agent: 'free',
        about: `Use one of the round buttons: ${ABILITIES.map((a) => a.id).join(', ')}.`,
        input: { id: 'string', room: 'string?' },
        run: (_c, i) => ({ used: g(i.room).useAbility(i.id) }),
      },
      {
        name: 'game.claim', kind: 'write', agent: 'free',
        about: 'Cross a finished job off the to-do list (i is its place in the list, from 0) and take what it pays. skip swaps an unfinished job for another.',
        input: { i: 'number', skip: 'boolean?', room: 'string?' },
        run: (_c, i) => ({ ok: i.skip ? g(i.room).skipTask(i.i) : g(i.room).claimTask(i.i) }),
      },
      {
        name: 'game.unearth', kind: 'write', agent: 'free',
        about: 'The last rite: let him up. Ends this owner and hands the red hats on.',
        input: { room: 'string?' },
        run: (_c, i) => ({ ok: g(i.room).unearth() }),
      },
      {
        name: 'game.step', kind: 'write', agent: 'free',
        about: 'Let time pass in a world: seconds of game time, in small steps. Nothing is tapped or bought meanwhile.',
        input: { seconds: 'number', room: 'string?' },
        run(_c, i) {
          const gm = g(i.room);
          for (let t = 0; t < Math.min(i.seconds, 3600); t += 0.2) { gm.step(0.2); gm.events.length = 0; }
          return { clock: gm.s.clock };
        },
      },
    ];
  },
};
