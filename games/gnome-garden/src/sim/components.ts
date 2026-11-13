// The garden's entities. A gnome, a flower, a visitor and a spark are each a
// handful of columns; the queries in game.ts run over them.
import { component, vec2 } from 'archetype-ecs';

/** Where something stands: the point between its feet, in world pixels. */
export const Pos = component('Pos', vec2);

/** Walking: head for (tx, ty) at `speed` pixels a second. */
export const Move = component('Move', { tx: 'f32', ty: 'f32', speed: 'f32' });

export const Gnome = component('Gnome', {
  role: 'u8',      // ROLE in content.ts
  state: 'u8',     // ST below
  look: 'u8',      // which coat and hat
  load: 'u8',      // flowers in the basket
  face: 'i8',      // -1 left, 1 right
  plot: 'i16',     // the flower it is after, -1 for none
  idx: 'i32',      // its number within its role; picks where it stands
  timer: 'f32',
  carry: 'f32',    // value in the basket
  seed: 'f32',     // 0..1, fixed per gnome
  hx: 'f32',       // where it stands when it has nothing to do
  hy: 'f32',
  walked: 'f32',   // distance covered, for the walk cycle
});

export const Flower = component('Flower', {
  plot: 'i16',
  kind: 'u8',
  claimed: 'u8',   // a gnome is on its way
  weed: 'u8',      // something is growing here that was not planted
  growth: 'f32',   // 0..1, ripe at 1
  rate: 'f32',     // growth per second before multipliers
});

export const Visitor = component('Visitor', {
  kind: 'u8',
  state: 'u8',     // VS below
  step: 'u8',      // which leg of the walk it is on
  greeted: 'u8',
  face: 'i8',
  timer: 'f32',
  seed: 'f32',
  walked: 'f32',
});

/** Something passing through that can be caught with a tap: a butterfly, a firefly, a mound, a crow, a glint. */
export const Critter = component('Critter', { kind: 'u8', life: 'f32', timer: 'f32', seed: 'f32' });

export const CRITTER = { butterfly: 0, firefly: 1, mound: 2, crow: 3, glint: 4 } as const;

/** A petal, a clod of earth, a mote: falls, fades, is gone. */
export const Spark = component('Spark', { vx: 'f32', vy: 'f32', g: 'f32', life: 'f32', kind: 'u8' });

export const ST = {
  IDLE: 0, TO_FLOWER: 1, PICK: 2, TO_BASKET: 3, TO_HOME: 4,
  TO_HOLE: 5, DIG: 6, TO_JAR: 7, POST: 8, LURE: 9,
} as const;

export const VS = { ENTER: 0, BROWSE: 1, LEAVE: 2, TAKEN: 3 } as const;

export const SPARK = { petal: 0, yellow: 1, pink: 2, red: 3, dirt: 4, heart: 5, tooth: 6, whisper: 7, leaf: 8, star: 9, water: 10 } as const;
