// A model's shapes as faces: flat-coloured triangles, with the outlines of the
// faces they were made from (quads where it can), so a wireframe shows how the
// lines run and not how the quads were split. A group with a bone is a piece of
// its own, in the bone's own space, so it can be turned at its joint: posed()
// puts every piece where its bones have it at a moment of an animation (none:
// at rest, as it is written). The renders (render.ts), the .glb (glb.ts) and the
// Art tab all start from here.
import type { Anim, Caps, Key, Model, Part, Ring, Vec3 } from './format.ts';

/** A 3×4 matrix: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Mat = number[];

/** A joint: where it sits on its parent (-1: on the model itself) at rest, as a place, a turn and a size. */
export interface Bone { name: string; parent: number; pos: Vec3; quat: [number, number, number, number]; scale: Vec3 }

/** What hangs on one bone (bone -1: on the model itself): its triangles and the outlines of its faces, in the bone's own space. */
/** What hangs on one bone (bone -1: on the model itself): its triangles, which shape each is of (in the order they are written), and the outlines of its faces, in the bone's own space. */
export interface Piece { bone: number; positions: number[]; colors: number[]; shapes: number[]; edges: number[] }

/** A shape as it is written: what kind it is, its name when it has one, its colour, and the bone it hangs on. */
export interface ShapeOf { kind: string; name?: string; color: string; bone: number }

export interface Built { model: Model; bones: Bone[]; pieces: Piece[]; triangles: number; shapes: ShapeOf[] }

type Face = number[][];

export function buildModel(model: Model): Built {
  const bones: Bone[] = [], pieces = new Map<number, Piece>();
  const piece = (bone: number) => {
    let p = pieces.get(bone);
    if (!p) { p = { bone, positions: [], colors: [], shapes: [], edges: [] }; pieces.set(bone, p); }
    return p;
  };
  let triangles = 0, shapes = 0;
  const kinds: ShapeOf[] = [];
  const walk = (parts: Part[], m: Mat, color: string, bone: number) => {
    for (const part of parts) {
      const here = multiply(m, compose(part.pos, part.rot, part.scale));
      const c = part.color ?? color;
      if ('group' in part) {
        if (part.bone) {
          // A joint: it sits where the group is, and what is in it is in its own space from here.
          bones.push({ name: part.bone, parent: bone, ...decompose(here) });
          walk(part.group, identity(), c, bones.length - 1);
        } else walk(part.group, here, c, bone);
        continue;
      }
      const out = piece(bone), rgb = hexToRgb(c), shape = shapes++;
      kinds.push({ kind: part.shape, ...(part.name && { name: part.name }), color: c, bone });
      // (A mirrored part turns its faces inside out: they are turned back.)
      const flip = det(here) < 0;
      for (const face of faces(part)) {
        const v = (flip ? [...face].reverse() : face).map((p) => transform(here, p));
        for (let i = 1; i + 1 < v.length; i++) { for (const p of [v[0], v[i], v[i + 1]]) { out.positions.push(p[0], p[1], p[2]); out.colors.push(...rgb); } out.shapes.push(shape); }
        triangles += v.length - 2;
        for (let i = 0; i < v.length; i++) out.edges.push(...v[i], ...v[(i + 1) % v.length]);
      }
    }
  };
  walk(model.parts, identity(), '#cccccc', -1);
  return { model, bones, pieces: [...pieces.values()].sort((a, b) => a.bone - b.bone), triangles, shapes: kinds };
}

/** Where each bone is in the model at a moment of an animation (t from 0 to 1 of its loop); at rest without one. */
export function boneMatrices(built: Built, anim?: string, t = 0): Mat[] {
  const a: Anim | undefined = anim ? built.model.anims[anim] : undefined;
  const world: Mat[] = [];
  built.bones.forEach((b, i) => {
    const k = a?.keys[b.name] ? sample(a.keys[b.name], t) : undefined;
    const pos: Vec3 = k?.pos ? [b.pos[0] + k.pos[0], b.pos[1] + k.pos[1], b.pos[2] + k.pos[2]] : b.pos;
    const quat = k?.rot ? qmul(b.quat, eulerQuat(k.rot)) : b.quat;
    const local = trs(pos, quat, b.scale);
    world[i] = b.parent < 0 ? local : multiply(world[b.parent], local);
  });
  return world;
}

