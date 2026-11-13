// The simulation: one entity manager, one pipeline, and the rules of the
// garden. No DOM in here; the renderer, the UI and the tests all drive this.
import { createEntityManager, createPipeline, query, queryDiagnostics, type EntityManager } from 'archetype-ecs';
import { CRITTER, Critter, Flower, Gnome, Move, Pos, Spark, ST, VS, Visitor, SPARK } from './components.ts';
import {
  ABILITIES, AWAY, BEATS, FLAVOR, FLOWERS, HEIRLOOMS, ROLE, ROLE_IDS, TASK, TASKS, TUNE, UPGRADE, UPGRADES, UNEARTH_DEPTH, VISITORS,
  type Cost, type Res, type RoleId,
} from './content.ts';
import {
  canAfford, derive, gnomeCost, hatsFor, metreEffort, pay, plotCost, totalGnomes, unearthCost, upgradeCap, upgradeCost,
  type Derived,
} from './economy.ts';
import { migrate, newState, type State, type Task } from './state.ts';
import {
  BASKET, GATE, HOLE, HOLE_RY, JAR, LAWN_TOP, MAX_PLOTS, PATH, PLOTS, WORLD_H, WORLD_W,
  choirSpot, gardenerSpot, holeRadius, lanternSpot, rimSpot,
} from './world.ts';
import { clamp, fmtTiny, hash01, mood, rng } from '../util.ts';

/** How many of each kind get a body. Past this, the rest are counted but not drawn. */
export const CAP: Record<RoleId, number> = { gardener: 150, digger: 70, lantern: 44, choir: 140 };

export const MAX_DEPTH = 160;
const WEED_SLOW = 0.35;      // how much of its growing a weeded flower still does
const JOB_PATIENCE = 480;    // seconds before a job that is not getting done is swapped for another
const LURE_N = 14;           // gnomes that close in on a visitor
const ENDING_LEN = 14;       // seconds the unearthing takes

export interface GameEvent { type: string; x?: number; y?: number; n?: number; text?: string }
export interface Popup { x: number; y: number; text: string; life: number; color: number }

export interface Game {
  s: State;
  D: Derived;
  em: EntityManager;
  events: GameEvent[];
  popups: Popup[];
  fx: { flash: number; shake: number; scare: number };
  look: { x: number; y: number; age: number };
  /** 0 by day, 1 at night. */
  dark: number;
  /** True while the gnomes hold still. */
  frozen: boolean;
  /** 0..1: how far the idle gnomes have crept toward the bottom of the screen. */
  creep: number;
  /** Seconds since the garden was last touched. */
  untouched: number;
  /** Set while the unearthing plays; t runs 0..1. */
  ending: { t: number } | null;
  holeR: number;
  /** True while the garden is not to be seen: asleep, or looking away. */
  blind: boolean;
  /** True while a night is being slept through. */
  asleep: boolean;
  /** 0..1: how hard it is raining. It rains more as peace of mind goes; flowers like it. */
  rain: number;
  /** 0..1: how far the eyelids are down as the night comes on or goes. */
  lids: number;
  /** True while the gnomes are to be drawn as the ornaments they pretend to be: standing, not in mid-stride. */
  statues: boolean;
  /** Flowers picked by hand without a pause, right now. */
  combo: number;
  step(dt: number): void;
  /** A finger on the garden at world (x, y). Returns what it did. */
  tap(x: number, y: number): 'pick' | 'greet' | 'weed' | 'catch' | 'peek' | 'wake' | 'none';
  /** Swap a job on the to-do list for another, unpaid. */
  skipTask(i: number): boolean;
  /** Collect what a finished job pays. */
  claimTask(i: number): boolean;
  /** Use one of the round buttons. False if it is not unlocked or still cooling down. */
  useAbility(id: string): boolean;
  /** The player did something, anywhere: the gnomes are being watched. */
  touch(): void;
  buyPlot(n?: number): number;
  maxPlots(): number;
  buySeed(): boolean;
  buyGnome(id: RoleId, n?: number): number;
  buyUpgrade(id: string, n?: number): number;
  buyHeirloom(id: string): boolean;
  unearth(): boolean;
  seedCost(): Cost | null;
  maxGnomes(id: RoleId): number;
  maxUpgrade(id: string): number;
  /** Credit time spent away. Returns what the gnomes got up to. */
  away(seconds: number): { seconds: number; blooms: number; teeth: number; whispers: number; metres: number } | null;
  save(): string;
  /** Throw this owner away and start over; keeps nothing. */
  wipe(): void;
  /** The systems of the pipeline, in the order they run. */
  systems: string[];
  /** Work out again what follows from the content and the state: after the content changed under a running game. */
  refresh(): void;
}

export interface GameOptions { seed?: number; quiet?: boolean }

