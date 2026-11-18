// A 3D model as a drawing of the project: art/<name>.txt, a short JavaScript
// that starts with the line `// @model` and gives back (export default) a list
// of simple shapes. It is a program and not a list because a model is made of
// many alike things (planks, shingles, toes): a loop writes them, a function
// makes a leg that is used twice. It runs where it cannot do anything else
// (evaluate.ts), and what comes out is checked here: only shapes, numbers and
// colours go further.
//
// A part is one of:
//   { shape: 'box',      size: [w, h, d] }
//   { shape: 'wedge',    size: [w, h, d] }        a gable roof: its ridge along x, on top
//   { shape: 'cylinder', radiusTop, radiusBottom, height, segments }   radiusTop 0 is a cone
//   { shape: 'sphere',   radius, detail }         a low poly ball; detail 0 to 3 makes it rounder
//   { shape: 'loft',     rings: [{ y, x, z, rx, rz }], segments }
//                        one tube through rings stacked along y (rings() makes them from silhouettes);
//                        a ring may have an outline [[x, z], ...] instead: any shape, so a ridge or a groove is in it
//   { shape: 'tube',     path: [[x, y, z]], radii: [r], segments }
//                        a tube along a bent path, a ring at every point (toes, tails, horns,
//                        a hat from its brim to its tip); a radius 0 ends it in a point
//   a tube with loop: true goes round: its last point runs on into its first, without a seam
//                        (a scarf, a belt, a ring, a wreath)
//   a loft or a tube may say caps: 'both' (the default), 'start', 'end' or 'none': which ends are
//   closed. A hat, a sleeve, a vase is open where something goes in.
//   { shape: 'extrude',  outline: [[x, y]], depth }   a flat outline pushed out along z, centred
//   { group: [parts], bone }                     parts that go together; with a bone they move together
// and each may have pos [x, y, z], rot [x, y, z] in degrees, scale [x, y, z] and color '#rrggbb'.
// A group's colour is what its parts have unless they say otherwise. y is up, the front faces +z,
// it stands on y 0.
//
// A group with a bone is a joint: it turns around its pos, and the bones in it hang on it. Its
// animations say per bone how it turns (and shifts) at moments of one loop:
//   anims: { walk: { seconds: 1, keys: { 'leg-left': [{ t: 0, rot: [20, 0, 0] }, { t: 0.5, rot: [-20, 0, 0] }] } } }
// t from 0 to 1; the loop goes from the last key back to the first.

export type Vec3 = [number, number, number];

/**
 * A ring of a loft: an ellipse rx wide and rz deep round (x, z) at height y; or, with outline, any shape: its points
 * [x, z] round that middle, from the front (+z) going to the right (+x), the same number in every ring of the loft.
 * So a ridge, a groove, a brow or the edge of a visor is in the surface itself.
 */
export interface Ring { y: number; x?: number; z?: number; rx: number; rz?: number; outline?: [number, number][] }

interface Placed { pos?: Vec3; rot?: Vec3; scale?: Vec3; color?: string; name?: string }
export type Shape =
  | { shape: 'box' | 'wedge'; size?: Vec3 }
  | { shape: 'cylinder'; radiusTop?: number; radiusBottom?: number; height?: number; segments?: number }
  | { shape: 'sphere'; radius?: number; detail?: number }
  | { shape: 'loft'; rings: Ring[]; segments?: number; caps?: Caps }
  | { shape: 'tube'; path: Vec3[]; radii: number[]; segments?: number; caps?: Caps; loop?: boolean }
  | { shape: 'extrude'; outline: [number, number][]; depth?: number };
export type Caps = 'both' | 'start' | 'end' | 'none';
export type Part = Placed & (Shape | { group: Part[]; bone?: string });

export interface Key { t: number; rot?: Vec3; pos?: Vec3 }
export interface Anim { seconds: number; keys: Record<string, Key[]> }
export interface Model { parts: Part[]; anims: Record<string, Anim> }

/** A pair of silhouettes rings() was given: shown beside the model, so who watches sees what the tube was made from. */
export interface Profile { front: string[]; side: string[]; rows?: [number, number]; name?: string }

export const isModel = (text: string) => /^\s*\/\/\s*@model\b/.test(text);

const SHAPES = ['box', 'wedge', 'cylinder', 'sphere', 'loft', 'tube', 'extrude'];
const NAME = /^[a-z][a-z0-9-]*$/;