/** The model as it stands at a moment of an animation (or at rest), in one: its triangles, their colours and the outlines of its faces. */
export function posed(built: Built, anim?: string, t = 0) {
  const at = boneMatrices(built, anim, t);
  const count = (k: 'positions' | 'edges') => built.pieces.reduce((n, p) => n + p[k].length, 0);
  const positions = new Float32Array(count('positions')), colors = new Float32Array(count('positions')), edges = new Float32Array(count('edges'));
  const shapes = new Uint32Array(count('positions') / 9);
  let o = 0, e = 0;
  for (const p of built.pieces) {
    const m = p.bone < 0 ? undefined : at[p.bone];
    const put = (from: number[], to: Float32Array, start: number) => {
      for (let i = 0; i < from.length; i += 3) {
        const v = m ? transform(m, [from[i], from[i + 1], from[i + 2]]) : [from[i], from[i + 1], from[i + 2]];
        to[start + i] = v[0]; to[start + i + 1] = v[1]; to[start + i + 2] = v[2];
      }
    };
    put(p.positions, positions, o);
    colors.set(p.colors, o);
    shapes.set(p.shapes, o / 9);
    put(p.edges, edges, e);
    o += p.positions.length; e += p.edges.length;
  }
  return { positions, colors, shapes, edges, bones: at };
}

/** The box the model stands in at rest: its lowest and highest corner. */
export function boxOf(built: Built): { min: Vec3; max: Vec3 } {
  const { positions } = posed(built);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Where a bone's keys have it at t: between the keys around t, and from the last back to the first. */
export function sample(keys: Key[], t: number): { rot?: Vec3; pos?: Vec3 } {
  if (keys.length === 1) return keys[0];
  t = ((t % 1) + 1) % 1;
  let i = keys.findIndex((k) => k.t > t);
  // (Before the first key or after the last: between the last and the first, round the end of the loop.)
  const a = i <= 0 ? keys.at(-1)! : keys[i - 1], b = i <= 0 ? keys[0] : keys[i];
  const span = i <= 0 ? 1 - a.t + b.t : b.t - a.t;
  const f = span <= 0 ? 0 : (i <= 0 ? (t >= a.t ? t - a.t : t + 1 - a.t) : t - a.t) / span;
  const mix = (p?: Vec3, q?: Vec3): Vec3 | undefined => (p || q ? [0, 1, 2].map((k) => (p?.[k] ?? 0) + ((q?.[k] ?? 0) - (p?.[k] ?? 0)) * f) as Vec3 : undefined);
  return { rot: mix(a.rot, b.rot), pos: mix(a.pos, b.pos) };
}

// ---------------------------------------------------------------- the shapes

function faces(part: Part): Face[] {
  if ('group' in part) return [];
  switch (part.shape) {
    case 'loft': return loft(part.rings, part.segments ?? 8, part.caps ?? 'both');
    case 'tube': return tube(part.path, part.radii, part.segments ?? 6, part.caps ?? 'both', !!part.loop);
    case 'extrude': return extrude(part.outline, part.depth ?? 1);
    case 'box': return box(part.size ?? [1, 1, 1]);
    case 'wedge': return wedge(part.size ?? [1, 1, 1]);
    case 'cylinder': return cylinder(part.radiusTop ?? 0.5, part.radiusBottom ?? 0.5, part.height ?? 1, part.segments ?? 6);
    case 'sphere': return sphere(part.radius ?? 0.5, part.detail ?? 0);
  }
}

function bridge(rings: number[][][]): Face[] {
  const out: Face[] = [];
  for (let r = 0; r + 1 < rings.length; r++) {
    const lo = rings[r], hi = rings[r + 1], n = lo.length;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; out.push([lo[i], lo[j], hi[j], hi[i]]); }
  }
  return out;
}

