// The garden's layout, in world pixels. The simulation and the renderer both
// read these, so what a gnome walks to is what gets drawn.
import { hash01 } from '../util.ts';

// A tall, narrow garden: it fills a phone held upright, with the shop drawn up over the bottom of it.
export const WORLD_W = 144;
export const WORLD_H = 224;
export const LAWN_TOP = 38;

export const COTTAGE_W = 52;            // the cottage wall ends here
export const DOOR = { x: 21, y: 40 };
export const BASKET = { x: 38, y: 53 };
export const JAR = { x: 14, y: 57 };
export const GATE = { x: 126, y: 40 };
export const HOLE = { x: 70, y: 182 };

export const BED = { x0: 20, y0: 76, cols: 8, rows: 6, dx: 14, dy: 13 };
export const MAX_PLOTS = BED.cols * BED.rows;

/** Plot index -> position. Plots are numbered from the middle of the bed outward. */
export const PLOTS: { x: number; y: number }[] = (() => {
  const all: { x: number; y: number; d: number }[] = [];
  for (let r = 0; r < BED.rows; r++)
    for (let c = 0; c < BED.cols; c++) {
      const dx = c - (BED.cols - 1) / 2;
      const dy = (r - (BED.rows - 1) / 2) * 1.25;
      all.push({ x: BED.x0 + c * BED.dx, y: BED.y0 + r * BED.dy, d: dx * dx + dy * dy + c * 0.001 + r * 0.0001 });
    }
  all.sort((a, b) => a.d - b.d);
  return all.map(({ x, y }) => ({ x, y }));
})();

/** The path visitors take from the gate, and where lantern gnomes line up. */
export const PATH = [
  { x: 134, y: 44 },
  { x: 134, y: 104 },
  { x: 127, y: 150 },
  { x: 104, y: 176 },
];

export const HOLE_RY = 0.55; // the hole is seen at an angle

/** Radius of the hole on screen, from how deep it is. 0 = no hole yet. */
export function holeRadius(depth: number, digging: boolean): number {
  if (!digging) return 0;
  return 4 + Math.min(18, Math.sqrt(depth) * 1.8);
}

function inBed(x: number, y: number, pad: number): boolean {
  return x > BED.x0 - 8 - pad && x < BED.x0 + (BED.cols - 1) * BED.dx + 8 + pad
    && y > BED.y0 - 9 - pad && y < BED.y0 + (BED.rows - 1) * BED.dy + 4 + pad;
}

function nearHole(x: number, y: number, r: number): boolean {
  const dx = (x - HOLE.x) / r;
  const dy = (y - HOLE.y) / (r * HOLE_RY);
  return dx * dx + dy * dy < 1;
}

/** Where gardener number i stands when it has nothing to do: scattered over the lawn, off the beds and the hole. */
export function gardenerSpot(i: number): { x: number; y: number } {
  for (let k = 0; k < 40; k++) {
    const x = 5 + hash01(i * 7919 + k * 131 + 1) * (WORLD_W - 10);
    const y = LAWN_TOP + 10 + hash01(i * 104729 + k * 977 + 2) * (WORLD_H - LAWN_TOP - 14);
    if (inBed(x, y, 0)) continue;
    if (nearHole(x, y, 40)) continue;
    if (x < COTTAGE_W + 4 && y < 66) continue;                 // the doorstep
    if (Math.abs(x - PATH[0].x) < 6 && y < 150) continue;     // the path
    return { x, y };
  }
  return { x: 8 + (i % 12) * 2, y: 190 };
}

/** Lantern gnomes stand along the path first, then along the fence and round the lawn. */
export function lanternSpot(i: number): { x: number; y: number } {
  const along = 14;
  if (i < along) {
    // Walk the path polyline, alternating sides.
    const total = 160;
    let want = 8 + (Math.floor(i / 2) / (along / 2)) * total;
    for (let s = 0; s < PATH.length - 1; s++) {
      const a = PATH[s], b = PATH[s + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (want <= len || s === PATH.length - 2) {
        const t = Math.min(1, want / len);
        const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        const side = i % 2 ? 9 : -9;
        return { x: a.x + (b.x - a.x) * t + nx * side, y: a.y + (b.y - a.y) * t + ny * side };
      }
      want -= len;
    }
  }
  // Then round the edge of the lawn: the fence, the left side, the bottom, the right side.
  return EDGE[(i - along) % EDGE.length];
}

const EDGE: { x: number; y: number }[] = (() => {
  const pts: { x: number; y: number }[] = [];
  for (let x = 62; x <= 112; x += 10) pts.push({ x, y: 47 });
  for (let y = 78; y <= WORLD_H - 8; y += 10) pts.push({ x: 5, y });
  for (let x = 16; x <= WORLD_W - 10; x += 10) pts.push({ x, y: WORLD_H - 3 });
  for (let y = WORLD_H - 8; y >= 162; y -= 10) pts.push({ x: WORLD_W - 5, y });
  return pts;
})();

/** Choir gnomes stand in rings round the hole. */
export function choirSpot(i: number, holeR: number): { x: number; y: number } {
  let ring = 0;
  let left = i;
  for (;;) {
    const r = holeR + 9 + ring * 7;
    const cap = Math.max(6, Math.floor((2 * Math.PI * r) / 8));
    if (left < cap) {
      const a = (left / cap) * Math.PI * 2 + ring * 0.4;
      return { x: HOLE.x + Math.cos(a) * r, y: HOLE.y + Math.sin(a) * r * HOLE_RY };
    }
    left -= cap;
    ring++;
  }
}

/** A point on the rim of the hole for digger i to climb in at. */
export function rimSpot(i: number, holeR: number): { x: number; y: number } {
  const a = hash01(i * 31 + 5) * Math.PI * 2;
  const r = Math.max(3, holeR - 1);
  return { x: HOLE.x + Math.cos(a) * r, y: HOLE.y + Math.sin(a) * r * HOLE_RY };
}
