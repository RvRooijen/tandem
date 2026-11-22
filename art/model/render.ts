// Pictures of a model without a graphics card: dot by dot, from several sides
// on one sheet, so a worker (and the agent) can look at what it made the way a
// drawing worker looks at its render. How the Art tab shows it, it draws with
// the graphics card itself (shell/artview.ts), from the same faces.
//
// As a tool, in a worker's workspace:
//   node model/render.ts art/<name>.txt [--views=front,side,...] [--turn=<yaw>,<pitch>] [--wire] [--form]
//                        [--anim=<name> [--at=0,0.25,0.5,0.75]] [--zoom=<x>,<y>,<z>,<r>] [--clips] [--heat] [--size=<px>]
// writes out/<name>.png and says what is on it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { encodePng } from '../../core/png.ts';
import { isModel } from './format.ts';
import { readModel } from './run.ts';
import { clipsOf, clipWords, heatColor, heatOf, pokesOf, shapeWords } from './clips.ts';
import { boneMatrices, buildModel, loud, posed, transform, type Built } from './shapes.ts';

export interface View { name: string; yaw: number; pitch: number }
export const VIEWS: Record<string, View> = {
  'three-quarter': { name: 'three-quarter', yaw: 35, pitch: 20 },
  front: { name: 'front', yaw: 0, pitch: 0 },
  // (From the left, so its front is to the right, as a side view is drawn.)
  side: { name: 'side', yaw: -90, pitch: 0 },
  back: { name: 'back', yaw: 180, pitch: 0 },
  'three-quarter-back': { name: 'three-quarter-back', yaw: 215, pitch: 20 },
  top: { name: 'top', yaw: 0, pitch: 89.9 },
  below: { name: 'below', yaw: 0, pitch: -89.9 },
};
export const DEFAULT_VIEWS = ['three-quarter', 'front', 'side', 'back'];

export interface RenderOptions {
  views?: View[];
  /** Moments of an animation, a row each (t from 0 to 1 of its loop). */
  anim?: string;
  at?: number[];
  /** The outlines of the faces drawn over them: how the lines run. */
  wire?: boolean;
  /** All in one tone: only the form counts. */
  form?: boolean;
  /** Where shapes cross, measured (clips.ts): every shape in a loud colour of its own, the crossings that show drawn in white over it, and said. */
  clips?: boolean;
  /** Where shapes cross, as a heatmap over the model in grey: it glows red to yellow there. */
  heat?: boolean;
  tile?: number;
  /** Close up: only what is within r of [x, y, z] fills the picture (what is nearer than that to the eye is left out, so it does not stand in front). */
  zoom?: [number, number, number, number];
}

const BACK = [0.2, 0.17, 0.17], FORM = [0.55, 0.58, 0.65], LINE = [1, 0.93, 0.75], BONE = [0.27, 0.6, 1];