/** Which ends of a tube or a loft are closed. */
const closes = (caps: Caps, end: 'start' | 'end') => caps === 'both' || caps === end;

function loft(rings: Ring[], n: number, ends: Caps): Face[] {
  const verts = rings.map(({ y, x = 0, z = 0, rx, rz = rx, outline }) => (outline
    ? outline.map(([ox, oz]) => [x + ox, y, z + oz])
    : Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [x + Math.sin(a) * rx, y, z + Math.cos(a) * rz];
    })));
  // (The rings go up or down; either way the caps face outward.)
  const up = rings.at(-1)!.y >= rings[0].y;
  const caps = [...(closes(ends, 'start') && rings[0].rx > 0 ? [[...verts[0]].reverse()] : []), ...(closes(ends, 'end') && rings.at(-1)!.rx > 0 ? [verts.at(-1)!] : [])];
  const sides = bridge(verts);
  return up ? [...sides, ...caps] : [...sides, ...caps].map((f) => [...f].reverse());
}

function tube(path: Vec3[], radii: number[], n: number, ends: Caps, loop = false): Face[] {
  // A loop goes round: its last point runs on into its first (written twice, it is there once).
  let pts = path;
  if (loop && pts.length > 3 && Math.hypot(...sub(pts[0], pts.at(-1)!)) < 1e-9) pts = pts.slice(0, -1);
  const N = pts.length;
  const at = (k: number) => (loop ? pts[(k + N) % N] : pts[Math.max(0, Math.min(N - 1, k))]);
  const dirs = pts.map((_, k) => norm(sub(at(k + 1), at(k - 1))));
  // Each ring stands across the path there; its sides turn along with the path, so the quads do not twist.
  const sides: number[][] = [];
  let side = norm(cross(dirs[0], Math.abs(dirs[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  for (let k = 0; k < N; k++) { side = norm(cross(cross(dirs[k], side), dirs[k])); sides.push(side); }
  if (loop) {
    // Round the loop the sides have turned a little by the time they are back: that turn is spread over the rings, so the last quads meet the first.
    const back = norm(cross(cross(dirs[0], sides[N - 1]), dirs[0]));
    const turned = Math.atan2(dot(cross(sides[0], back), dirs[0]), dot(sides[0], back));
    for (let k = 0; k < N; k++) {
      const a = (-turned * k) / N, d = dirs[k], v = sides[k], w = cross(d, v);
      sides[k] = [v[0] * Math.cos(a) + w[0] * Math.sin(a), v[1] * Math.cos(a) + w[1] * Math.sin(a), v[2] * Math.cos(a) + w[2] * Math.sin(a)];
    }
  }
  const rings = pts.map((p, k) => {
    const s0 = sides[k], up = cross(s0, dirs[k]), r = radii[k] ?? radii[radii.length - 1];
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2, s = Math.sin(a) * r, c = Math.cos(a) * r;
      return [p[0] + s0[0] * s + up[0] * c, p[1] + s0[1] * s + up[1] * c, p[2] + s0[2] * s + up[2] * c];
    });
  });
  if (loop) return [...bridge(rings), ...bridge([rings[N - 1], rings[0]])];
  // (An end with radius 0 is a point: there is nothing to close.)
  const start = closes(ends, 'start') && radii[0] > 0 ? [[...rings[0]].reverse()] : [];
  const tip = closes(ends, 'end') && (radii[N - 1] ?? radii[radii.length - 1]) > 0 ? [rings[N - 1]] : [];
  return [...bridge(rings), ...start, ...tip];
}

function extrude(outline: [number, number][], depth: number): Face[] {
  // (An outline drawn the other way round is turned, so its faces look outward.)
  let area = 0;
  for (let i = 0; i < outline.length; i++) { const [x1, y1] = outline[i], [x2, y2] = outline[(i + 1) % outline.length]; area += x1 * y2 - x2 * y1; }
  const ring = area < 0 ? [...outline].reverse() : outline, z = depth / 2;
  const front = ring.map(([x, y]) => [x, y, z]), back = ring.map(([x, y]) => [x, y, -z]);
  return [...bridge([back, front]), ...fan(front), ...fan([...back].reverse())];
}

/** A flat face that need not be convex, as triangles (ear by ear), so a gable or an L stays what it is. */
function fan(poly: number[][]): Face[] {
  // (Its normal, by Newell's way: right for any flat polygon, convex or not.)
  const n = norm(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return [s[0] + (p[1] - q[1]) * (p[2] + q[2]), s[1] + (p[2] - q[2]) * (p[0] + q[0]), s[2] + (p[0] - q[0]) * (p[1] + q[1])]; }, [0, 0, 0]));
  const turns = (a: number[], b: number[], c: number[]) => dot(cross(sub(b, a), sub(c, b)), n);
  if (poly.every((_, i) => turns(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]) >= -1e-12)) return [poly];
  const idx = poly.map((_, i) => i), out: Face[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = poly[idx[(k + idx.length - 1) % idx.length]], b = poly[idx[k]], c = poly[idx[(k + 1) % idx.length]];
      if (turns(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => ![a, b, c].includes(poly[j]) && inside(poly[j], a, b, c, n))) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length >= 3) out.push(idx.map((i) => poly[i]));
  return out;
}
function inside(p: number[], a: number[], b: number[], c: number[], n: number[]) {
  const s = (u: number[], v: number[]) => dot(cross(sub(v, u), sub(p, u)), n);
  return s(a, b) >= 0 && s(b, c) >= 0 && s(c, a) >= 0;
}

