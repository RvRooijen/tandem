// Where one shape goes through another, measured instead of looked for: every
// two triangles of different shapes whose surfaces cross, summed per pair of
// shapes into how long the line is where they cross, and where. A renders shows
// it only to who sees it; this says it, so it cannot be missed. Not every crossing
// is wrong (an arm that grows out of a shoulder starts inside it), so each is
// for whoever makes the model to name: meant, or a fix.
import type { Vec3 } from './format.ts';
import { posed, type Built } from './shapes.ts';

export interface Clip {
  /** The two shapes, by their place in the order they are written (from 0). */
  a: number; b: number;
  /** How long the line is where their surfaces cross, in the model's units. */
  length: number;
  /** The middle of that line, and the box round it. */
  at: Vec3; min: Vec3; max: Vec3;
  /** The line itself, in pieces: x, y, z of both ends of each (at most a few hundred), to draw. */
  lines: number[];
}

type P = number[];
const sub = (a: P, b: P) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P, b: P) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where the surfaces of two triangles cross: a piece of line, or nothing. */
function crossing(A: P[], B: P[], eps: number): [P, P] | null {
  const nA = cross(sub(A[1], A[0]), sub(A[2], A[0])), nB = cross(sub(B[1], B[0]), sub(B[2], B[0]));
  const lA = Math.hypot(nA[0], nA[1], nA[2]), lB = Math.hypot(nB[0], nB[1], nB[2]);
  if (lA < 1e-14 || lB < 1e-14) return null;
  const dB = B.map((p) => dot(nA, sub(p, A[0])) / lA), dA = A.map((p) => dot(nB, sub(p, B[0])) / lB);
  // (All on one side of the other's plane, or lying in it: they do not cross.)
  if (dB.every((d) => d > eps) || dB.every((d) => d < -eps) || dA.every((d) => d > eps) || dA.every((d) => d < -eps)) return null;
  if (dB.every((d) => Math.abs(d) <= eps) || dA.every((d) => Math.abs(d) <= eps)) return null;
  const inside = (p: P, T: P[], n: P) => [0, 1, 2].every((i) => dot(cross(sub(T[(i + 1) % 3], T[i]), sub(p, T[i])), n) >= -1e-12);
  const pts: P[] = [];
  const edges = (T: P[], d: number[], O: P[], n: P) => {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] > 0) === (d[j] > 0) || d[i] === d[j]) continue;
      const t = d[i] / (d[i] - d[j]), p = [T[i][0] + (T[j][0] - T[i][0]) * t, T[i][1] + (T[j][1] - T[i][1]) * t, T[i][2] + (T[j][2] - T[i][2]) * t];
      if (inside(p, O, n)) pts.push(p);
    }
  };
  edges(B, dB, A, nA);
  edges(A, dA, B, nB);
  if (pts.length < 2) return null;
  // The two points furthest apart are the ends.
  let best: [P, P] = [pts[0], pts[1]], far = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(...sub(pts[i], pts[j]));
    if (d > far) { far = d; best = [pts[i], pts[j]]; }
  }
  return far > eps ? best : null;
}