/** A sheet: a column per view, a row per moment (one row at rest). Gives the PNG and what is on it. */
export function renderSheet(built: Built, o: RenderOptions = {}): { png: Buffer; width: number; height: number; seen: Map<number, Set<string>> } {
  // Per crossing (by its place in clipsOf at rest, or at the first moment), the views it shows in.
  const seen = new Map<number, Set<string>>();
  const views = o.views?.length ? o.views : DEFAULT_VIEWS.map((v) => VIEWS[v]);
  const moments = o.anim ? (o.at?.length ? o.at : [0, 0.25, 0.5, 0.75]) : [0];
  const tile = o.tile ?? 256, ss = 2, size = tile * ss;
  const poses = moments.map((t) => posed(built, o.anim, t));
  // One measure for the whole sheet, so the views and the moments can be held against each other.
  const all = poses.flatMap((p) => [p.positions]);
  const { center, radius } = o.zoom ? { center: o.zoom.slice(0, 3), radius: o.zoom[3] } : bound(all);
  const scale = (size * 0.45) / radius;
  const width = tile * views.length, height = tile * moments.length;
  const out = new Uint32Array(width * height);

  poses.forEach((pose, row) => views.forEach((view, col) => {
    const rgb = new Float32Array(size * size * 3), zbuf = new Float32Array(size * size).fill(-Infinity);
    for (let i = 0; i < size * size; i++) rgb.set(BACK, i * 3);
    const project = projection(view, center, scale, size);
    const { positions: P, colors: C } = pose;
    const hot = o.heat ? heatOf(built, o.anim, moments[row]) : undefined;
    for (let t = 0; t < P.length; t += 9) {
      const a = project(P, t), b = project(P, t + 3), c = project(P, t + 6);
      const shade = light(a.v, b.v, c.v);
      const base = hot ? heatColor((hot[t / 3] + hot[t / 3 + 1] + hot[t / 3 + 2]) / 3) : o.clips ? loud(pose.shapes[t / 9]) : o.form ? FORM : [C[t], C[t + 1], C[t + 2]];
      raster(a, b, c, size, (px, z) => {
        if (z <= zbuf[px] || (o.zoom && z > radius * scale * 1.2)) return;
        zbuf[px] = z;
        rgb[px * 3] = base[0] * shade; rgb[px * 3 + 1] = base[1] * shade; rgb[px * 3 + 2] = base[2] * shade;
      });
    }
    const line = (e: Float32Array, i: number, j: number, color: number[], over = false): number => {
      let shown = 0;
      const a = project(e, i), b = project(e, j), steps = Math.ceil(Math.hypot(b.sx - a.sx, b.sy - a.sy)) + 1;
      for (let s = 0; s <= steps; s++) {
        const f = s / steps, x = Math.floor(a.sx + (b.sx - a.sx) * f), y = Math.floor(a.sy + (b.sy - a.sy) * f);
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const px = y * size + x;
        const z = a.z + (b.z - a.z) * f;
        if (o.zoom && !over && z > radius * scale * 1.2) continue;
        if (over || z + 0.01 * radius * scale >= zbuf[px]) { rgb.set(color, px * 3); shown++; }
      }
      return shown;
    };
    if (o.wire) for (let e = 0; e < pose.edges.length; e += 6) line(pose.edges, e, e + 3, LINE);
    // Where shapes cross, as far as it is seen from here: what is hidden inside does not show, and is not counted.
    if (o.clips) clipsOf(built, o.anim, moments[row]).forEach((c, k) => {
      const l = Float32Array.from(c.lines);
      let shown = 0;
      for (let e = 0; e < l.length; e += 6) shown += line(l, e, e + 3, [1, 1, 1]);
      if (shown >= 3 * ss) { if (!seen.has(k)) seen.set(k, new Set()); seen.get(k)!.add(view.name); }
    });
    // The bones, when it moves: from each joint to the one it hangs on.
    if (o.anim) {
      const at = boneMatrices(built, o.anim, moments[row]);
      built.bones.forEach((b, i) => {
        if (b.parent < 0) return;
        const from = transform(at[b.parent], [0, 0, 0]), to = transform(at[i], [0, 0, 0]);
        line(Float32Array.from([...from, ...to]), 0, 3, BONE, true);
      });
    }
    // Two by two dots make one: smooth edges.
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const sum = [0, 0, 0];
      for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) {
        const p = ((y * ss + dy) * size + (x * ss + dx)) * 3;
        sum[0] += rgb[p]; sum[1] += rgb[p + 1]; sum[2] += rgb[p + 2];
      }
      const ch = (v: number) => Math.max(0, Math.min(255, Math.round((v / (ss * ss)) * 255)));
      out[(row * tile + y) * width + col * tile + x] = ((255 << 24) | (ch(sum[2]) << 16) | (ch(sum[1]) << 8) | ch(sum[0])) >>> 0;
    }
    // (A thin line between the tiles.)
    for (let y = 0; y < tile; y++) if (col) out[(row * tile + y) * width + col * tile] = 0xff1a1212;
    if (row) for (let x = 0; x < tile; x++) out[(row * tile) * width + col * tile + x] = 0xff1a1212;
  }));
  return { png: encodePng(out, width, height), width, height, seen };
}