function box([w, h, d]: Vec3): Face[] {
  const x = w / 2, y = h / 2, z = d / 2;
  const p = (sx: number, sy: number, sz: number) => [sx * x, sy * y, sz * z];
  return [
    [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)],
    [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)],
    [p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1)],
    [p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1)],
    [p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)],
    [p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1)],
  ];
}

function wedge([w, h, d]: Vec3): Face[] {
  const x = w / 2, y = h / 2, z = d / 2;
  const fl = [-x, -y, z], fr = [x, -y, z], bl = [-x, -y, -z], br = [x, -y, -z], tl = [-x, y, 0], tr = [x, y, 0];
  return [[fl, fr, tr, tl], [br, bl, tl, tr], [fr, br, tr], [bl, fl, tl], [bl, br, fr, fl]];
}

function cylinder(rt: number, rb: number, h: number, n: number): Face[] {
  const ring = (r: number, y: number) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.sin(a) * r, y, Math.cos(a) * r]; });
  const top = ring(rt, h / 2), bottom = ring(rb, -h / 2), out: Face[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push(rt > 0 && rb > 0 ? [bottom[i], bottom[j], top[j], top[i]] : rt > 0 ? [bottom[i], top[j], top[i]] : [bottom[i], bottom[j], top[i]]);
  }
  if (rt > 0) out.push(top);
  if (rb > 0) out.push([...bottom].reverse());
  return out;
}

function sphere(r: number, detail: number): Face[] {
  const t = (1 + Math.sqrt(5)) / 2;
  const unit = (p: number[]) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(unit);
  let tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]].map((f) => f.map((i) => v[i]));
  for (let d = 0; d < Math.round(detail); d++) {
    tris = tris.flatMap(([a, b, c]) => {
      const ab = unit(mid(a, b)), bc = unit(mid(b, c)), ca = unit(mid(c, a));
      return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
    });
  }
  return tris.map((f) => f.map((p) => [p[0] * r, p[1] * r, p[2] * r]));
}
const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