/** Every pair of shapes whose surfaces cross, the longest crossing first; at rest, or at a moment of an animation. */
export function clipsOf(built: Built, anim?: string, t = 0): Clip[] {
  const { positions: P, shapes: S } = posed(built, anim, t);
  const n = S.length;
  if (!n) return [];
  const tri = (i: number): P[] => [[P[i * 9], P[i * 9 + 1], P[i * 9 + 2]], [P[i * 9 + 3], P[i * 9 + 4], P[i * 9 + 5]], [P[i * 9 + 6], P[i * 9 + 7], P[i * 9 + 8]]];
  const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const a = P[i * 9 + k], b = P[i * 9 + 3 + k], c = P[i * 9 + 6 + k];
    lo[i * 3 + k] = Math.min(a, b, c); hi[i * 3 + k] = Math.max(a, b, c);
    min[k] = Math.min(min[k], lo[i * 3 + k]); max[k] = Math.max(max[k], hi[i * 3 + k]);
  }
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1, eps = size * 1e-6;
  // A grid of cells, each with the triangles that reach into it: only those that share a cell are held together.
  const cell = size / 48, key = (x: number, y: number, z: number) => `${x},${y},${z}`, grid = new Map<string, number[]>();
  const span = (i: number, k: number) => [Math.floor((lo[i * 3 + k] - min[k]) / cell), Math.floor((hi[i * 3 + k] - min[k]) / cell)];
  for (let i = 0; i < n; i++) {
    const [x0, x1] = span(i, 0), [y0, y1] = span(i, 1), [z0, z1] = span(i, 2);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = key(x, y, z);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(i);
    }
  }
  const pairs = new Map<string, { a: number; b: number; length: number; sum: number[]; min: number[]; max: number[]; lines: number[] }>();
  const seen = new Set<number>();
  for (const list of grid.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const i = list[x], j = list[y];
    if (S[i] === S[j]) continue;
    if ([0, 1, 2].some((k) => hi[i * 3 + k] < lo[j * 3 + k] - eps || hi[j * 3 + k] < lo[i * 3 + k] - eps)) continue;
    const id = i < j ? i * n + j : j * n + i;
    if (seen.has(id)) continue;
    seen.add(id);
    const seg = crossing(tri(i), tri(j), eps);
    if (!seg) continue;
    const a = Math.min(S[i], S[j]), b = Math.max(S[i], S[j]), k = `${a},${b}`, len = Math.hypot(...sub(seg[0], seg[1]));
    let p = pairs.get(k);
    if (!p) pairs.set(k, (p = { a, b, length: 0, sum: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], lines: [] }));
    p.length += len;
    if (p.lines.length < 6 * 400) p.lines.push(...seg[0], ...seg[1]);
    for (const q of seg) for (let c = 0; c < 3; c++) { p.sum[c] += q[c] * len / 2; p.min[c] = Math.min(p.min[c], q[c]); p.max[c] = Math.max(p.max[c], q[c]); }
  }
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [...pairs.values()].sort((x, y) => y.length - x.length).map((p) => ({
    a: p.a, b: p.b, length: r(p.length),
    at: p.sum.map((v) => r(v / p.length)) as Vec3, min: p.min.map(r) as Vec3, max: p.max.map(r) as Vec3, lines: p.lines,
  }));
}

/** A shape as it is said: its place, its kind, its name and its colour. */
export function shapeWords(built: Built, i: number): string {
  const s = built.shapes[i];
  return s ? `shape ${i} (${s.kind}${s.name ? ` "${s.name}"` : ''}, ${s.color}${s.bone >= 0 ? `, on ${built.bones[s.bone].name}` : ''})` : `shape ${i}`;
}

/** The crossings said in lines, the longest first, at most so many. */
export function clipWords(built: Built, clips: Clip[], most = 20): string[] {
  return clips.slice(0, most).map((c) => `${shapeWords(built, c.a)} and ${shapeWords(built, c.b)} cross along ${c.length} at ${c.at.join(', ')} (from ${c.min.join(', ')} to ${c.max.join(', ')})`);
}

/** A little piece of a shape that comes out through another one it is in: what shows of it is clipping. */
export interface Poke {
  /** The shape that sticks out, and the one it comes through. */
  shape: number; in: number;
  /** How much of its surface is inside the other (0 to 1), and how much of it is this little piece. */
  inside: number; piece: number;
  /** The triangles of that piece (by their place in posed()'s order), and its middle. */
  out: number[]; at: Vec3;
}

/**
 * Of every two shapes that cross, the little pieces of one that come out through the other: a thigh that is under a
 * skirt and pokes through it at the hip, a tongue through a cheek. What comes out of a shape as one large piece is
 * meant (a leg out from under a skirt, a belt sunk into a coat, an arm out of a shoulder); a small piece of it,
 * apart from the rest of what is outside, that came through where it should have stayed in, is clipping.
 */