function projection({ yaw, pitch }: View, center: number[], scale: number, size: number) {
  const a = (-yaw * Math.PI) / 180, p = (pitch * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cp = Math.cos(p), sp = Math.sin(p);
  return (arr: Float32Array, i: number) => {
    const x = arr[i] - center[0], y = arr[i + 1] - center[1], z = arr[i + 2] - center[2];
    const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    return { v: [x1, y2, z2], sx: size / 2 + x1 * scale, sy: size / 2 - y2 * scale, z: z2 * scale };
  };
}

function light(a: number[], b: number[], c: number[]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = n.map((v) => v / len);
  if (n[2] < 0) n = n.map((v) => -v);
  const l = [-0.45, 0.65, 0.6], ll = Math.hypot(l[0], l[1], l[2]);
  return 0.35 + 0.65 * Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / ll);
}

type Pt = { sx: number; sy: number; z: number };
function raster(a: Pt, b: Pt, c: Pt, size: number, plot: (px: number, z: number) => void) {
  const minX = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx))), maxX = Math.min(size - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)));
  const minY = Math.max(0, Math.floor(Math.min(a.sy, b.sy, c.sy))), maxY = Math.min(size - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)));
  const area = (b.sx - a.sx) * (c.sy - a.sy) - (c.sx - a.sx) * (b.sy - a.sy);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((b.sx - px) * (c.sy - py) - (c.sx - px) * (b.sy - py)) / area;
    const w1 = ((c.sx - px) * (a.sy - py) - (a.sx - px) * (c.sy - py)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    plot(y * size + x, w0 * a.z + w1 * b.z + w2 * c.z);
  }
}

function bound(all: Float32Array[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const pos of all) for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  if (min[0] === Infinity) return { center: [0, 0, 0], radius: 1 };
  const center = min.map((m, k) => (m + max[k]) / 2);
  let radius = 0;
  for (const pos of all) for (let i = 0; i < pos.length; i += 3) radius = Math.max(radius, Math.hypot(pos[i] - center[0], pos[i + 1] - center[1], pos[i + 2] - center[2]));
  return { center, radius: radius || 1 };
}

/**
 * The crossings as words: those that show from outside (in the views they show in), the longest first, each a fix
 * or meant; and how many more cross only where nothing shows.
 */
export function clipReport(built: Built, seen: Map<number, Set<string>>, anim?: string, t = 0, most = 30): string[] {
  const clips = clipsOf(built, anim, t);
  if (!clips.length) return ['No two shapes cross.'];
  // First what is plainly wrong: little pieces of a shape that come out through another one it is in (--heat shows them).
  const pokes = pokesOf(built, clips, anim, t);
  const through = pokes.length
    ? [`${pokes.length} ${pokes.length === 1 ? 'place where a piece' : 'places where pieces'} of a shape poke out through another it is in: clipping, to fix (they glow with --heat).`,
      ...pokes.map((p) => `  ${shapeWords(built, p.shape)} pokes out through ${shapeWords(built, p.in)} at ${p.at.join(', ')} (a piece of ${Math.round(p.piece * 100)}% of it; ${Math.round(p.inside * 100)}% of it is inside)`)]
    : ['Nothing pokes out through a shape it is in.'];
  const shown = clips.map((c, k) => ({ c, views: seen.get(k) })).filter((x) => x.views);
  const words = clipWords(built, shown.map((x) => x.c), most);
  return [
    ...through,
    shown.length
      ? `${shown.length} places where two shapes cross and it shows from outside (white on the picture), the longest first. Each is a fix, or meant (one grows out of the other where it should): say which.`
      : 'Where shapes cross, it does not show from outside.',
    ...words.map((w, i) => `  ${w}; seen ${[...shown[i].views!].join(', ')}`),
    ...(shown.length > most ? [`  and ${shown.length - most} more, shorter`] : []),
    `${clips.length - shown.length} more cross only inside, where nothing shows.`,
  ];
}