/**
 * What a model's program gave back, checked: a model, or an error that says where it is wrong. Lenient (a model as
 * it is being typed): a part or an animation that is not right yet is left out, and the rest is the model so far.
 */
export function checkModel(raw: unknown, lenient = false): Model {
  const fail = (at: string, what: string): never => { throw new Error(`${at}: ${what}`); };
  const obj = (v: unknown, at: string) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(at, 'is not an object'));
  const num = (v: unknown, at: string) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(at, `is not a number (${JSON.stringify(v)})`));
  const vec = (v: unknown, at: string): Vec3 => (Array.isArray(v) && v.length === 3 ? v.map((n, i) => num(n, `${at}[${i}]`)) as Vec3 : fail(at, 'is not [x, y, z]'));
  const list = (v: unknown, at: string) => (Array.isArray(v) ? v : fail(at, 'is not a list'));
  const bones = new Set<string>();
  let count = 0;

  function part(v: unknown, at: string): Part {
    const p = obj(v, at);
    if (++count > 20_000) fail(at, 'a model has at most 20000 parts');
    const out: Record<string, unknown> = {};
    for (const k of ['pos', 'rot', 'scale'] as const) if (p[k] !== undefined) out[k] = vec(p[k], `${at}.${k}`);
    if (p.color !== undefined) out.color = typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : fail(`${at}.color`, `is not a colour like #a07040 (${JSON.stringify(p.color)})`);
    if (typeof p.name === 'string') out.name = p.name;
    if (p.group !== undefined) {
      if (p.bone !== undefined) {
        const b = typeof p.bone === 'string' && NAME.test(p.bone) ? p.bone : fail(`${at}.bone`, 'is named in lower-case words with dashes');
        if (bones.has(b)) fail(`${at}.bone`, `there is another bone called ${b}`);
        bones.add(b);
        out.bone = b;
      }
      out.group = parts(p.group, `${at}.group`);
      return out as unknown as Part;
    }
    const shape = typeof p.shape === 'string' && SHAPES.includes(p.shape) ? p.shape : fail(`${at}.shape`, `is not one of ${SHAPES.join(', ')} (${JSON.stringify(p.shape)}), and there is no group`);
    out.shape = shape;
    const opt = (k: string, min = -Infinity) => { if (p[k] !== undefined) { out[k] = num(p[k], `${at}.${k}`); if ((out[k] as number) < min) fail(`${at}.${k}`, `is less than ${min}`); } };
    const caps = () => { if (p.caps !== undefined) out.caps = ['both', 'start', 'end', 'none'].includes(p.caps as string) ? p.caps : fail(`${at}.caps`, 'is both, start, end or none'); };
    const segments = () => { opt('segments', 3); if (out.segments !== undefined && (out.segments as number) > 64) fail(`${at}.segments`, 'is more than 64'); };
    if (shape === 'box' || shape === 'wedge') { if (p.size !== undefined) out.size = vec(p.size, `${at}.size`); }
    else if (shape === 'cylinder') { opt('radiusTop', 0); opt('radiusBottom', 0); opt('height'); segments(); }
    else if (shape === 'sphere') { opt('radius', 0); opt('detail', 0); if ((out.detail as number) > 3) fail(`${at}.detail`, 'is at most 3'); }
    else if (shape === 'loft') {
      const rings = list(p.rings, `${at}.rings`);
      if (rings.length < 2) fail(`${at}.rings`, 'a loft needs at least two rings');
      caps();
      let points = 0;
      out.rings = rings.map((r, i) => {
        const o = obj(r, `${at}.rings[${i}]`), here = `${at}.rings[${i}]`;
        let outline: [number, number][] | undefined;
        if (o.outline !== undefined) {
          outline = list(o.outline, `${here}.outline`).map((q, j) => (Array.isArray(q) && q.length === 2 ? [num(q[0], `${here}.outline[${j}][0]`), num(q[1], `${here}.outline[${j}][1]`)] : fail(`${here}.outline[${j}]`, 'is not [x, z]')));
          if (outline.length < 3) fail(`${here}.outline`, 'an outline needs at least three points');
          if (points && outline.length !== points) fail(`${here}.outline`, `has ${outline.length} points, and the rings before it ${points}: every ring of a loft has the same number`);
          points = outline.length;
        }
        const ring: Ring = { y: num(o.y, `${here}.y`), rx: outline && o.rx === undefined ? Math.max(...outline.map(([x, z]) => Math.hypot(x, z))) : num(o.rx, `${here}.rx`) };
        for (const k of ['x', 'z', 'rz'] as const) if (o[k] !== undefined) ring[k] = num(o[k], `${here}.${k}`);
        if (outline) ring.outline = outline;
        return ring;
      });
      segments();
      // (Rings with an outline say how many points round every ring has.)
      if (points) out.segments = points;
    } else if (shape === 'tube') {
      out.path = list(p.path, `${at}.path`).map((q, i) => vec(q, `${at}.path[${i}]`));
      if ((out.path as Vec3[]).length < 2) fail(`${at}.path`, 'a tube needs at least two points');
      caps();
      if (p.loop !== undefined) { out.loop = p.loop === true; if (out.loop && (out.path as Vec3[]).length < 3) fail(`${at}.path`, 'a loop needs at least three points'); }
      out.radii = list(p.radii, `${at}.radii`).map((r, i) => num(r, `${at}.radii[${i}]`));
      if (!(out.radii as number[]).length) fail(`${at}.radii`, 'a tube needs at least one radius');
      segments();
    } else {
      out.outline = list(p.outline, `${at}.outline`).map((q, i) => (Array.isArray(q) && q.length === 2 ? [num(q[0], `${at}.outline[${i}][0]`), num(q[1], `${at}.outline[${i}][1]`)] : fail(`${at}.outline[${i}]`, 'is not [x, y]')));
      if ((out.outline as unknown[]).length < 3) fail(`${at}.outline`, 'an outline needs at least three points');
      opt('depth');
    }
    return out as unknown as Part;
  }

  function parts(v: unknown, at: string): Part[] {
    return list(v, at).flatMap((q, i) => {
      if (!lenient) return [part(q, `${at}[${i}]`)];
      try { return [part(q, `${at}[${i}]`)]; } catch { return []; }
    });
  }
  const m = obj(raw, 'the model (export default)');
  const all = parts(m.parts, 'parts');
  if (!all.length) fail('parts', 'there are none');
  const anims: Record<string, Anim> = {};
  if (m.anims !== undefined) for (const [name, a] of Object.entries(obj(m.anims, 'anims'))) try {
    const at = `anims.${name}`;
    if (!NAME.test(name)) fail(at, 'an animation is named in lower-case words with dashes');
    const o = obj(a, at);
    const seconds = num(o.seconds, `${at}.seconds`);
    if (seconds <= 0) fail(`${at}.seconds`, 'is not more than 0');
    const keys: Record<string, Key[]> = {};
    for (const [bone, list_] of Object.entries(obj(o.keys, `${at}.keys`))) {
      if (!bones.has(bone)) fail(`${at}.keys.${bone}`, `there is no bone called ${bone}; there are: ${[...bones].join(', ') || 'none (a group with bone: makes one)'}`);
      keys[bone] = list(list_, `${at}.keys.${bone}`).map((k, i) => {
        const ko = obj(k, `${at}.keys.${bone}[${i}]`), key: Key = { t: num(ko.t, `${at}.keys.${bone}[${i}].t`) };
        if (key.t < 0 || key.t > 1) fail(`${at}.keys.${bone}[${i}].t`, 'is a moment of the loop, from 0 to 1');
        if (ko.rot !== undefined) key.rot = vec(ko.rot, `${at}.keys.${bone}[${i}].rot`);
        if (ko.pos !== undefined) key.pos = vec(ko.pos, `${at}.keys.${bone}[${i}].pos`);
        return key;
      }).sort((a, b) => a.t - b.t);
      if (!keys[bone].length) fail(`${at}.keys.${bone}`, 'has no keys');
    }
    anims[name] = { seconds, keys };
  } catch (e) { if (!lenient) throw e; }
  return { parts: all, anims };
}

/** The bones of a model, in the order they are written. */
export function bonesOf(parts: Part[], out: string[] = []): string[] {
  for (const p of parts) if ('group' in p) { if (p.bone) out.push(p.bone); bonesOf(p.group, out); }
  return out;
}

/** How many shapes a model is made of. */
export const shapesOf = (parts: Part[]): number => parts.reduce((n, p) => n + ('group' in p ? shapesOf(p.group) : 1), 0);
