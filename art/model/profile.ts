// Rings for a loft, read from two pixel silhouettes of the same part: a front
// view (its width per row) and a side view (its depth per row, the front of the
// part to the right). Every pixel row is a ring; rows that a straight line
// between their neighbours already explains are left out, so the rings that stay
// sit where the shape turns: at joints and bulges. That is the mesh flow.
import type { Ring } from './format.ts';

export interface RingOptions {
  /** The size of one pixel in the model's units. */
  pixel?: number;
  /** How far (in pixels) a row that is left out may be from the line. */
  tolerance?: number;
  /** [first, last] row to use, counted from the top. */
  rows?: [number, number];
}

/** front, side: a string per row, top row first; '#' is filled, anything else empty. */
export function ringsFromSilhouettes(front: string[], side: string[], { pixel = 1, tolerance = 0.5, rows }: RingOptions = {}): Ring[] {
  if (!Array.isArray(front) || !Array.isArray(side) || !front.every((r) => typeof r === 'string') || !side.every((r) => typeof r === 'string'))
    throw new Error('rings(front, side): both are lists of strings, a row each, # where it is filled');
  const height = Math.min(front.length, side.length);
  const [first, last] = rows ?? [0, height - 1];
  const all: Required<Ring>[] = [];
  for (let r = Math.max(0, first); r <= Math.min(last, height - 1); r++) {
    const f = span(front[r]), s = span(side[r]);
    if (!f || !s) continue;
    all.push({
      y: height - r - 0.5,
      x: (f[0] + f[1] + 1) / 2 - front[r].length / 2,
      z: (s[0] + s[1] + 1) / 2 - side[r].length / 2,
      rx: (f[1] - f[0] + 1) / 2,
      rz: (s[1] - s[0] + 1) / 2,
    });
  }
  if (all.length < 2) throw new Error('rings(front, side): fewer than two rows are filled in both');
  return simplify(all, tolerance).map((g) => ({ y: g.y * pixel, x: g.x * pixel, z: g.z * pixel, rx: g.rx * pixel, rz: g.rz * pixel }));
}

function span(row = ''): [number, number] | null {
  const a = row.indexOf('#'), b = row.lastIndexOf('#');
  return a < 0 ? null : [a, b];
}

const KEYS = ['x', 'z', 'rx', 'rz'] as const;

// Douglas-Peucker over the rows: keep the row that strays furthest from the line between the ends, and do the
// same on both sides of it, until every row is within the tolerance.
function simplify(rings: Required<Ring>[], tolerance: number): Required<Ring>[] {
  if (rings.length <= 2) return rings;
  const a = rings[0], b = rings[rings.length - 1];
  let worst = 0, at = -1;
  for (let i = 1; i < rings.length - 1; i++) {
    const t = (rings[i].y - a.y) / (b.y - a.y);
    const off = Math.max(...KEYS.map((k) => Math.abs(rings[i][k] - (a[k] + (b[k] - a[k]) * t))));
    if (off > worst) { worst = off; at = i; }
  }
  if (worst <= tolerance) return [a, b];
  return [...simplify(rings.slice(0, at + 1), tolerance), ...simplify(rings.slice(at), tolerance).slice(1)];
}