/** The flags a render is asked for with, as options; throws with what is wrong with one. */
export function optionsOf(flags: string[]): RenderOptions {
  const o: RenderOptions = {};
  for (const f of flags) {
    const [k, v = ''] = f.replace(/^--/, '').split('=');
    if (k === 'views') o.views = [...(o.views ?? []), ...v.split(',').filter(Boolean).map((n) => VIEWS[n] ?? fail(`there is no view ${n}: ${Object.keys(VIEWS).join(', ')}`))];
    else if (k === 'turn') {
      const [yaw, pitch = 15] = v.split(',').map(Number);
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) fail('--turn=<degrees around>,<degrees tipped toward you>');
      o.views = [...(o.views ?? []), { name: `turned ${yaw},${pitch}`, yaw, pitch: Math.max(-89.9, Math.min(89.9, pitch)) }];
    } else if (k === 'anim') o.anim = v;
    else if (k === 'at') { o.at = v.split(',').map(Number); if (!o.at.every((t) => t >= 0 && t <= 1)) fail('--at= is moments of the loop, each from 0 to 1'); }
    else if (k === 'wire') o.wire = true;
    else if (k === 'form') o.form = true;
    else if (k === 'clips') o.clips = true;
    else if (k === 'heat') o.heat = true;
    else if (k === 'zoom') {
      const z = v.split(',').map(Number);
      if (z.length !== 4 || !z.every(Number.isFinite) || z[3] <= 0) fail('--zoom=<x>,<y>,<z>,<r>: where to look close up, and how far round it');
      o.zoom = z as [number, number, number, number];
    } else if (k === 'size') o.tile = Math.max(64, Math.min(512, Number(v) || 256));
    else fail(`there is no flag --${k}`);
  }
  if (o.anim && !o.views) o.views = [VIEWS['three-quarter']];
  return o;
}
const fail = (what: string): never => { throw new Error(what); };

if (process.argv[1] && process.argv[1].endsWith('render.ts') && import.meta.filename && basename(process.argv[1]) === basename(import.meta.filename)) {
  const [file, ...flags] = process.argv.slice(2);
  try {
    if (!file || !/^art\/[\w-]+\.txt$/.test(file)) fail('usage: node model/render.ts art/<name>.txt [--views=front,side,top,...] [--turn=60,15] [--wire] [--form] [--anim=<name> [--at=0,0.5]] [--zoom=x,y,z,r] [--clips] [--heat] [--size=256]');
    const text = readFileSync(file, 'utf8');
    if (!isModel(text)) fail(`${file} is not a 3D model (its first line is not // @model)`);
    const o = optionsOf(flags);
    const built = buildModel(readModel(text).model);
    if (o.anim && !built.model.anims[o.anim]) fail(`there is no animation ${o.anim}; there are: ${Object.keys(built.model.anims).join(', ') || 'none'}`);
    const name = basename(file, '.txt');
    mkdirSync('out', { recursive: true });
    const sheet = renderSheet(built, o);
    writeFileSync(join('out', `${name}.png`), sheet.png);
    const views = (o.views ?? DEFAULT_VIEWS.map((v) => VIEWS[v])).map((v) => v.name);
    const { positions } = posed(built);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
    const r = (n: number) => Math.round(n * 1000) / 1000;
    console.log(`out/${name}.png: ${views.join(', ')}${o.anim ? `; ${o.anim} at ${(o.at ?? [0, 0.25, 0.5, 0.75]).join(', ')}, a row each, with its bones` : ''}`);
    if (o.clips) for (const l of clipReport(built, sheet.seen, o.anim, o.at?.[0] ?? 0)) console.log(l);
    console.log(`${built.triangles} triangles; it stands in x ${r(min[0])}..${r(max[0])}, y ${r(min[1])}..${r(max[1])}, z ${r(min[2])}..${r(max[2])}${built.bones.length ? `; bones: ${built.bones.map((b) => b.name).join(', ')}` : ''}${Object.keys(built.model.anims).length ? `; animations: ${Object.keys(built.model.anims).join(', ')}` : ''}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