export function pokesOf(built: Built, clips = clipsOf(built), anim?: string, t = 0, small = 0.15): Poke[] {
  const { positions: P, shapes: S } = posed(built, anim, t);
  const n = S.length, tris = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { let l = tris.get(S[i]); if (!l) tris.set(S[i], (l = [])); l.push(i); }
  const v = (i: number, c: number) => [P[i * 9 + c * 3], P[i * 9 + c * 3 + 1], P[i * 9 + c * 3 + 2]];
  const area = (i: number) => { const a = v(i, 0), b = v(i, 1), c = v(i, 2), u = sub(b, a), w = sub(c, a), x = cross(u, w); return Math.hypot(x[0], x[1], x[2]) / 2; };
  // Is a point inside a shape: a ray along +x through it crosses the shape's surface an odd number of times.
  const insideOf = (shape: number) => {
    const mine = tris.get(shape) ?? [];
    return (p: P) => {
      let k = 0;
      for (const i of mine) {
        const a = v(i, 0), b = v(i, 1), c = v(i, 2);
        // (Where the ray's y and z are within the triangle seen along x, and it is ahead of the point.)
        const d = (b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2]);
        if (Math.abs(d) < 1e-14) continue;
        const s1 = ((p[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (p[2] - a[2])) / d, s2 = ((b[1] - a[1]) * (p[2] - a[2]) - (p[1] - a[1]) * (b[2] - a[2])) / d;
        if (s1 < 0 || s2 < 0 || s1 + s2 > 1) continue;
        if (a[0] + (b[0] - a[0]) * s1 + (c[0] - a[0]) * s2 > p[0]) k++;
      }
      return k % 2 === 1;
    };
  };
  const corner = (i: number, c: number) => v(i, c).map((x) => Math.round(x * 1e5)).join();
  const out: Poke[] = [];
  for (const c of clips) for (const [x, y] of [[c.a, c.b], [c.b, c.a]]) {
    const test = insideOf(y), mine = tris.get(x) ?? [];
    let total = 0, inside = 0;
    const sticking: number[] = [];
    for (const i of mine) {
      const a = area(i), m = [0, 1, 2].map((k) => (v(i, 0)[k] + v(i, 1)[k] + v(i, 2)[k]) / 3);
      total += a;
      if (test(m)) inside += a; else sticking.push(i);
    }
    if (!total || inside / total < 0.05 || !sticking.length) continue;
    // What is outside, in pieces that hang together (by the corners they share).
    const at = new Map<string, number[]>();
    for (const i of sticking) for (let k = 0; k < 3; k++) { const key = corner(i, k); let l = at.get(key); if (!l) at.set(key, (l = [])); l.push(i); }
    const done = new Set<number>();
    for (const start of sticking) {
      if (done.has(start)) continue;
      const piece: number[] = [], todo = [start];
      done.add(start);
      while (todo.length) {
        const i = todo.pop()!;
        piece.push(i);
        for (let k = 0; k < 3; k++) for (const j of at.get(corner(i, k)) ?? []) if (!done.has(j)) { done.add(j); todo.push(j); }
      }
      const share = piece.reduce((s, i) => s + area(i), 0) / total;
      // (The large piece is what comes out as it should; one that is all there is outside is too.)
      if (share >= small || piece.length === sticking.length && inside / total < 0.9) continue;
      const mid = [0, 1, 2].map((k) => piece.reduce((s, i) => s + (v(i, 0)[k] + v(i, 1)[k] + v(i, 2)[k]) / 3, 0) / piece.length);
      out.push({ shape: x, in: y, inside: Math.round((inside / total) * 100) / 100, piece: Math.round(share * 1000) / 1000, out: piece, at: mid.map((m) => Math.round(m * 1000) / 1000) as Vec3 });
    }
  }
  return out.sort((p, q) => q.piece - p.piece);
}

/**
 * How hot every corner of the model is: what sticks out of a shape it is mostly inside glows (pokesOf), and the
 * rest is grey. A heatmap over the model, so clipping stands out at a glance, also small. In posed()'s order.
 */
export function heatOf(built: Built, anim?: string, t = 0): Float32Array {
  const { positions: P } = posed(built, anim, t);
  const heat = new Float32Array(P.length / 3);
  for (const p of pokesOf(built, clipsOf(built, anim, t), anim, t)) for (const i of p.out) for (let k = 0; k < 3; k++) heat[i * 3 + k] = 1;
  return heat;
}

/** A heat from 0 to 1 as a colour: grey, through red, to yellow where it is hottest. */
export function heatColor(h: number): [number, number, number] {
  const grey = [0.5, 0.52, 0.56], red = [0.95, 0.12, 0.08], yellow = [1, 0.92, 0.3];
  const mix = (a: number[], b: number[], f: number) => a.map((v, i) => v + (b[i] - v) * f) as [number, number, number];
  return h < 0.5 ? mix(grey, red, h * 2) : mix(red, yellow, (h - 0.5) * 2);
}

/** The same model coloured by its heat: what sticks out where it should not glows. */
export function byHeat(built: Built): Built {
  const heat = heatOf(built);
  let v = 0;
  return { ...built, pieces: built.pieces.map((p) => ({ ...p, colors: Array.from({ length: p.positions.length / 3 }, () => heatColor(heat[v++])).flat() })) };
}