export function createGame(saved?: unknown, opts: GameOptions = {}): Game {
  if (opts.quiet) queryDiagnostics.setLogging(false);
  const rand = rng(opts.seed ?? (Date.now() & 0xffffffff));
  const em = createEntityManager();

  // Live numbers the queries read. Changing them needs no recompile.
  const T = { dt: 0, gnomeDt: 0, gnomeMul: 0, growDt: 0 };

  // ------------------------------------------------------------ queries

  const grow = query([Flower], { params: T }, (e, p) => {
    e.Flower.growth = Math.min(1, e.Flower.growth + e.Flower.rate * p.growDt);
  });

  const walkGnomes = query([Pos, Move, Gnome], { params: T }, (e, p) => {
    const dx = e.Move.tx - e.Pos.x;
    const dy = e.Move.ty - e.Pos.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.0001);
    const stride = Math.min(e.Move.speed * p.gnomeMul * p.dt, d);
    e.Pos.x += (dx / d) * stride;
    e.Pos.y += (dy / d) * stride;
    e.Gnome.walked += stride;
    e.Gnome.timer = Math.max(0, e.Gnome.timer - p.gnomeDt);
  });

  const walkVisitors = query([Pos, Move, Visitor], { params: T }, (e, p) => {
    const dx = e.Move.tx - e.Pos.x;
    const dy = e.Move.ty - e.Pos.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.0001);
    const stride = Math.min(e.Move.speed * p.dt, d);
    e.Pos.x += (dx / d) * stride;
    e.Pos.y += (dy / d) * stride;
    e.Visitor.walked += stride;
    e.Visitor.timer = Math.max(0, e.Visitor.timer - p.dt);
  });

  const flyCritters = query([Pos, Move, Critter], { params: T }, (e, p) => {
    const dx = e.Move.tx - e.Pos.x;
    const dy = e.Move.ty - e.Pos.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.0001);
    const stride = Math.min(e.Move.speed * p.dt, d);
    e.Pos.x += (dx / d) * stride;
    e.Pos.y += (dy / d) * stride;
    e.Critter.life -= p.dt;
    e.Critter.timer = Math.max(0, e.Critter.timer - p.dt);
  });

  const sparks = query([Pos, Spark], { params: T }, (e, p) => {
    e.Pos.x += e.Spark.vx * p.dt;
    e.Pos.y += e.Spark.vy * p.dt;
    e.Spark.vy += e.Spark.g * p.dt;
    e.Spark.life -= p.dt;
    if (e.Spark.life <= 0) e.destroy();
  });

  // ------------------------------------------------------------ state

  let s: State = migrate(saved) ?? newState();
  const g: Game = {
    s, D: derive(s), em,
    events: [], popups: [],
    fx: { flash: 0, shake: 0, scare: 0 },
    look: { x: WORLD_W / 2, y: WORLD_H, age: 999 },
    dark: 0, frozen: true, creep: 0, untouched: 0, ending: null, holeR: 0, blind: false, asleep: false, lids: 0, statues: true, rain: 0, combo: 0,
    step, tap, touch, useAbility, skipTask, claimTask, buyPlot, buySeed, buyGnome, buyUpgrade, buyHeirloom, unearth,
    seedCost, maxGnomes, maxUpgrade, maxPlots, away, save, wipe, systems: [], refresh,
  };

  const plotId = new Int32Array(MAX_PLOTS);          // plot -> flower entity
  const roleIds: number[][] = [[], [], [], []];       // role -> gnome entities, by idx
  const fc = em.cursor({ Flower });
  const gc = em.cursor({ Gnome, Pos, Move });
  const ripe = new Int16Array(MAX_PLOTS);
  let ripeN = 0;
  let watched = 0;
  let acc = { blooms: 0, teeth: 0, whispers: 0, effort: 0 };
  let accT = 0;
  let beatT = 0;
  let visitorT = 20;
  let lure = { x: 0, y: 0, on: false };
  const heap = { blooms: 0, teeth: 0, t: 0 };
  let rainT = 120, rainWant = 0;                     // the weather: when the next spell starts, and how hard it will rain
  let wake = 0;                                      // seconds the player stays awake after being woken in the night
  let lastPick = -99;                                // clock time of the last flower picked by hand
  let critterT = 40;
  let weedT = 25;
  let taskT = 0;       // what has landed on the doorstep since the last popup
  const pendingSparks: number[] = [];
  const doomed: number[] = [];
  const recentFlavor: string[] = [];

  // ------------------------------------------------------------ helpers

  function emit(type: string, extra: Partial<GameEvent> = {}) {
    if (g.events.length < 64) g.events.push({ type, ...extra });
  }

  function popup(x: number, y: number, text: string, color: number) {
    if (g.popups.length >= 28) g.popups.shift();
    g.popups.push({ x, y, text, life: 1.1, color });
  }

  function spark(x: number, y: number, vx: number, vy: number, grav: number, life: number, kind: number) {
    pendingSparks.push(x, y, vx, vy, grav, life, kind);
  }

  function burst(x: number, y: number, kind: number, n: number, power = 22) {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const v = power * (0.4 + rand() * 0.6);
      spark(x, y - 4, Math.cos(a) * v, Math.sin(a) * v * 0.6 - power * 0.7, 70, 0.5 + rand() * 0.4, kind);
    }
  }

  function flushSparks() {
    if (!pendingSparks.length) return;
    const room = 500 - em.count([Spark]);
    for (let i = 0; i < pendingSparks.length && i / 7 < room; i += 7) {
      em.spawn(
        [Pos, { x: pendingSparks[i], y: pendingSparks[i + 1] }],
        [Spark, { vx: pendingSparks[i + 2], vy: pendingSparks[i + 3], g: pendingSparks[i + 4], life: pendingSparks[i + 5], kind: pendingSparks[i + 6] }],
      );
    }
    pendingSparks.length = 0;
  }

  function gain(res: Res, amount: number, passive = true) {
    if (!(amount > 0)) return;
    s[res] += amount;
    if (res === 'blooms') { s.totalBlooms += amount; s.allBlooms += amount; }
    else if (res === 'teeth') s.totalTeeth += amount;
    else if (res === 'whispers') s.totalWhispers += amount;
    if (passive && res !== 'hats') acc[res] += amount;
  }

  function log(text: string, kind: State['log'][number]['kind'] = 'beat') {
    s.log.push({ text, day: s.day, kind });
    if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
    emit('diary', { text });
  }

  function refresh() {
    g.D = derive(s);
    const r = holeRadius(s.depth, s.gnomes.digger > 0 || s.depth > 0);
    if (r !== g.holeR) {
      g.holeR = r;
      const ids = roleIds[ROLE.choir];
      for (let i = 0; i < ids.length; i++) {
        gc.locate(ids[i]);
        const at = choirSpot(i, r);
        gc.Gnome.hx = at.x;
        gc.Gnome.hy = at.y;
      }
    }
    // Everyone's pace follows the boots.
    em.forEachArchetype([Move, Gnome], (_ids, n, field) => {
      const sp = field(Move.speed);
      const seed = field(Gnome.seed);
      for (let i = 0; i < n; i++) sp[i] = g.D.speed * (0.82 + 0.36 * seed[i]);
    });
  }

  // ------------------------------------------------------------ flowers

  function newKind(): number {
    return s.seed > 0 && rand() < 0.18 ? s.seed - 1 : s.seed;
  }

  function plant(plot: number, growth: number) {
    const kind = newKind();
    plotId[plot] = em.spawn([Flower, { plot, kind, claimed: 0, growth, rate: 1 / FLOWERS[kind].grow }]);
  }

  /** Cut the flower on a plot and start the next one. Returns its base value. */
  function harvest(plot: number): number {
    fc.locate(plotId[plot]);
    const value = FLOWERS[fc.Flower.kind].value;
    const kind = newKind();
    fc.Flower.kind = kind;
    fc.Flower.rate = (fc.Flower.weed ? WEED_SLOW : 1) / FLOWERS[kind].grow;
    fc.Flower.growth = 0;
    fc.Flower.claimed = 0;
    return value;
  }

  /** Something that was not planted comes up in a bed, and the flower there struggles. */
  function sproutWeed() {
    let weeds = 0;
    const free: number[] = [];
    for (let p = 0; p < s.plots; p++) {
      fc.locate(plotId[p]);
      if (fc.Flower.weed) weeds++; else free.push(p);
    }
    if (weeds >= Math.min(5, Math.floor(s.plots / 5)) || !free.length) return;
    fc.locate(plotId[free[Math.floor(rand() * free.length)]]);
    fc.Flower.weed = 1;
    fc.Flower.rate *= WEED_SLOW;
  }

  function pullWeed(plot: number): boolean {
    fc.locate(plotId[plot]);
    if (!fc.Flower.weed) return false;
    fc.Flower.weed = 0;
    fc.Flower.rate = 1 / FLOWERS[fc.Flower.kind].grow;
    return true;
  }

  function isRipe(plot: number): boolean {
    fc.locate(plotId[plot]);
    return fc.Flower.growth >= 1;
  }

  function scanRipe() {
    ripeN = 0;
    em.forEachArchetype([Flower], (_ids, n, field) => {
      const growth = field(Flower.growth);
      const claimed = field(Flower.claimed);
      const plot = field(Flower.plot);
      for (let i = 0; i < n; i++) if (growth[i] >= 1 && !claimed[i]) ripe[ripeN++] = plot[i];
    });
  }

  /** Take the ripe flower nearest (x, y) off the list and mark it claimed. */
  function claimNearest(x: number, y: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < ripeN; i++) {
      const p = PLOTS[ripe[i]];
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) { bestD = d; best = i; }
    }
    const plot = ripe[best];
    ripe[best] = ripe[--ripeN];
    fc.locate(plotId[plot]);
    fc.Flower.claimed = 1;
    return plot;
  }

  const petalOf = (kind: number) => [SPARK.petal, SPARK.pink, SPARK.yellow, SPARK.red, SPARK.red, SPARK.petal, SPARK.tooth, SPARK.red, SPARK.red][kind] ?? SPARK.petal;

  // ------------------------------------------------------------ gnomes

  function spotFor(role: number, idx: number) {
    if (role === ROLE.gardener) return gardenerSpot(idx);
    if (role === ROLE.lantern) return lanternSpot(idx);
    if (role === ROLE.choir) return choirSpot(idx, g.holeR);
    return rimSpot(idx, g.holeR);
  }

  function spawnGnome(role: number, look: number, at?: { x: number; y: number }) {
    const ids = roleIds[role];
    const idx = ids.length;
    const home = spotFor(role, idx);
    const seed = hash01(idx * 97 + role * 13 + 7);
    // A gnome you bought is where you put it. Later on they walk in by themselves.
    const from = at ?? (role === ROLE.gardener && s.peace > 75 ? home
      : role === ROLE.digger || role === ROLE.choir ? rimSpot(idx + 3, Math.max(4, g.holeR))
        : role === ROLE.lantern && s.peace > 60 ? home : GATE);
    const id = em.spawn(
      [Pos, { x: from.x, y: from.y }],
      [Move, { tx: home.x, ty: home.y, speed: g.D.speed * (0.82 + 0.36 * seed) }],
      [Gnome, {
        role, look, idx, seed, plot: -1, face: seed > 0.5 ? 1 : -1,
        state: role === ROLE.lantern || role === ROLE.choir ? ST.POST : ST.IDLE,
        hx: home.x, hy: home.y, walked: seed * 10,
      }],
    );
    ids.push(id);
    return id;
  }

  /** Give every counted gnome a body, up to the cap. */
  function syncGnomes() {
    for (let role = 0; role < 4; role++) {
      const id = ROLE_IDS[role];
      const want = Math.min(s.gnomes[id], CAP[id]);
      while (roleIds[role].length < want) {
        const idx = roleIds[role].length;
        spawnGnome(role, Math.floor(hash01(idx * 53 + role * 7 + 3) * 5));
      }
    }
  }

  function deliverBlooms(x: number, y: number, value: number) {
    const amount = value * g.D.bloomMult;
    gain('blooms', amount);
    s.stats.delivered++;
    heap.blooms += amount;
    emit('deliver', { x, y, n: amount });
  }

  function dug(rep: number, x: number, y: number) {
    const effort = g.D.digPower * rep;
    acc.effort += effort;
    addEffort(effort);
    for (let k = 0; k < 2; k++) spark(x, y - 2, (rand() - 0.5) * 30, -20 - rand() * 20, 90, 0.5, SPARK.dirt);
  }

  function addEffort(effort: number): number {
    let metres = 0;
    s.effort += effort;
    while (s.depth < MAX_DEPTH && s.effort >= metreEffort(s.depth)) {
      s.effort -= metreEffort(s.depth);
      s.depth++;
      metres++;
    }
    if (s.depth >= MAX_DEPTH) s.effort = 0;
    if (metres) { emit('depth', { n: s.depth }); refresh(); }
    return metres;
  }

  function brain() {
    const D = g.D;
    const carryCap = D.carry;
    const diggerRep = roleIds[ROLE.digger].length ? s.gnomes.digger / roleIds[ROLE.digger].length : 1;
    const creep = g.creep;
    const ending = !!g.ending;
    em.forEachArchetype([Pos, Move, Gnome], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y);
      const tx = field(Move.tx), ty = field(Move.ty);
      const role = field(Gnome.role), st = field(Gnome.state), load = field(Gnome.load), face = field(Gnome.face);
      const plot = field(Gnome.plot), idx = field(Gnome.idx), timer = field(Gnome.timer), carry = field(Gnome.carry);
      const seed = field(Gnome.seed), hx = field(Gnome.hx), hy = field(Gnome.hy);

      for (let i = 0; i < n; i++) {
        const x = px[i], y = py[i];
        const ddx = tx[i] - x, ddy = ty[i] - y;
        const arrived = ddx * ddx + ddy * ddy < 0.3;
        let goX = tx[i], goY = ty[i];

        if (ending) {
          // Everybody comes to the hole.
          const at = choirSpot((idx[i] * 4 + role[i]) % 900, g.holeR + 4);
          goX = at.x; goY = at.y;
          st[i] = ST.POST;
        } else if (role[i] === ROLE.gardener) {
          switch (st[i]) {
            case ST.IDLE:
            case ST.TO_HOME:
              if (lure.on && idx[i] < LURE_N) {
                const a = (idx[i] / LURE_N) * Math.PI * 2;
                goX = lure.x + Math.cos(a) * 11; goY = lure.y + Math.sin(a) * 7 + 2;
                st[i] = ST.LURE;
              } else if (load[i] >= carryCap || (load[i] > 0 && ripeN === 0)) {
                goX = BASKET.x + (seed[i] - 0.5) * 8; goY = BASKET.y + 2 + (seed[i] * 7 % 1) * 3;
                st[i] = ST.TO_BASKET;
              } else if (ripeN > 0) {
                const p = claimNearest(x, y);
                plot[i] = p;
                goX = PLOTS[p].x + (seed[i] > 0.5 ? 5 : -5); goY = PLOTS[p].y + 1;
                st[i] = ST.TO_FLOWER;
              } else {
                // Nothing to do: stand where it stands. Or, late on, come closer.
                goX = hx[i]; goY = hy[i];
                if (creep > 0) {
                  goX += (WORLD_W * (0.08 + 0.84 * ((seed[i] * 37) % 1)) - goX) * creep * 0.8;
                  goY += (WORLD_H - 2 - ((seed[i] * 91) % 1) * 16 - goY) * creep;
                }
                st[i] = arrived ? ST.IDLE : ST.TO_HOME;
              }
              break;
            case ST.TO_FLOWER:
              if (arrived) {
                if (isRipe(plot[i])) { st[i] = ST.PICK; timer[i] = D.pickTime; face[i] = PLOTS[plot[i]].x > x ? 1 : -1; }
                else { plot[i] = -1; st[i] = ST.IDLE; }
              }
              break;
            case ST.PICK:
              if (timer[i] <= 0) {
                const p = plot[i];
                fc.locate(plotId[p]);
                const kind = fc.Flower.kind;
                carry[i] += harvest(p);
                if (D.hoe) pullWeed(p);
                load[i]++;
                plot[i] = -1;
                st[i] = ST.IDLE;
                spark(PLOTS[p].x, PLOTS[p].y - 6, (rand() - 0.5) * 16, -14, 60, 0.5, petalOf(kind));
                emit('snip', { x, y });
              }
              break;
            case ST.TO_BASKET:
              if (arrived) {
                deliverBlooms(x, y, carry[i]);
                carry[i] = 0; load[i] = 0;
                st[i] = ST.IDLE;
              }
              break;
            case ST.LURE:
              if (!lure.on) st[i] = ST.IDLE;
              break;
            default:
              st[i] = ST.IDLE;
          }
        } else if (role[i] === ROLE.digger) {
          switch (st[i]) {
            case ST.TO_HOLE:
              if (arrived) { st[i] = ST.DIG; timer[i] = D.digTime * (0.75 + seed[i] * 0.5); }
              break;
            case ST.DIG:
              if (timer[i] <= 0) {
                dug(diggerRep, x, y);
                carry[i] = 1;
                goX = JAR.x + (seed[i] - 0.5) * 8; goY = JAR.y + 2 + ((seed[i] * 5) % 1) * 3;
                st[i] = ST.TO_JAR;
              }
              break;
            case ST.TO_JAR:
              if (arrived) {
                const amount = D.teethPer * diggerRep;
                gain('teeth', amount);
                heap.teeth += amount;
                emit('tooth', { x, y, n: amount });
                carry[i] = 0;
                st[i] = ST.IDLE;
              }
              break;
            default: {
              const at = rimSpot(idx[i] + Math.floor(s.clock / 7), g.holeR);
              goX = at.x; goY = at.y;
              st[i] = ST.TO_HOLE;
            }
          }
        } else {
          // Lantern bearers and the choir keep their posts.
          goX = hx[i]; goY = hy[i];
          st[i] = ST.POST;
        }

        if (goX !== tx[i] || goY !== ty[i]) {
          tx[i] = goX; ty[i] = goY;
          if (Math.abs(goX - x) > 0.5) face[i] = goX > x ? 1 : -1;
        }
      }
    });
  }

  // ------------------------------------------------------------ visitors

  function spawnVisitor() {
    if (em.count([Visitor]) >= 3) return;
    const kind = s.stats.visitors === 0 ? 0 : Math.floor(rand() * VISITORS.length);
    em.spawn(
      [Pos, { x: GATE.x, y: GATE.y - 4 }],
      [Move, { tx: PATH[0].x, ty: PATH[0].y + 4, speed: 13 }],
      [Visitor, { kind, state: VS.ENTER, step: 0, face: -1, seed: rand() }],
    );
    s.stats.visitors++;
    emit('visitor');
  }

  function greet(x: number, y: number) {
    const tip = Math.max(5 * g.D.bloomMult, s.rate.blooms * g.D.tipSeconds);
    gain('blooms', tip, false);
    s.stats.greeted++;
    popup(x, y - 20, '+' + fmtTiny(tip), 0);
    for (let k = 0; k < 3; k++) spark(x + (rand() - 0.5) * 6, y - 16, (rand() - 0.5) * 8, -12 - rand() * 8, 0, 0.9, SPARK.heart);
    emit('greet', { x, y, n: tip });
  }

  function visitorBrain() {
    const taking = !!s.up.gate && g.dark > 0.5;
    let stillLuring = false;
    em.forEachArchetype([Pos, Move, Visitor], (ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y);
      const tx = field(Move.tx), ty = field(Move.ty);
      const kind = field(Visitor.kind), st = field(Visitor.state), leg = field(Visitor.step), greeted = field(Visitor.greeted);
      const face = field(Visitor.face), timer = field(Visitor.timer), seed = field(Visitor.seed);
      for (let i = 0; i < n; i++) {
        const x = px[i], y = py[i];
        const dx = tx[i] - x, dy = ty[i] - y;
        const arrived = dx * dx + dy * dy < 0.3;
        switch (st[i]) {
          case VS.ENTER:
            if (arrived) {
              if (leg[i] === 0) {
                // Down the path, then over to the beds.
                tx[i] = PATH[1].x; ty[i] = 66 + seed[i] * 58; leg[i] = 1;
              } else if (leg[i] === 1) {
                tx[i] = PATH[1].x - 6 + seed[i] * 2; leg[i] = 2; face[i] = -1;
              } else {
                st[i] = VS.BROWSE;
                timer[i] = 7 + seed[i] * 5;
                face[i] = -1;
                if (taking && !lure.on) {
                  st[i] = VS.TAKEN;
                  timer[i] = 5.5;
                  lure = { x, y, on: true };
                  emit('lure', { x, y });
                } else if (s.heir.mat && !greeted[i]) {
                  greeted[i] = 1;
                  greet(x, y);
                }
              }
            }
            break;
          case VS.BROWSE:
            if (timer[i] <= 0) { st[i] = VS.LEAVE; leg[i] = 0; tx[i] = PATH[1].x; face[i] = 1; }
            break;
          case VS.LEAVE:
            if (arrived) {
              if (leg[i] === 0) { tx[i] = GATE.x; ty[i] = GATE.y - 6; leg[i] = 1; }
              else doomed.push(ids[i]);
            }
            break;
          case VS.TAKEN:
            stillLuring = true;
            if (timer[i] <= 0) {
              doomed.push(ids[i]);
              stillLuring = false;
              stay(kind[i], x, y);
            }
            break;
        }
      }
    });
    if (lure.on && !stillLuring) lure.on = false;
    if (doomed.length) {
      for (const id of doomed) em.destroyEntity(id);
      doomed.length = 0;
    }
  }

  // ------------------------------------------------------------ things passing through

  function spawnCritter() {
    if (em.count([Critter]) >= 2) return;
    const night = g.dark > 0.5;
    const kinds: number[] = [];
    if (!night && s.peace > 50) kinds.push(CRITTER.butterfly, CRITTER.butterfly);
    if (night && s.peace > 40) kinds.push(CRITTER.firefly, CRITTER.firefly);
    if (g.holeR > 0) kinds.push(CRITTER.mound);
    if (!night && s.peace <= 66 && s.peace > 20) kinds.push(CRITTER.crow);
    if (s.peace <= 50 && s.flags.rites) kinds.push(CRITTER.glint, CRITTER.glint);
    if (!kinds.length) return;
    const kind = kinds[Math.floor(rand() * kinds.length)];
    let x = 20 + rand() * (WORLD_W - 40), y = LAWN_TOP + 24 + rand() * 110, speed = 0;
    if (kind === CRITTER.butterfly || kind === CRITTER.firefly) speed = 20;
    else if (kind === CRITTER.mound) { x = rand() < 0.5 ? 6 : WORLD_W - 6; y = HOLE.y - 30 + rand() * 50; speed = 6; }
    else if (kind === CRITTER.crow) { x = 62 + rand() * 48; y = LAWN_TOP - 13; }
    else { x = rand() < 0.5 ? 5 + rand() * 8 : WORLD_W - 13 + rand() * 8; y = 80 + rand() * 120; }
    em.spawn(
      [Pos, { x, y }],
      [Move, { tx: kind === CRITTER.mound ? HOLE.x : x, ty: kind === CRITTER.mound ? HOLE.y : y, speed }],
      [Critter, { kind, life: kind === CRITTER.mound ? 22 : 14, seed: rand() }],
    );
    emit('critter', { n: kind });
  }

  function critterBrain() {
    em.forEachArchetype([Pos, Move, Critter], (ids, n, field) => {
      const tx = field(Move.tx), ty = field(Move.ty);
      const kind = field(Critter.kind), life = field(Critter.life), timer = field(Critter.timer);
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) { doomed.push(ids[i]); continue; }
        if ((kind[i] === CRITTER.butterfly || kind[i] === CRITTER.firefly) && timer[i] <= 0) {
          // Flit from flower to flower.
          const at = PLOTS[Math.floor(rand() * Math.max(4, s.plots))];
          tx[i] = at.x + (rand() - 0.5) * 30; ty[i] = at.y - 6 + (rand() - 0.5) * 24;
          timer[i] = 0.9 + rand() * 1.4;
        }
      }
    });
    if (doomed.length) {
      for (const id of doomed) em.destroyEntity(id);
      doomed.length = 0;
    }
  }

  /** What catching one is worth. */
  function caught(kind: number, x: number, y: number) {
    const D = g.D;
    s.stats.critters++;
    if (kind === CRITTER.butterfly) {
      const amount = Math.max(12 * D.bloomMult, s.rate.blooms * 45);
      gain('blooms', amount, false);
      s.buff.pollen = 20;
      popup(x, y - 8, '+' + fmtTiny(amount), 0);
      burst(x, y, SPARK.yellow, 8, 26);
    } else if (kind === CRITTER.firefly) {
      const amount = Math.max(12 * D.bloomMult, s.rate.blooms * 30);
      gain('blooms', amount, false);
      s.buff.glow = 25;
      popup(x, y - 8, '+' + fmtTiny(amount), 0);
      burst(x, y, SPARK.star, 8, 26);
    } else if (kind === CRITTER.mound || kind === CRITTER.crow) {
      const amount = Math.max(3 * D.teethPer, s.rate.teeth * 60);
      gain('teeth', amount, false);
      if (!s.flags.teeth) gain('blooms', Math.max(20 * D.bloomMult, s.rate.blooms * 60), false);
      popup(x, y - 8, '+' + fmtTiny(Math.max(1, amount)), 1);
      burst(x, y, kind === CRITTER.crow ? SPARK.whisper : SPARK.dirt, 8, 26);
    } else {
      const amount = Math.max(4 * D.hatMult, s.rate.whispers * 60);
      gain('whispers', amount, false);
      popup(x, y - 8, '+' + fmtTiny(Math.max(1, amount)), 2);
      burst(x, y, SPARK.red, 6, 20);
    }
    emit('catch', { x, y, n: kind });
  }

  // ------------------------------------------------------------ the round buttons

  function useAbility(id: string): boolean {
    const def = ABILITIES.find((a) => a.id === id);
    if (!def || g.ending || !def.need(s) || (s.cd[id] ?? 0) > 0) return false;
    s.buff[id] = def.len;
    s.cd[id] = def.cd;
    s.stats.abilities++;
    if (id === 'away') { g.blind = true; g.untouched = Math.max(g.untouched, 3); watched = 0; }
    if (id === 'nap' && g.dark < 0.5) s.dayT = Math.max(s.dayT, g.D.dayLen - 2.5);     // dusk, now
    emit('ability', { text: id });
    return true;
  }

  /** The player opens their eyes again. */
  function lookBack() {
    g.blind = false;
    s.buff.away = 0;
    s.stats.peeks++;
    if (s.peace < 50) g.creep = 1;                       // they are closer than they were
    if (s.peace < 32 && (s.stats.peeks === 1 || !s.flags.scared || rand() < 0.18)) {
      s.flags.scared = 1;
      g.fx.scare = 0.4;
      emit('scare');
    }
    emit('peek');
  }

  // ------------------------------------------------------------ the to-do list

  function measure(kind: string): number {
    switch (kind) {
      case 'pick': return s.stats.tapped;
      case 'plots': return s.plots;
      case 'gnomes': return s.bought.gardener + s.bought.digger + s.bought.lantern + s.bought.choir;
      case 'deliver': return s.stats.delivered;
      case 'weed': return s.stats.weeds;
      case 'catch': return s.stats.critters;
      case 'ability': return s.stats.abilities;
      case 'greet': return s.stats.greeted;
      case 'depth': return s.depth;
      default: return 0;       // streak and quiet are counted as they happen
    }
  }

  function newTask(): Task | null {
    const open = TASKS.filter((t) => (!t.need || t.need(s)) && !s.todo.some((x) => x.kind === t.kind));
    if (!open.length) return null;
    const def = open[Math.floor(rand() * open.length)];
    return { kind: def.kind, goal: Math.max(1, def.goal(s, s.done, rand)), have: 0, from: measure(def.kind), born: s.clock, ready: 0 };
  }

  function tasks() {
    if (!s.beats.firstPick) return;
    while (s.todo.length < 3) {
      const t = newTask();
      if (!t) break;
      s.todo.push(t);
    }
    for (let i = 0; i < s.todo.length; i++) {
      const t = s.todo[i];
      if (t.kind === 'quiet') t.have = Math.max(t.have, Math.floor(g.untouched));
      else if (t.kind !== 'streak') t.have = measure(t.kind) - t.from;
      if (t.ready) continue;
      if (t.have < t.goal) {
        // A job nobody gets round to is quietly replaced after a while.
        if (s.clock - t.born > JOB_PATIENCE) { const next = newTask(); if (next) s.todo[i] = next; }
        continue;
      }
      if (!t.ready) {
        t.ready = 1;
        emit('ready', { text: TASK[t.kind].text[0].replace('{n}', String(t.goal)) });
      }
    }
  }

  /** What a finished job pays: a minute of the garden's income, and the pleasure of crossing it off. */
  function jobPay(): number {
    return Math.max(15 * g.D.bloomMult, s.rate.blooms * TUNE.economy.jobPaySeconds);
  }

  function claimTask(i: number): boolean {
    const t = s.todo[i];
    if (!t || !t.ready) return false;
    s.done++;
    const blooms = jobPay();
    gain('blooms', blooms, false);
    if (s.flags.teeth) gain('teeth', Math.max(g.D.teethPer, s.rate.teeth * 30), false);
    const what = TASK[t.kind].text[0].replace('{n}', String(t.goal));
    s.log.push({ text: what, day: s.day, kind: 'job' });
    if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
    emit('task', { text: what, n: blooms });
    const next = newTask();
    if (next) s.todo[i] = next; else s.todo.splice(i, 1);
    refresh();
    return true;
  }

  /** Cross a job out without doing it: another takes its place. */
  function skipTask(i: number): boolean {
    if (!s.todo[i] || s.todo[i].ready) return false;
    const next = newTask();
    if (!next) return false;
    s.todo[i] = next;
    return true;
  }

  /** A visitor does not go home. */
  function stay(kind: number, x: number, y: number) {
    g.fx.flash = 1;
    g.fx.shake = 0.5;
    s.guests++;
    const whispers = Math.max(40 * g.D.hatMult, s.rate.whispers * 45);
    gain('whispers', whispers, false);
    popup(x, y - 22, '+' + fmtTiny(whispers), 2);
    const n = g.D.guestGnomes;
    s.gnomes.gardener += n;
    // The first of them keeps something of who it was.
    if (roleIds[ROLE.gardener].length < CAP.gardener) spawnGnome(ROLE.gardener, 5 + kind, { x, y });
    syncGnomes();
    refresh();
    burst(x, y, SPARK.red, 10, 30);
    const key = 'left_' + VISITORS[kind].id;
    if (!s.flags[key]) { s.flags[key] = 1; log(VISITORS[kind].left); }
    emit('taken', { x, y, n });
  }

  // ------------------------------------------------------------ the day

  /** dt is garden time, which runs fast through a slept night; real is the player's own time. */
  function clock(dt: number, real: number) {
    const D = g.D;
    s.clock += real;
    s.stats.played += real;
    g.untouched += real;
    g.look.age += real;
    watched = Math.max(0, watched - real);
    wake = Math.max(0, wake - real);

    // No night until there is somebody to use it.
    if (s.flags.nightSoon) {
      const cycle = D.dayLen + D.nightLen;
      s.dayT += dt;
      if (s.dayT >= cycle) {
        s.dayT -= cycle;
        s.day++;
        emit('dawn');
      }
      const t = s.dayT;
      const dusk = 5;
      const was = g.dark;
      g.dark = t < D.dayLen - dusk ? 0
        : t < D.dayLen ? (t - (D.dayLen - dusk)) / dusk
          : t < cycle - dusk ? 1
            : Math.max(0, (cycle - t) / dusk);
      if (was < 0.5 && g.dark >= 0.5) emit('dusk');
    } else {
      g.dark = 0;
    }

    // Whatever the player set going runs down; cooldowns too.
    const B = s.buff;
    for (const k in s.cd) if (s.cd[k] > 0) s.cd[k] = Math.max(0, s.cd[k] - real);
    for (const k in B) {
      if (!(B[k] > 0)) continue;
      B[k] = Math.max(0, B[k] - real);
      if (B[k] === 0 && k === 'away') lookBack();
    }

    // Early on the nights are simply slept through: eyes shut, nothing to see, and it is morning.
    // The weather comes in spells of a few minutes. Fine at first; it rains more often as things go on.
    rainT -= real;
    if (rainT <= 0) {
      rainT = 150 + rand() * 210;
      const chance = clamp((88 - s.peace) / 60, 0, 1);
      rainWant = !g.ending && rand() < chance ? 0.35 + 0.65 * rand() : 0;
      if (rainWant > 0 && g.rain === 0) emit('rain');
    }
    g.rain += clamp(rainWant - g.rain, -real / 10, real / 10);

    // The lids come down as the light goes and are shut well before anything stirs; they open again only
    // once everything is still. Nothing is ever seen to move.
    const night = g.dark >= 0.5;
    const slept = g.asleep;
    const sleeper = !g.ending && !s.flags.awake && !D.byDay;
    g.lids = sleeper && wake <= 0 ? clamp((g.dark - 0.2) / 0.35, 0, 1) : 0;
    g.asleep = sleeper && wake <= 0 && g.dark >= 0.7;
    if (slept && !g.asleep && wake <= 0) morning();
    g.blind = g.asleep || B.away > 0;

    if (B.water > 0 && rand() < real * 40) {
      const at = PLOTS[Math.floor(rand() * s.plots)];
      spark(at.x + (rand() - 0.5) * 10, at.y - 16 - rand() * 6, 0, 20, 60, 0.4, SPARK.water);
    }
    if (B.pollen > 0 && rand() < real * 12) {
      const at = PLOTS[Math.floor(rand() * s.plots)];
      spark(at.x + (rand() - 0.5) * 10, at.y - 8, (rand() - 0.5) * 6, -6, 0, 0.8, SPARK.yellow);
    }
    if (s.clock - lastPick > 1.6) g.combo = 0;
    g.fx.scare = Math.max(0, g.fx.scare - real);

    // To begin with they are ornaments and nothing else. Then they stir at night, unseen. Then by day,
    // when nobody is looking. Until they stop bothering.
    const stirring = !!s.flags.stir || D.byDay;
    const hurried = B.bell > 0 || B.away > 0;
    const watching = watched > 0 && D.freeze;
    g.frozen = !g.ending && (!stirring
      || (sleeper ? !g.asleep                                   // while nights are slept: only behind shut eyes
        : night ? false                                         // once they are watched: every night, openly
          : !hurried && D.freeze && (watched > 0 || !D.byDay)));
    // Caught at it, they hold whatever pose they were in. Otherwise a gnome that is not moving is an ornament.
    g.statues = g.frozen && !(D.byDay && watching);

    // Left alone for long enough, late on, they come closer.
    if (s.peace < 50 && g.untouched > 25 && !g.frozen) g.creep = Math.min(1, g.creep + real / 40);
    else if (g.untouched < 1) g.creep = Math.max(0, g.creep - real * 3);

    const pace = (g.ending ? 1.6 : night ? 1.25 : 1) * (B.bell > 0 ? 2.5 : 1) * (B.away > 0 ? 3 : 1) * (B.glow > 0 ? 1.6 : 1);
    T.dt = dt;
    T.gnomeMul = g.frozen ? 0 : pace;
    T.gnomeDt = g.frozen ? 0 : dt * pace;
    T.growDt = dt * D.growMult * (night ? D.nightGrow : 1) * (B.water > 0 ? 4 : 1) * (B.pollen > 0 ? 2 : 1) * (1 + TUNE.economy.rainGrowth * g.rain);

    // One number for everything that reached the doorstep lately, not one per gnome.
    heap.t -= real;
    if (heap.t <= 0 && !g.asleep) {
      heap.t = 1.25;
      if (heap.blooms > 0) popup(BASKET.x + 2, BASKET.y - 12, '+' + fmtTiny(heap.blooms), 0);
      if (heap.teeth > 0) popup(JAR.x, JAR.y - 12, '+' + fmtTiny(Math.max(1, heap.teeth)), 1);
      heap.blooms = 0; heap.teeth = 0;
    }

    g.fx.flash = Math.max(0, g.fx.flash - real * 2.2);
    g.fx.shake = Math.max(0, g.fx.shake - real * 1.5);
    for (let i = g.popups.length - 1; i >= 0; i--) {
      const p = g.popups[i];
      p.life -= real;
      p.y -= real * 9;
      if (p.life <= 0) g.popups.splice(i, 1);
    }
  }

  /** Eyes open on a new day: whatever turned up on the doorstep overnight is there to be found. */
  function morning() {
    heap.t = 0.4;
    // Early on everything is back where it was by morning. Later they are found wherever the dawn caught them.
    if (!s.beats.moved) {
      let carried = 0;
      em.forEachArchetype([Pos, Move, Gnome], (_ids, n, field) => {
        const px = field(Pos.x), py = field(Pos.y), tx = field(Move.tx), ty = field(Move.ty);
        const hx = field(Gnome.hx), hy = field(Gnome.hy), st = field(Gnome.state), role = field(Gnome.role);
        const load = field(Gnome.load), carry = field(Gnome.carry), plot = field(Gnome.plot), timer = field(Gnome.timer);
        for (let i = 0; i < n; i++) {
          if (role[i] === ROLE.gardener) { carried += carry[i]; if (plot[i] >= 0) { fc.locate(plotId[plot[i]]); fc.Flower.claimed = 0; } }
          px[i] = tx[i] = hx[i]; py[i] = ty[i] = hy[i];
          st[i] = role[i] === ROLE.gardener || role[i] === ROLE.digger ? ST.IDLE : ST.POST;
          load[i] = 0; carry[i] = 0; plot[i] = -1; timer[i] = 0;
        }
      });
      if (carried > 0) deliverBlooms(BASKET.x, BASKET.y, carried);
    }
    emit('morning', { n: heap.blooms });
  }

  function economy(dt: number, real: number) {
    const D = g.D;
    // The choir is in full voice at night, and only murmurs by day.
    if (D.whisperRate > 0 && !g.frozen) gain('whispers', D.whisperRate * (g.dark >= 0.5 ? 1 : 0.25) * (s.buff.sing > 0 ? 6 : 1) * dt);

    if (D.visitorEvery > 0 && !g.ending) {
      visitorT -= real;
      if (visitorT <= 0) { visitorT = D.visitorEvery * (0.7 + rand() * 0.6); spawnVisitor(); }
    }

    // Things flit through, and things come up in the beds, for whoever is paying attention.
    if (s.flags.gnomes && !g.ending) {
      critterT -= real;
      if (critterT <= 0) { critterT = 35 + rand() * 40; if (!g.asleep) spawnCritter(); }
    }
    if (s.plots >= 6 && !g.ending) {
      weedT -= real;
      if (weedT <= 0) { weedT = 14 + rand() * 16; sproutWeed(); }
    }
    taskT -= real;
    if (taskT <= 0) { taskT = 0.5; tasks(); }

    // They invite friends.
    if (s.flags.friends && !g.ending) {
      s.nextFriend -= real;
      if (s.nextFriend <= 0) {
        s.nextFriend = 35 + rand() * 30;
        s.gnomes.gardener += 1;
        syncGnomes();
        refresh();
        emit('friend');
      }
    }

    accT += real;
    if (accT >= 1) {
      const k = 0.12;
      s.rate.blooms += (acc.blooms / accT - s.rate.blooms) * k;
      s.rate.teeth += (acc.teeth / accT - s.rate.teeth) * k;
      s.rate.whispers += (acc.whispers / accT - s.rate.whispers) * k;
      s.rate.effort += (acc.effort / accT - s.rate.effort) * k;
      acc = { blooms: 0, teeth: 0, whispers: 0, effort: 0 };
      accT = 0;
    }

    s.peace += clamp(s.peaceCap - s.peace, -real * 2.5, real * 2.5);

    beatT -= real;
    if (beatT <= 0) { beatT = 0.5; story(); }

    s.nextFlavor -= real;
    if (s.nextFlavor <= 0) {
      s.nextFlavor = 150 + rand() * 150;
      const pool = FLAVOR.find((f) => s.peace >= f.min && s.peace < f.max);
      const fresh = pool?.lines.filter((l) => !recentFlavor.includes(l));
      if (fresh?.length) {
        const line = fresh[Math.floor(rand() * fresh.length)];
        recentFlavor.push(line);
        if (recentFlavor.length > 10) recentFlavor.shift();
        log(line, 'flavor');
      }
    }
  }

  function story() {
    for (const b of BEATS) {
      if (s.beats[b.id]) continue;
      if (b.after && s.clock < b.after * 60 * (s.runs ? 1 / 3 : 1)) continue;
      if (!b.when(s)) continue;
      s.beats[b.id] = 1;
      if (b.flag) for (const f of Array.isArray(b.flag) ? b.flag : [b.flag]) s.flags[f] = 1;
      if (b.peace !== undefined) s.peaceCap = Math.min(s.peaceCap, b.peace);
      log(typeof b.text === 'function' ? b.text(s) : b.text);
      if (b.id === 'gerald') s.dayT = Math.max(s.dayT, g.D.dayLen - 16);   // dusk is not far off
      emit('beat', { text: b.id });
      refresh();
    }
  }

  // ------------------------------------------------------------ the end, and the next owner

  function runEnding(dt: number) {
    const e = g.ending!;
    e.t += dt / ENDING_LEN;
    g.fx.shake = Math.max(g.fx.shake, 0.25 + e.t * 0.9);
    if (rand() < dt * 14) spark(HOLE.x + (rand() - 0.5) * g.holeR * 2, HOLE.y, (rand() - 0.5) * 30, -30 - rand() * 50, 80, 0.9, SPARK.dirt);
    if (e.t >= 1) {
      const hats = hatsFor(s.totalBlooms, s.depth);
      const next = newState();
      next.hats = s.hats + hats;
      next.hatsEver = s.hatsEver + hats;
      next.heir = s.heir;
      next.runs = s.runs + 1;
      next.allBlooms = s.allBlooms;
      next.stats.played = s.stats.played;
      next.mute = s.mute;
      next.buyN = s.buyN;
      next.flags.prestiged = 1;
      load(next);
      g.fx.flash = 1.6;
      emit('reborn', { n: hats });
    }
  }

  function applyHeirlooms() {
    if (s.clock > 0) return;
    if (s.runs > 0 && s.gnomes.gardener === 0) {
      // Somebody left a gnome. With the heirloom, a few.
      s.gnomes.gardener = s.heir.gerald ? 3 : 1;
      s.flags.gnomes = 1;
      s.flags.plots = 1;
    }
    if (s.heir.tools) for (const id of ['can', 'compost', 'gloves']) s.up[id] = Math.max(s.up[id] ?? 0, 3);
    if (s.heir.jar && !s.flags.jarGiven) { s.teeth += 200; s.flags.jarGiven = 1; }
  }

  /** Rebuild the garden's entities from a state. */
  function load(next: State) {
    for (const id of em.getAllEntities()) em.destroyEntity(id);
    for (const ids of roleIds) ids.length = 0;
    g.popups.length = 0;
    pendingSparks.length = 0;
    s = g.s = next;
    g.ending = null;
    g.creep = 0;
    g.holeR = -1;
    lure.on = false;
    visitorT = 20;
    g.blind = false; g.asleep = false; g.combo = 0; wake = 0; g.rain = 0; rainWant = 0; rainT = 120;
    s.buff.away = 0;
    acc = { blooms: 0, teeth: 0, whispers: 0, effort: 0 };
    applyHeirlooms();
    refresh();
    for (let p = 0; p < s.plots; p++) plant(p, 0.3 + hash01(p + 11) * 0.6);
    syncGnomes();
    refresh();
    story();
  }

  // ------------------------------------------------------------ the pipeline

  const systems = {
    grow,
    ripe: scanRipe,
    brain: () => { if (!g.frozen) brain(); },
    walkGnomes,
    visitors: visitorBrain,
    walkVisitors,
    critters: critterBrain,
    flyCritters,
    flush: flushSparks,
    sparks,
  };
  const pipeline = createPipeline(em, systems);
  g.systems = Object.keys(systems);

  function step(dt: number) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.25);
    // A slept night goes by in a few seconds: the garden runs fast, in small steps, behind shut eyes.
    const warp = g.asleep ? Math.max(1, g.D.nightLen / TUNE.day.sleepSeconds) : 1;
    const n = Math.min(40, Math.ceil(warp));
    for (let i = 0; i < n; i++) {
      clock((dt * warp) / n, dt / n);
      em.flushHooks();
      pipeline();
      if (g.ending) runEnding(dt / n);
      else economy((dt * warp) / n, dt / n);
    }
  }

  // ------------------------------------------------------------ what the player does

  function touch() {
    // Caught in the act: they were moving, in daylight, and now they are not.
    if (g.D.freeze && g.D.byDay && g.dark < 0.5 && watched <= 0 && g.untouched > 2) {
      let moving = 0;
      em.forEachArchetype([Gnome], (_ids, n, field) => {
        const st = field(Gnome.state);
        for (let i = 0; i < n; i++) if (st[i] !== ST.IDLE && st[i] !== ST.POST) moving++;
      });
      if (moving) { s.stats.caught++; emit('caught', { n: moving }); }
    }
    watched = 2.6;
    g.untouched = 0;
  }

  function tap(x: number, y: number): 'pick' | 'greet' | 'weed' | 'catch' | 'peek' | 'wake' | 'none' {
    if (g.asleep) {
      // Sound asleep, to begin with. Later a noise on the lawn is enough.
      if (!s.flags.restless) return 'none';
      wake = 4;
      watched = 4;
      g.untouched = 0;
      g.asleep = false;
      g.blind = false;
      let moving = 0;
      em.forEachArchetype([Gnome], (_ids, n, field) => {
        const st = field(Gnome.state);
        for (let i = 0; i < n; i++) if (st[i] !== ST.IDLE && st[i] !== ST.POST && st[i] !== ST.DIG) moving++;
      });
      if (moving) { s.stats.caught++; emit('caught', { n: moving }); }
      emit('wake');
      return 'wake';
    }
    if (g.blind) {
      // Peeking: eyes open early, and whoever was moving is caught at it.
      lookBack();
      touch();
      return 'peek';
    }
    touch();
    g.look.x = x; g.look.y = y; g.look.age = 0;
    if (g.ending) return 'none';
    let did: 'pick' | 'greet' | 'weed' | 'catch' | 'peek' | 'wake' | 'none' = 'none';

    em.forEachArchetype([Pos, Critter], (ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), kind = field(Critter.kind), life = field(Critter.life);
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0 || Math.abs(px[i] - x) > 11 || Math.abs(py[i] - 4 - y) > 12) continue;
        life[i] = 0;
        caught(kind[i], px[i], py[i]);
        did = 'catch';
      }
    });
    if (did !== 'none') { flushSparks(); return did; }

    em.forEachArchetype([Pos, Visitor], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y);
      const st = field(Visitor.state), greeted = field(Visitor.greeted);
      for (let i = 0; i < n; i++) {
        if (greeted[i] || st[i] === VS.TAKEN) continue;
        if (Math.abs(px[i] - x) < 10 && y > py[i] - 34 && y < py[i] + 5) {
          greeted[i] = 1;
          greet(px[i], py[i]);
          did = 'greet';
        }
      }
    });
    if (did !== 'none') return did;

    for (let p = 0; p < s.plots; p++) {
      const at = PLOTS[p];
      if (Math.abs(at.x - x) > 9 || y < at.y - 16 || y > at.y + 6) continue;
      if (pullWeed(p)) {
        s.stats.weeds++;
        const amount = Math.max(2 * g.D.bloomMult, s.rate.blooms * 4);
        gain('blooms', amount, false);
        popup(at.x + 4, at.y - 8, '+' + fmtTiny(amount), 0);
        for (let k = 0; k < 4; k++) spark(at.x + 4, at.y - 3, (rand() - 0.5) * 30, -18 - rand() * 14, 80, 0.5, SPARK.leaf);
        emit('weed', { x: at.x, y: at.y });
        if (did === 'none') did = 'weed';
        continue;
      }
      if (!isRipe(p)) continue;
      fc.locate(plotId[p]);
      const kind = fc.Flower.kind;
      // Picking without a pause builds a streak; each flower in it is worth a little more.
      g.combo = s.clock - lastPick <= 1.6 ? g.combo + 1 : 1;
      lastPick = s.clock;
      if (g.combo > s.stats.bestStreak) s.stats.bestStreak = g.combo;
      for (const t of s.todo) if (t.kind === 'streak') t.have = Math.max(t.have, g.combo);
      const streak = 1 + Math.min(g.combo - 1, 30) * 0.08;
      const amount = (harvest(p) * g.D.bloomMult * g.D.tapMult + s.rate.blooms * g.D.tapSeconds) * streak;
      gain('blooms', amount, false);
      s.stats.tapped++;
      popup(at.x, at.y - 12, (g.combo >= 5 ? 'X' + g.combo + ' ' : '') + '+' + fmtTiny(amount), 0);
      for (let k = 0; k < 4; k++) spark(at.x, at.y - 7, (rand() - 0.5) * 34, -16 - rand() * 18, 70, 0.55, petalOf(kind));
      emit('pick', { x: at.x, y: at.y, n: kind });
      did = 'pick';
    }
    flushSparks();
    return did;
  }

  function buyPlot(n = 1): number {
    let dug = 0;
    while (dug < n && s.plots < MAX_PLOTS && pay(s, plotCost(s.plots))) {
      plant(s.plots, 0);
      burst(PLOTS[s.plots].x, PLOTS[s.plots].y, SPARK.leaf, 5, 16);
      s.plots++;
      dug++;
    }
    if (dug) emit('buy');
    return dug;
  }

  function maxPlots(): number {
    return maxAffordable((extra) => plotCost(s.plots + extra), MAX_PLOTS - s.plots);
  }

  function seedCost(): Cost | null {
    const next = FLOWERS[s.seed + 1];
    if (!next) return null;
    if (next.depth && s.depth < next.depth) return null;
    return next.cost;
  }

  function buySeed(): boolean {
    const c = seedCost();
    if (!c || !pay(s, c)) return false;
    s.seed++;
    const def = FLOWERS[s.seed];
    if (def.diary) log(def.diary);
    emit('buy');
    return true;
  }

  function maxAffordable(costAt: (extra: number) => Cost, limit: number): number {
    // Prices rise geometrically, so walking up from the current one is short.
    const purse: Record<Res, number> = { blooms: s.blooms, teeth: s.teeth, whispers: s.whispers, hats: s.hats };
    let n = 0;
    while (n < limit && n < 2000) {
      const c = costAt(n);
      let ok = true;
      for (const k in c) if (purse[k as Res] < c[k as Res]! - 1e-9) ok = false;
      if (!ok) break;
      for (const k in c) purse[k as Res] -= c[k as Res]!;
      n++;
    }
    return n;
  }

  function maxGnomes(id: RoleId): number {
    return maxAffordable((extra) => gnomeCost(s, id, extra), 2000);
  }

  function maxUpgrade(id: string): number {
    return maxAffordable((extra) => upgradeCost(s, id, extra), upgradeCap(s, id) - (s.up[id] ?? 0));
  }

  function buyGnome(id: RoleId, n = 1): number {
    let bought = 0;
    while (bought < n && pay(s, gnomeCost(s, id))) {
      s.bought[id]++;
      s.gnomes[id]++;
      bought++;
    }
    if (bought) {
      const before = roleIds[ROLE[id]].length;
      syncGnomes();
      const ids = roleIds[ROLE[id]];
      if (ids.length > before && s.peace > 60) {
        gc.locate(ids[ids.length - 1]);
        burst(gc.Pos.x, gc.Pos.y, SPARK.star, 5, 14);
      }
      refresh();
      emit('buy');
    }
    return bought;
  }

  function buyUpgrade(id: string, n = 1): number {
    const def = UPGRADE[id];
    let bought = 0;
    const cap = upgradeCap(s, id);
    while (bought < n && (s.up[id] ?? 0) < cap && pay(s, upgradeCost(s, id))) {
      s.up[id] = (s.up[id] ?? 0) + 1;
      bought++;
      if (s.up[id] === 1) {
        if (def.diary) log(def.diary);
        if (def.peace !== undefined) s.peaceCap = Math.min(s.peaceCap, def.peace);
        if (id === 'evening') log('The evenings are drawing in. I asked them to.', 'buy');
      }
      if (id === 'evening' && s.up[id] === 3) { log('It is always evening now.'); s.peaceCap = Math.min(s.peaceCap, 22); }
    }
    if (bought) { refresh(); emit(def.tab === 'rites' ? 'rite' : 'buy'); }
    return bought;
  }

  function buyHeirloom(id: string): boolean {
    const def = HEIRLOOMS.find((h) => h.id === id);
    if (!def || s.heir[id] || s.hats < def.cost) return false;
    s.hats -= def.cost;
    s.heir[id] = 1;
    refresh();
    emit('buy');
    return true;
  }

  function unearth(): boolean {
    if (g.ending || !s.flags.unearth || s.depth < UNEARTH_DEPTH || !pay(s, unearthCost())) return false;
    g.ending = { t: 0 };
    s.peaceCap = 0;
    log('I look so pleased with myself.');
    emit('ending');
    return true;
  }

  function away(seconds: number) {
    if (!(seconds > 20) || !s.flags.nightWork) return null;
    const D = g.D;
    const t = Math.min(seconds, D.offlineCap) * D.offline;
    const out = {
      seconds,
      blooms: s.rate.blooms * t,
      teeth: s.rate.teeth * t,
      whispers: s.rate.whispers * t,
      metres: 0,
    };
    gain('blooms', out.blooms, false);
    gain('teeth', out.teeth, false);
    gain('whispers', out.whispers, false);
    out.metres = addEffort(s.rate.effort * t);
    s.day += Math.floor(seconds / (D.dayLen + Math.min(D.nightLen, 120)));
    if (out.blooms > 0) log(mood(AWAY, s.peace), 'away');
    // They have all moved.
    em.forEachArchetype([Pos, Gnome], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), hx = field(Gnome.hx), hy = field(Gnome.hy);
      const st = field(Gnome.state), load = field(Gnome.load);
      for (let i = 0; i < n; i++) if (st[i] === ST.IDLE || st[i] === ST.TO_HOME || st[i] === ST.POST) { px[i] = hx[i]; py[i] = hy[i]; load[i] = 0; }
    });
    story();
    return out;
  }

  function save(): string {
    s.lastSeen = Date.now();
    return JSON.stringify(s);
  }

  function wipe() {
    load(newState());
  }

  load(s);
  return g;
}

export { UPGRADES, LAWN_TOP, HOLE_RY };