// ---------------------------------------------------------------- numbers

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const identity = (): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** A place, a turn (degrees around x, then y, then z: R = Rx·Ry·Rz) and a size, as one matrix. */
export function compose(pos: Vec3 = [0, 0, 0], rot: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): Mat {
  const [ax, ay, az] = rot.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const r = [cy * cz, -cy * sz, sy, sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy, -cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy];
  const [kx, ky, kz] = scale;
  return [r[0] * kx, r[1] * ky, r[2] * kz, pos[0], r[3] * kx, r[4] * ky, r[5] * kz, pos[1], r[6] * kx, r[7] * ky, r[8] * kz, pos[2]];
}

export function multiply(a: Mat, b: Mat): Mat {
  const out = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++)
    out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + (j === 3 ? a[i * 4 + 3] : 0);
  return out;
}

export const transform = (m: Mat, [x, y, z]: number[]) => [
  m[0] * x + m[1] * y + m[2] * z + m[3],
  m[4] * x + m[5] * y + m[6] * z + m[7],
  m[8] * x + m[9] * y + m[10] * z + m[11],
];

const det = (m: Mat) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

type Quat = [number, number, number, number];
/** A turn in degrees (Rx·Ry·Rz, as compose has it) as a quaternion [x, y, z, w]. */
export function eulerQuat(rot: Vec3): Quat {
  const half = rot.map((d) => (d * Math.PI) / 360);
  const q = (axis: number, a: number): Quat => { const s = Math.sin(a); return [axis === 0 ? s : 0, axis === 1 ? s : 0, axis === 2 ? s : 0, Math.cos(a)]; };
  return qmul(qmul(q(0, half[0]), q(1, half[1])), q(2, half[2]));
}
export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** A matrix as a place, a turn and a size (a mirror is a size below 0 along x). */
function decompose(m: Mat): { pos: Vec3; quat: Quat; scale: Vec3 } {
  const col = (j: number) => [m[j], m[4 + j], m[8 + j]];
  let sx = Math.hypot(...col(0));
  const sy = Math.hypot(...col(1)), sz = Math.hypot(...col(2));
  if (det(m) < 0) sx = -sx;
  const r = [m[0] / sx, m[1] / sy, m[2] / sz, m[4] / sx, m[5] / sy, m[6] / sz, m[8] / sx, m[9] / sy, m[10] / sz];
  const tr = r[0] + r[4] + r[8];
  let q: Quat;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s, s / 4]; }
  else if (r[0] > r[4] && r[0] > r[8]) { const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; q = [s / 4, (r[1] + r[3]) / s, (r[2] + r[6]) / s, (r[7] - r[5]) / s]; }
  else if (r[4] > r[8]) { const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; q = [(r[1] + r[3]) / s, s / 4, (r[5] + r[7]) / s, (r[2] - r[6]) / s]; }
  else { const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2; q = [(r[2] + r[6]) / s, (r[5] + r[7]) / s, s / 4, (r[3] - r[1]) / s]; }
  return { pos: [m[3], m[7], m[11]], quat: q, scale: [sx, sy, sz] };
}

/** A place, a quaternion and a size as one matrix (T·R·S, as glTF has it). */
export function trs(pos: Vec3, [x, y, z, w]: Quat, [kx, ky, kz]: Vec3): Mat {
  return [
    (1 - 2 * (y * y + z * z)) * kx, 2 * (x * y - z * w) * ky, 2 * (x * z + y * w) * kz, pos[0],
    2 * (x * y + z * w) * kx, (1 - 2 * (x * x + z * z)) * ky, 2 * (y * z - x * w) * kz, pos[1],
    2 * (x * z - y * w) * kx, 2 * (y * z + x * w) * ky, (1 - 2 * (x * x + y * y)) * kz, pos[2],
  ];
}

/** A colour of its own for every shape: hues a golden turn apart, so shapes written one after the other are far apart in colour. */
export function loud(n: number): number[] {
  const h = (n * 0.618034) % 1, s = 0.75, l = n % 2 ? 0.6 : 0.48;
  const k = (m: number) => (m + h * 12) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((m) => l - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1)));
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
