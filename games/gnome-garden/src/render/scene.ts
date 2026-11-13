// Draws the garden from the game's entities into a framebuffer: ground,
// everything standing on it sorted by depth, then the night, the eyes in it,
// and what peace of mind is left of the colours.
//
// The simulation works in garden units; the picture has ZOOM pixels to a unit,
// so the drawings can be twice as fine as the world they stand in.
import { CRITTER, Critter, Flower, Gnome, Move, Pos, Spark, ST, VS, Visitor } from '../sim/components.ts';
import { ROLE } from '../sim/content.ts';
import type { Game } from '../sim/game.ts';
import { BASKET, COTTAGE_W, GATE, HOLE, HOLE_RY, JAR, PATH, PLOTS, SIGN, WORLD_W } from '../sim/world.ts';
import { clamp, hash01, lerp, smooth } from '../util.ts';
import { FB, hex, rgb, text, textWidth, type Frame } from './fb.ts';
import * as S from './sprites.ts';

/** Picture pixels per garden unit. */
export const ZOOM = 2;
const Z = ZOOM;

const C = {
  skyTop: hex('#86cdf2'), skyLow: hex('#dcf3fb'),
  hedge: hex('#3f8a3a'), hedgeDark: hex('#2f6e30'), hedgeDeep: hex('#245a2a'), hedgeLight: hex('#57a548'),
  lawnA: hex('#7fc552'), lawnB: hex('#74ba49'), tuft: hex('#5ea63e'), blade: hex('#9bd96a'),
  dead: hex('#b3a257'), deadDark: hex('#8c7a45'),
  soil: hex('#7d5030'), soilDark: hex('#5c3a22'), soilLight: hex('#96643c'),
  fence: hex('#f6f0e2'), fenceShade: hex('#d6cdb9'), fenceDark: hex('#b5ab96'), post: hex('#8a5a33'), postDark: hex('#5c3a22'),
  wall: hex('#f3e3bd'), wallShade: hex('#dcc79a'), timber: hex('#7d5030'),
  roof: hex('#b8553c'), roofDark: hex('#8f3b2e'),
  door: hex('#8a5a33'), doorDark: hex('#5c3a22'), knob: hex('#f8d24c'),
  glass: hex('#a8d8ee'), glassLit: hex('#ffe08a'), glassDark: hex('#1d2433'),
  stone: hex('#cfc8b6'), stoneLight: hex('#e4dece'), stoneDark: hex('#a8a18f'), step: hex('#bcb5a5'),
  pit: hex('#1c1118'), pitDeep: hex('#0b0609'), ember: hex('#7a1420'),
  hat: hex('#d5392f'), hatLight: hex('#ea5a4b'), hatDark: hex('#9d2431'), hatDeep: hex('#6f1826'),
  bloomText: hex('#fff0a8'), toothText: hex('#ffffff'), whisperText: hex('#d9b8ff'),
  eyePale: hex('#fff6c8'), eyeRed: hex('#ff3b30'), star: hex('#eef4ff'), lampCore: hex('#fff3b0'),
  white: hex('#ffffff'), ink: hex('#241722'),
};

const TEXT_COLORS = [C.bloomText, C.toothText, C.whisperText];
const MAX_DRAW = 4096;
const LID = hex('#0c070b');
// The cottage door and window, in garden units from the left of the world.
const DOOR_X = 14, WIN_X = 33, WIN_Y = 14, WIN_W = 13, WIN_H = 12;
// The eye colours in the gnome drawing: what an eye pixel looks like when nothing covers it.
const EYE_DARK = hex('#2b1e26'), EYE_HOLLOW = hex('#0d070b'), GLINT = hex('#ff4a3a'), GLINT_DARK = hex('#b02a38');

export interface Scene {
  fb: FB;
  /** Garden coordinates of a point in the picture. */
  toWorld(fx: number, fy: number): { x: number; y: number };
  render(g: Game, time: number): void;
  /** Show the cottage in one of its looks (summer, spring, autumn, winter); one it does not have is summer. */
  setCottage(look: string): void;
}

export function createScene(w: number, h: number): Scene {
  const fb = new FB(w, h);
  const ox = Math.floor((w - WORLD_W * Z) / 2);        // picture x of the garden's left edge
  const X = (x: number) => Math.round(x * Z) + ox;
  const Y = (y: number) => Math.round(y * Z);
  const bg = new Uint32Array(w * h);
  let bgKey = '';
  let cottageLook = 'summer';
  // Light, the way testp does it: the night multiplies everything with an ambient colour, and every lamp lifts a
  // pool around it back toward its own colour, in hard bands. `hts` says what stands where and how near it is (the
  // drawings' depth maps), so the edges of things facing a lamp catch a rim of its light and the far sides stay darker.
  const hts = new Uint8Array(w * h);                 // 0 ground, 1..5 how near what stands here is
  const hbg = new Uint8Array(w * h);                 // the same for the still parts: cottage, fence
  const nrmX = new Int8Array(w * h), nrmY = new Int8Array(w * h), edge = new Uint8Array(w * h);
  const litR = new Float32Array(w * h), litG = new Float32Array(w * h), litB = new Float32Array(w * h);
  const rimR = new Float32Array(w * h), rimG = new Float32Array(w * h), rimB = new Float32Array(w * h);
  const cast = new Float32Array(w * h);              // shadows thrown on the ground, 0..1
  let tick = 0;
  // The sun: which way it is (in the picture, toward it), how strong, and how long the shadows it throws are.
  const sun = { x: -0.7, y: -0.7, power: 0, len: 0.5, r: 1, g: 0.96, b: 0.82 };
  const vig = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w / 2), dy = (y - h / 2) / (h / 2);
      vig[y * w + x] = clamp((dx * dx + dy * dy - 0.3) / 1.3, 0, 1);
    }

  // Things standing on the lawn, bucketed by the picture row their feet are on.
  const dFrame: Frame[] = new Array(MAX_DRAW);
  const dX = new Int16Array(MAX_DRAW), dY = new Int16Array(MAX_DRAW);
  const dFlip = new Uint8Array(MAX_DRAW);
  const dNext = new Int32Array(MAX_DRAW);
  const PAD = 16;
  const rows = h + 96;
  const head = new Int32Array(rows).fill(-1), tail = new Int32Array(rows);
  let dN = 0;

  const hat = { cx: 0, base: 0, hh: 0, hw: 0 };      // where the big hat is this frame, if it is up
  const eyes = new Int16Array(MAX_DRAW * 3);          // x, y of a 2x2 eye, and what kind
  let eyeN = 0;
  const LAMP = 8;                                    // x, y, radius, power, r, g, b, the y of its foot on the ground
  const lamps = new Float32Array(256 * LAMP);
  let lampN = 0;

  /** Queue a frame with its top-left at picture (x, y), in front of everything whose feet are above picture row sortY. */
  function push(f: Frame, x: number, y: number, flip: boolean, sortY: number) {
    if (dN >= MAX_DRAW) return;
    const row = clamp(Math.round(sortY) + PAD, 0, rows - 1);
    const i = dN++;
    dFrame[i] = f; dX[i] = x; dY[i] = y; dFlip[i] = flip ? 1 : 0; dNext[i] = -1;
    if (head[row] < 0) head[row] = i; else dNext[tail[row]] = i;
    tail[row] = i;
  }

  /** Queue a frame standing with its feet on garden (x, y). lift is in picture pixels. */
  function stand(f: Frame, x: number, y: number, flip = false, lift = 0, sortBias = 0) {
    push(f, X(x) - (f.w >> 1), Y(y) - f.h + Z - lift, flip, Y(y) + sortBias);
  }

  function eye(x: number, y: number, kind: number) {
    if (eyeN >= MAX_DRAW) return;
    eyes[eyeN * 3] = x; eyes[eyeN * 3 + 1] = y; eyes[eyeN * 3 + 2] = kind;
    eyeN++;
  }

  /** A light at garden (x, y) reaching r garden units, in a colour; foot is the y of the ground under it. */
  function lamp(x: number, y: number, r: number, power: number, color: readonly number[], foot = y, flicker = 0) {
    if (lampN >= 256) return;
    const o = lampN * LAMP;
    lamps[o] = X(x); lamps[o + 1] = Y(y); lamps[o + 2] = r * Z * (1 + flicker); lamps[o + 3] = power;
    lamps[o + 4] = color[0]; lamps[o + 5] = color[1]; lamps[o + 6] = color[2]; lamps[o + 7] = Y(foot);
    lampN++;
  }

  /** Draw a frame and note what now stands there, for the light. */
  function blitH(f: Frame, x: number, y: number, flip: boolean) {
    const fw = f.w, fh = f.h, src = f.px, d = f.d;
    const out = fb.px;
    for (let sy = 0; sy < fh; sy++) {
      const dy = y + sy;
      if (dy < 0 || dy >= h) continue;
      const row = sy * fw, drow = dy * w;
      for (let sx = 0; sx < fw; sx++) {
        const at = row + (flip ? fw - 1 - sx : sx);
        const c = src[at];
        if (!c) continue;
        const dx = x + sx;
        if (dx >= 0 && dx < w) { out[drow + dx] = c; hts[drow + dx] = d ? d[at] : 3; }
      }
    }
  }

  /**
   * The shadow of something `tall` picture pixels high standing at garden (x, y), `half` pixels to each side. By
   * day a soft patch under its feet. At night it is thrown along the ground, away from the strongest lamp in
   * reach: short when the lamp is near, long and faint at the edge of its light.
   */
  function shadow(x: number, y: number, half: number, tall = 28, night = 0) {
    const cx = X(x), cy = Y(y) + Z;
    let best = -1, bestScore = 0, bestD = 0;
    if (night > 0.3) {
      for (let k = 0; k < lampN; k++) {
        const o = k * LAMP;
        const dx = cx - lamps[o], dy = (cy - lamps[o + 7]) / L.ground;
        const d = Math.hypot(dx, dy);
        if (d < L.near || d >= lamps[o + 2]) continue;
        const score = lamps[o + 3] * (1 - d / lamps[o + 2]);
        if (score > bestScore) { bestScore = score; best = k; bestD = d; }
      }
    }
    if (best < 0) {
      // A soft patch right under the feet, whatever the light.
      for (let dy = 0; dy < 3; dy++) {
        const reach = dy === 1 ? half : half - 3;
        for (let dx = -reach; dx < reach; dx++) fb.shade(cx + dx, cy + dy - 1, dy === 1 ? 0.8 : 0.88);
      }
      if (sun.power < 0.05) return;
      // And by day a shadow thrown away from the sun: long in the morning and evening, short at noon.
      const ux = -sun.x, uy = -sun.y * L.ground;
      const len = tall * sun.len;
      const dark = L.sunShadow * sun.power;
      const px = -uy, py = ux;
      for (let t = 0; t <= len; t++) {
        const wide = half * (1 - 0.5 * (t / len));
        const a = dark * (1 - 0.5 * (t / len));
        for (let s = -wide; s <= wide; s++) {
          const sx = Math.round(cx + ux * t + px * s), sy = Math.round(cy + uy * t + py * s * L.ground);
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const i = sy * w + sx;
          if (cast[i] < a) cast[i] = a;
        }
      }
      return;
    }
    const o = best * LAMP;
    const far = bestD / lamps[o + 2];
    const ux = (cx - lamps[o]) / bestD, uy = ((cy - lamps[o + 7]) / L.ground / bestD) * L.ground;
    const len = tall * (L.short + (L.long - L.short) * far);
    const dark = L.shadow * (1 - far) * Math.min(1, night * 1.4);
    const px = -uy, py = ux;                             // across the shadow
    for (let t = 0; t <= len; t++) {
      const wide = half * (1 - 0.55 * (t / len));
      const a = dark * (1 - 0.6 * (t / len));
      for (let s = -wide; s <= wide; s++) {
        const sx = Math.round(cx + ux * t + px * s), sy = Math.round(cy + uy * t + py * s * L.ground);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const i = sy * w + sx;
        if (cast[i] < a) cast[i] = a;
      }
    }
  }

  // ------------------------------------------------------------ the still parts

  function buildBackground(g: Game, dread: number) {
    const s = g.s;
    const t = new FB(w, h);
    const lawnTop = 30 * Z;
    // Sky, then the hedge at the bottom of it.
    for (let y = 0; y < lawnTop; y++) {
      const k = y / lawnTop;
      const top = C.skyTop, low = C.skyLow;
      t.rect(0, y, w, 1, rgb(lerp(top & 255, low & 255, k), lerp((top >> 8) & 255, (low >> 8) & 255, k), lerp((top >> 16) & 255, (low >> 16) & 255, k)));
    }
    for (let i = 0; i < w / 9 + 2; i++) {
      const x = i * 9 + hash01(i * 17) * 8 - 4;
      const r = 12 + hash01(i * 31 + 1) * 10;
      const y = 45 - hash01(i * 7 + 3) * 9;
      t.ellipse(x + 2, y + 2, r, r * 0.8, C.hedgeDeep);
      t.ellipse(x, y, r, r * 0.8, hash01(i * 3 + 9) > 0.5 ? C.hedge : C.hedgeDark);
      t.ellipse(x - r * 0.3, y - r * 0.3, r * 0.45, r * 0.3, C.hedgeLight);
    }

    // Lawn: mown in stripes, with tufts. As peace of mind goes, so does the grass.
    for (let y = lawnTop; y < h; y++)
      for (let x = 0; x < w; x++) {
        const wx = x - ox + 800;
        const n = hash01(x * 7919 + y * 104729);
        let c = Math.floor(wx / 26) % 2 ? C.lawnA : C.lawnB;
        // Blades of grass: short strokes, two pixels tall.
        const above = hash01(x * 7919 + (y - 1) * 104729);
        if (n < 0.03 || above < 0.03) c = C.tuft; else if (n > 0.985 || above > 0.985) c = C.blade;
        // Dead patches: ragged blobs that spread.
        const cellX = wx >> 5, cellY = y >> 5;
        const reach = (dread - 0.22) * 1.5;
        if (reach > 0 && hash01(cellX * 131 + cellY * 977) < reach * 0.6) {
          const px0 = (wx & 31) - 16 + (hash01(cellX * 7 + cellY) - 0.5) * 12, py0 = (y & 31) - 16;
          const edge = 136 * Math.min(1, reach + 0.3) + (hash01(x * 31 + y * 17) - 0.5) * 90;
          if (px0 * px0 + py0 * py0 * 1.8 < edge) c = n < 0.25 ? C.deadDark : C.dead;
        }
        t.px[y * w + x] = c;
      }

    // The beds: a patch of turned earth per plot, lit from the top left.
    for (let p = 0; p < s.plots; p++) {
      const at = PLOTS[p];
      const cx = X(at.x), cy = Y(at.y);
      t.ellipse(cx, cy + 1, 14, 8, C.soilDark);
      t.ellipse(cx - 1, cy - 1, 12, 6, C.soil);
      t.ellipse(cx - 4, cy - 3, 6, 2, C.soilLight);
      for (let k = 0; k < 7; k++) {
        const a = hash01(p * 31 + k * 7) * 6.28, r = hash01(p * 17 + k * 3) * 9;
        t.set(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.5, k % 2 ? C.soilDark : C.soilLight);
      }
    }

    // Stepping stones from the gate.
    for (let sIdx = 0; sIdx < PATH.length - 1; sIdx++) {
      const a = PATH[sIdx], b = PATH[sIdx + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = 0; d < len; d += 9) {
        const x = X(a.x + ((b.x - a.x) * d) / len), y = Y(a.y + ((b.y - a.y) * d) / len);
        t.ellipse(x + 1, y + 2, 7, 4, C.stoneDark);
        t.ellipse(x, y, 7, 3.5, C.stone);
        t.ellipse(x - 2, y - 1, 3, 1.2, C.stoneLight);
      }
    }

    // Where little feet have worn the grass away: from the doorstep to the hole.
    if (g.holeR > 0) {
      for (let k = 0; k < 260; k++) {
        const u = k / 260;
        const x = X(lerp(JAR.x + 8, HOLE.x - 6, u) + Math.sin(u * 9) * 3), y = Y(lerp(JAR.y + 6, HOLE.y - 6, u));
        if (hash01(k * 13) < 0.5 + dread * 0.5) t.set(x + hash01(k) * 7, y + hash01(k * 3) * 4, C.deadDark);
        if (hash01(k * 29) < dread) t.set(x + 2 + hash01(k * 5) * 6, y + 2, C.soil);
      }
    }

    // The picket fence, with a gap for the gate.
    const fenceFrom = X(COTTAGE_W + 2);
    t.rect(fenceFrom, 29 * Z, w - fenceFrom, 2, C.fenceDark);
    t.rect(fenceFrom, 34 * Z, w - fenceFrom, 2, C.fenceDark);
    for (let x = fenceFrom; x < w; x += 8) {
      const wx = (x - ox) / Z;
      if (wx > GATE.x - 9 && wx < GATE.x + 7) continue;
      t.rect(x, 25 * Z, 6, 13 * Z, C.fence);
      t.rect(x + 1, 24 * Z, 4, 2, C.fence);
      t.rect(x + 2, 23 * Z, 2, 2, C.fence);
      t.rect(x + 4, 25 * Z + 1, 2, 13 * Z - 1, C.fenceShade);
      t.rect(x, 38 * Z - 2, 6, 2, C.fenceDark);
      if (hash01(x) > 0.6) t.set(x + 2, 28 * Z + hash01(x * 3) * 12, C.fenceShade);
    }
    for (const side of [-10, 8]) {
      const px = X(GATE.x + side);
      t.rect(px, 21 * Z, 4, 18 * Z, C.post);
      t.rect(px + 2, 21 * Z, 2, 18 * Z, C.postDark);
      t.rect(px - 1, 21 * Z - 2, 6, 2, C.post);
    }
    // The gate stands open.
    const gx = X(GATE.x + 10);
    t.rect(gx, 26 * Z, 14, 2, C.post);
    t.rect(gx, 33 * Z, 14, 2, C.post);
    for (let k = 0; k < 3; k++) { t.rect(gx + 2 + k * 4, 25 * Z, 2, 12 * Z, C.post); t.rect(gx + 3 + k * 4, 25 * Z, 1, 12 * Z, C.postDark); }

    drawCottage(t, dread);
    bg.set(t.px);

    // What stands in the still parts, for the light: the pickets and posts, and the cottage by its own depth map.
    hbg.fill(0);
    const stand = (x: number, y: number, ww: number, hh: number, near: number) => {
      for (let yy = Math.max(0, y); yy < Math.min(h, y + hh); yy++) hbg.fill(near, yy * w + Math.max(0, x), yy * w + Math.min(w, x + ww));
    };
    for (let x = fenceFrom; x < w; x += 8) {
      const wx = (x - ox) / Z;
      if (wx > GATE.x - 9 && wx < GATE.x + 7) continue;
      stand(x, 23 * Z, 6, 15 * Z, 2);
    }
    for (const side of [-10, 8]) stand(X(GATE.x + side), 21 * Z, 4, 18 * Z, 3);
    const f = S.cottage(cottageLook);
    if (f) {
      for (let y = 0; y < Math.min(h, f.h); y++)
        for (let x = 0; x < f.w; x++) {
          const at = y * f.w + x;
          if (f.px[at] && ox + x < w) hbg[y * w + ox + x] = f.d ? f.d[at] : 3;
        }
      for (let y = 0; y < Math.min(h, f.h); y++) if (f.px[y * f.w]) hbg.fill(f.d ? f.d[y * f.w] : 3, y * w, y * w + ox);
    }
  }

  function drawCottage(t: FB, dread: number) {
    const right = X(COTTAGE_W);
    const f = S.cottage(cottageLook);
    if (f) {
      // The drawing covers the garden's own width; a wider screen gets more of the same wall and roof to the left.
      for (let y = 0; y < f.h; y++) {
        const edge = f.px[y * f.w];
        if (edge) t.rect(0, y, ox, 1, edge);
      }
      t.blit(f, ox, 0);
    } else {
      t.rect(0, 0, right + 8, 18, C.roof);
      t.rect(0, 16, right + 8, 2, C.roofDark);
      t.rect(0, 18, right, 60, C.wall);
      t.rect(right - 6, 18, 4, 60, C.timber);
      t.rect(ox + DOOR_X * Z, 34, 28, 44, C.doorDark);
      t.rect(ox + DOOR_X * Z + 2, 36, 24, 42, C.door);
      t.rect(ox + WIN_X * Z - 2, WIN_Y * Z - 2, WIN_W * Z + 4, WIN_H * Z + 4, C.timber);
      t.rect(ox + WIN_X * Z, WIN_Y * Z, WIN_W * Z, WIN_H * Z, C.glass);
      t.rect(ox + (DOOR_X - 3) * Z, 78, 44, 8, C.step);
    }
    if (dread > 0.8) t.rect(ox + DOOR_X * Z + 2, 36, 6, 42, C.pitDeep);   // the door stands ajar
  }

  // ------------------------------------------------------------ the hole

  function drawHole(g: Game, time: number) {
    if (g.holeR <= 0) return;
    const s = g.s;
    const r = g.holeR * Z;
    const cx = X(HOLE.x), cy = Y(HOLE.y);
    const ry = r * HOLE_RY;
    const breathe = s.flags.breath ? Math.sin(time * 1.05) * 1.2 : 0;
    // Spoil heap, off to the left.
    const m = 6 + r * 0.45;
    fb.ellipse(cx - r - m - 2, cy + 2, m, m * 0.5, C.soilDark);
    fb.ellipse(cx - r - m - 3, cy, m - 2, m * 0.45, C.soil);
    fb.ellipse(cx - r - m - 5, cy - m * 0.2, m * 0.4, m * 0.15, C.soilLight);
    // Rim, pit, and the dark further down.
    fb.ellipse(cx, cy, r + 4 + breathe, ry + 3 + breathe * 0.5, C.soilDark);
    fb.ellipse(cx - 1, cy - 1, r + 2 + breathe, ry + 1.5, C.soil);
    fb.ellipse(cx - r * 0.5, cy - ry - 1, r * 0.35, 1.5, C.soilLight);
    fb.ellipse(cx, cy, r, ry, C.pit);
    fb.ellipse(cx + 1, cy + ry * 0.2, r * 0.72, ry * 0.68, C.pitDeep);
    if (s.depth >= 8 && g.holeR > 7) {
      // Small steps, neatly cut.
      for (let k = 0; k < 6; k++) { fb.rect(cx - r + 4 + k * 3, cy - ry * 0.5 + k * 2.4, 4, 2, C.stoneDark); fb.rect(cx - r + 4 + k * 3, cy - ry * 0.5 + k * 2.4, 4, 1, C.stone); }
    }
    if (s.depth >= 20) {
      // It is warm at the bottom.
      const pulse = 0.35 + 0.3 * Math.sin(time * 1.05) + clamp((s.depth - 20) / 120, 0, 0.35);
      const gr = r * 0.5, gry = ry * 0.45;
      for (let y = -gry; y <= gry; y++)
        for (let x = -gr; x <= gr; x++) {
          const d = (x * x) / (gr * gr) + (y * y) / (gry * gry);
          if (d < 1) fb.mix(cx + x, cy + ry * 0.25 + y, C.ember, (1 - d) * pulse);
        }
    }
  }

  /** The tip of a hat the size of the house, coming up out of the hole. */
  function drawHat(g: Game, time: number) {
    const s = g.s;
    hat.hh = 0;
    if (!s.flags.hatTip && !g.ending) return;
    const e = g.ending ? smooth(g.ending.t) : 0;
    const cx = X(HOLE.x), base = Y(HOLE.y + g.holeR * HOLE_RY * 0.3);
    const up = clamp((s.depth - 60) / 40, 0, 1);
    const hh = lerp(3 + up * (g.holeR * 0.9), 190, e) * Z;
    const hw = lerp(1.5 + up * (g.holeR * 0.42), 74, e) * Z;
    const sway = Math.sin(time * 1.05) * 1.6 * (1 - e);
    hat.cx = cx; hat.base = base; hat.hh = hh; hat.hw = hw;
    for (let y = 0; y < hh; y++) {
      const k = y / hh;
      const half = hw * k;
      const yy = Math.round(base - hh + y);
      if (yy < 0 || yy >= h) continue;
      const mid = cx + sway * (1 - k);
      for (let x = Math.round(mid - half); x <= Math.round(mid + half); x++) {
        const side = (x - mid) / Math.max(1, half);
        // Felt, lit from the top left; a seam now and then.
        let c = side > 0.55 ? C.hatDeep : side > 0.1 ? C.hatDark : side < -0.5 ? C.hatLight : C.hat;
        if ((y & 15) === 15 && side > -0.6 && side < 0.6) c = C.hatDark;
        fb.set(x, yy, c);
        if (x >= 0 && x < w) hts[yy * w + x] = side > 0.1 ? 3 : 4;
      }
    }
    if (e > 0.5) {
      // And under the brim, him.
      const k = (e - 0.5) * 2;
      fb.rect(cx - hw, base, hw * 2, (3 + k * 4) * Z, C.hatDeep);
      const ey = base + (6 + k * 6) * Z;
      for (const sx of [-1, 1]) {
        fb.ellipse(cx + sx * hw * 0.42, ey, 18 * k, 14 * k, C.pitDeep);
        fb.ellipse(cx + sx * hw * 0.42 + 2, ey - 2, 4 * k, 4 * k, C.eyeRed);
      }
    }
  }

  // ------------------------------------------------------------ everything standing up

  function gatherFlowers(g: Game, time: number) {
    const lookX = g.look.x;
    g.em.forEachArchetype([Flower], (_ids, n, field) => {
      const plot = field(Flower.plot), kind = field(Flower.kind), growth = field(Flower.growth), weed = field(Flower.weed);
      for (let i = 0; i < n; i++) {
        const at = PLOTS[plot[i]];
        const set = S.FLOWER[kind[i]];
        const gr = growth[i];
        if (weed[i]) stand(S.WEED[g.s.peace < 55 ? 1 : 0], at.x + 5, at.y + 1, false, 0, 1);
        if (gr < 0.06) continue;
        let f: Frame;
        let sway = 0;
        if (gr < 0.4) f = set.sprout;
        else if (gr < 1) f = set.bud;
        else {
          f = set.ripe[set.ripe.length > 1 ? Math.floor(time * 1.6 + plot[i] * 0.37) % set.ripe.length : 0];
          sway = Math.sin(time * 2 + plot[i]) > 0.6 ? 0.5 : 0;
        }
        stand(f, at.x + sway, at.y);
        if (gr >= 1 && set.eye) {
          // The pupil follows whoever is looking.
          const px = X(at.x + sway) - (f.w >> 1) + set.eye.x + clamp(Math.round((lookX - at.x) / 30), -1, 1) * 2;
          push(PUPIL, px, Y(at.y) - f.h + Z + set.eye.y, false, Y(at.y) + 1);
        }
      }
    });
  }

  function gatherGnomes(g: Game, time: number) {
    const s = g.s;
    const creepy = 1 - s.peace / 100;
    const night = g.dark;
    const lookX = g.look.age < 12 ? g.look.x : WORLD_W / 2;
    const staring = s.peace < 62;
    const humming = night > 0.5 || s.peace < 40;
    g.em.forEachArchetype([Pos, Move, Gnome], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), tx = field(Move.tx), ty = field(Move.ty);
      const role = field(Gnome.role), st = field(Gnome.state), look = field(Gnome.look), load = field(Gnome.load);
      const face = field(Gnome.face), seed = field(Gnome.seed), walked = field(Gnome.walked), idx = field(Gnome.idx);
      const carry = field(Gnome.carry);
      for (let i = 0; i < n; i++) {
        if (st[i] === ST.DIG) continue;
        const x = px[i], y = py[i];
        const dx = tx[i] - x, dy = ty[i] - y;
        // An ornament stands. Only somebody who is seen moving, or caught at it, is drawn in mid-stride.
        const walking = !g.statues && dx * dx + dy * dy > 0.3;
        const fc = creepy > 0.5 + 0.38 * seed[i] ? 2 : creepy > 0.13 + 0.3 * seed[i] ? 1 : 0;
        const set = S.GNOME[look[i]][fc];
        const stride = walking ? (Math.floor(walked[i] / 2.6) & 1 ? set.a : set.b) : set.stand;
        let dir = face[i];
        if (!walking && staring) dir = lookX < x ? -1 : 1;
        let lift = walking && stride === set.b ? Z : 0;
        // A frozen gnome does not so much as bob: no swaying with the hum, no bending to pick.
        if (!g.frozen) {
          if (role[i] === ROLE.choir && !walking && humming && Math.sin(time * 2.4 + idx[i] * 0.9) > 0.2) lift = Z;
          if (st[i] === ST.PICK) lift = Math.sin(time * 18) > 0 ? 0 : -Z;
        }

        shadow(x, y, 10, 28, night);
        stand(stride, x, y, dir < 0, lift);

        const sx = X(x), sy = Y(y);
        const left = sx - (stride.w >> 1), top = sy - stride.h + Z - lift;
        if (night > 0.3 && fc > 0) {
          // The eyes sit either side of the middle, so they are in the same place whichever way he faces.
          eye(left + S.GNOME_EYES.x[0], top + S.GNOME_EYES.y, fc);
          eye(left + S.GNOME_EYES.x[1], top + S.GNOME_EYES.y, fc);
        }
        if (role[i] === ROLE.digger) {
          push(S.SHOVEL, sx + dir * 13 - (S.SHOVEL.w >> 1), sy - S.SHOVEL.h - lift, dir < 0, sy + 1);
          if (carry[i] > 0) push(TOOTH, sx - dir * 13 - 2, sy - 12 - lift, false, sy + 1);
        } else if (role[i] === ROLE.lantern) {
          const lx = sx + dir * 15 - (S.LANTERN.w >> 1), ly = sy - 18 - lift;
          push(S.LANTERN, lx, ly, false, sy + 1);
          eye(lx + (S.LANTERN.w >> 1) - 1, ly + (S.LANTERN.h >> 1), 3);
        } else if (load[i] > 0) {
          push(BUNCH[Math.min(BUNCH.length - 1, s.seed)], sx - dir * 14 - 3, sy - 16 - lift, false, sy + 1);
        }
      }
    });
  }

  function gatherVisitors(g: Game, time: number) {
    g.em.forEachArchetype([Pos, Move, Visitor], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), tx = field(Move.tx), ty = field(Move.ty);
      const kind = field(Visitor.kind), st = field(Visitor.state), face = field(Visitor.face);
      const walked = field(Visitor.walked), greeted = field(Visitor.greeted), timer = field(Visitor.timer);
      for (let i = 0; i < n; i++) {
        let x = px[i];
        const y = py[i];
        const dx = tx[i] - x, dy = ty[i] - y;
        const walking = dx * dx + dy * dy > 0.3;
        const set = S.VISITOR[kind[i]];
        const f = walking ? (Math.floor(walked[i] / 3) & 1 ? set.a : set.b) : set.stand;
        if (st[i] === VS.TAKEN) x += Math.sin(time * 40) * clamp(1.6 - timer[i] / 4, 0, 1.5);   // trembling
        shadow(x, y, 10, 44, g.dark);
        stand(f, x, y, face[i] < 0);
        if (!greeted[i] && st[i] !== VS.TAKEN && st[i] !== VS.LEAVE) {
          const bob = Math.sin(time * 4 + i) > 0 ? Z : 0;
          push(HELLO, X(x) - (HELLO.w >> 1), Y(y) - f.h - HELLO.h - bob, false, Y(y) + 1);
        }
      }
    });
  }

  function gatherCritters(g: Game, time: number) {
    g.em.forEachArchetype([Pos, Critter], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), kind = field(Critter.kind), life = field(Critter.life), seed = field(Critter.seed);
      for (let i = 0; i < n; i++) {
        const k = kind[i];
        const set = S.CRITTERS[k];
        const flying = k === CRITTER.butterfly || k === CRITTER.firefly;
        const rate = k === CRITTER.butterfly ? 9 : k === CRITTER.crow ? 1.3 : 3;
        let f = set[Math.floor(time * rate + seed[i] * 7) & 1];
        if (k === CRITTER.glint) f = set[Math.sin(time * 1.7 + seed[i] * 9) > 0.92 ? 1 : 0];
        // About to leave: it flickers.
        if (life[i] < 2.5 && Math.floor(time * 10) & 1) continue;
        const bob = flying ? (Math.round(Math.sin(time * 5 + seed[i] * 6) * 2) + 5) * Z : 0;
        if (flying) shadow(px[i], py[i] + 4, 5);
        stand(f, px[i], py[i] + (flying ? 4 : 0), false, bob, flying ? 60 : 0);
        if (k === CRITTER.glint) {
          // Its eyes show in the dark like theirs do.
          const left = X(px[i]) - (f.w >> 1), top = Y(py[i]) - f.h + Z;
          for (const ex of S.GLINT_EYES.x) eye(left + ex, top + S.GLINT_EYES.y, 2);
        }
      }
    });
  }

  /** Eyes only glow where they can be seen: drop the ones somebody is standing in front of. */
  function cullEyes() {
    for (let i = 0; i < eyeN; i++) {
      const kind = eyes[i * 3 + 2];
      if (kind === 3) continue;
      const c = fb.get(eyes[i * 3], eyes[i * 3 + 1]);
      if (c !== EYE_DARK && c !== EYE_HOLLOW && c !== GLINT && c !== GLINT_DARK) eyes[i * 3 + 2] = 0;
    }
  }

  /** Draw the queued frames whose feet are on picture rows [from, to), back to front. */
  function drawSorted(from: number, to: number) {
    const end = Math.min(rows, to + PAD);
    for (let r = Math.max(0, from + PAD); r < end; r++) {
      for (let i = head[r]; i >= 0; i = dNext[i]) blitH(dFrame[i], dX[i], dY[i], dFlip[i] === 1);
      head[r] = -1;
    }
    if (end >= rows) dN = 0;
  }

  function drawSparks(g: Game) {
    g.em.forEachArchetype([Pos, Spark], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), kind = field(Spark.kind), life = field(Spark.life);
      for (let i = 0; i < n; i++) {
        const c = S.SPARK_COLOR[kind[i]] ?? C.white;
        const x = X(px[i]), y = Y(py[i]);
        fb.rect(x, y, 2, 2, c);
        if (kind[i] === 5) { fb.rect(x - 2, y - 2, 2, 2, c); fb.rect(x + 2, y - 2, 2, 2, c); }   // a heart
        else if (kind[i] === 9 && life[i] > 0.3) { fb.rect(x + 2, y, 1, 2, c); fb.rect(x, y + 2, 2, 1, c); fb.rect(x - 1, y, 1, 2, c); fb.rect(x, y - 1, 2, 1, c); }
        else if (kind[i] === 10) fb.rect(x, y - 2, 1, 2, c);                                      // a drop of water
      }
    });
  }

  // ------------------------------------------------------------ light, dark, and dread

  /** Every lamp that is lit this frame, before anything is drawn: the shadows need to know where the light is. */
  function collectLights(g: Game, time: number) {
    lampN = 0;
    cast.fill(0);
    const s = g.s;
    // One big light by day: the sun, low in the east in the morning, overhead at noon, low in the west by evening.
    // It goes in behind the clouds when it rains, and it is gone by dark.
    const u = s.flags.nightSoon ? clamp(s.dayT / g.D.dayLen, 0, 1) : 0.3;
    const a = (160 - 140 * u) * Math.PI / 180;
    sun.x = Math.cos(a); sun.y = -Math.sin(a);
    const high = Math.sin(a);
    sun.power = clamp(1 - g.dark * 1.8, 0, 1) * (1 - g.rain * 0.85) * (g.blind ? 0 : 1);
    sun.len = clamp(0.42 / Math.max(0.3, high), 0.42, 1.3);
    sun.g = 0.84 + 0.12 * high; sun.b = 0.56 + 0.3 * high;           // golden when it is low
    if (g.dark <= 0.01) return;
    const waver = (k: number) => L.flicker * Math.sin(time * (7 + (k % 5)) + k * 2.1);
    if (s.peace > 44) lamp(WIN_X + 6, 20, 34, 1, WARM_WINDOW, 44);
    if (s.depth >= 20 && g.holeR > 0) lamp(HOLE.x, HOLE.y - 2, g.holeR + 16, 0.9 + 0.3 * Math.sin(time * 1.05), EMBER, HOLE.y);
    if (g.look.age < 2.6) lamp(g.look.x, g.look.y - 6, 30, 1 - g.look.age / 2.6, COOL, g.look.y);
    g.em.forEachArchetype([Pos, Gnome], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), role = field(Gnome.role), face = field(Gnome.face), st = field(Gnome.state);
      for (let i = 0; i < n; i++) {
        if (role[i] !== ROLE.lantern || st[i] === ST.DIG) continue;
        lamp(px[i] + face[i] * 7.5, py[i] - 6, 22, 1, WARM, py[i], waver(i));
      }
    });
    g.em.forEachArchetype([Pos, Critter], (_ids, n, field) => {
      const px = field(Pos.x), py = field(Pos.y), kind = field(Critter.kind);
      for (let i = 0; i < n; i++) if (kind[i] === CRITTER.firefly) lamp(px[i], py[i] - 8, 14, 0.9, FIREFLY, py[i] + 4, waver(i + 40));
    });
  }

  /** Where the things that stand have edges, and which way those edges face: from how near neighbouring pixels are. */
  function findEdges() {
    const H = (i: number) => (hts[i] ? hts[i] / 5 + 0.1 : 0);
    for (let y = 2; y < h - 2; y++) {
      const row = y * w;
      for (let x = 2; x < w - 2; x++) {
        const i = row + x;
        if (!hts[i]) { edge[i] = 0; continue; }
        const gx = H(i + 1) - H(i - 1) + 0.5 * (H(i + 2) - H(i - 2));
        const gy = H(i + w) - H(i - w) + 0.5 * (H(i + 2 * w) - H(i - 2 * w));
        const len = Math.hypot(gx, gy);
        if (len < 0.02) { edge[i] = 0; continue; }
        edge[i] = Math.min(255, len * 2 * 255);
        nrmX[i] = (-gx / len) * 127; nrmY[i] = (-gy / len) * 127;
      }
    }
  }

  function grade(g: Game) {
    const dark = g.dark;
    const dread = 1 - g.s.peace / 100;
    const ending = g.ending ? g.ending.t : 0;
    const px = fb.px;
    const n = w * h;
    const lit = dark > 0.01;
    // The colour of the light goes round with the clock: pink at dawn, clear at noon, gold in the afternoon,
    // orange and then purple as the sun goes, blue at night. Grey when it rains. The last night is red.
    const st = g.s;
    const u = !st.flags.nightSoon ? 0.3 : st.dayT > g.D.dayLen ? 0 : st.dayT / g.D.dayLen;
    let k = 0;
    while (k < DAY.length - 2 && u > DAY[k + 1][0]) k++;
    const f = clamp((u - DAY[k][0]) / (DAY[k + 1][0] - DAY[k][0]), 0, 1);
    let aR = lerp(DAY[k][1], DAY[k + 1][1], f), aG = lerp(DAY[k][2], DAY[k + 1][2], f), aB = lerp(DAY[k][3], DAY[k + 1][3], f);
    const nR = lerp(0.36, 0.5, ending), nG = lerp(0.41, 0.2, ending), nB = lerp(0.6, 0.24, ending);
    if (dark > 0) {
      // Through purple on the way down into the night, and on the way back up out of it.
      const half = Math.min(1, dark * 2), rest = Math.max(0, dark * 2 - 1);
      aR = lerp(lerp(aR, DUSK[0], half), nR, rest); aG = lerp(lerp(aG, DUSK[1], half), nG, rest); aB = lerp(lerp(aB, DUSK[2], half), nB, rest);
    }
    if (g.rain > 0) { const q = g.rain * 0.6 * (1 - dark); aR = lerp(aR, 0.8, q); aG = lerp(aG, 0.85, q); aB = lerp(aB, 0.93, q); }
    const tinted = !lit && (aR < 0.995 || aG < 0.995 || aB < 0.995);
    // The light is worked out afresh every third frame; nothing in the garden moves fast enough to show it.
    const sunny = sun.power > 0.03;
    const turn = tick++ % 3 === 0;
    if ((lit || sunny) && turn) findEdges();
    const fresh = lit && turn;
    if (fresh) {
      litR.fill(aR); litG.fill(aG); litB.fill(aB);
      rimR.fill(0); rimG.fill(0); rimB.fill(0);
      for (let k = 0; k < lampN; k++) {
        const o = k * LAMP;
        const lx = lamps[o], ly = lamps[o + 1], lr = lamps[o + 2], lp = lamps[o + 3] * Math.min(1, dark * 1.5);
        const cr = lamps[o + 4], cg = lamps[o + 5], cb = lamps[o + 6], foot = lamps[o + 7];
        const r2 = lr * lr;
        const x0 = Math.max(0, Math.floor(lx - lr)), x1 = Math.min(w - 1, Math.ceil(lx + lr));
        const y0 = Math.max(0, Math.floor(Math.min(ly, foot - lr * L.ground) - lr)), y1 = Math.min(h - 1, Math.ceil(Math.max(ly + lr, foot + lr * L.ground)));
        for (let y = y0; y <= y1; y++) {
          const gy = (foot - y) / L.ground;
          for (let x = x0; x <= x1; x++) {
            const i = y * w + x;
            const tall = hts[i];
            const dx = lx - x, dy = ly - y;
            // On the ground the pool is an ellipse round the lamp's foot; on what stands, a circle round the lamp.
            const d2 = tall ? dx * dx + dy * dy : dx * dx + gy * gy;
            if (d2 >= r2) continue;
            const v = FALL[(d2 / r2 * 255) | 0];
            const reach = Math.floor(v * L.steps + 0.5 + DITHER[((x & 1) << 1) | (y & 1)]) / L.steps;
            if (reach <= 0) continue;
            let lift = L.brightness * reach * lp;
            if (tall && edge[i]) {
              const d = Math.sqrt(d2) || 1;
              const facing = (nrmX[i] * dx + nrmY[i] * dy) / (d * 127);
              const e = edge[i] / 255;
              if (facing < 0) lift *= 1 + L.shade * e * facing;       // the side turned away gets less
              else { const rim = reach * e * facing * L.rim * lp; rimR[i] += cr * rim; rimG[i] += cg * rim; rimB[i] += cb * rim; }
            }
            litR[i] += (cr - aR) * lift; litG[i] += (cg - aG) * lift; litB[i] += (cb - aB) * lift;
          }
        }
      }
    }
    const desat = dread * 0.62 + g.rain * 0.12;
    const dim = (1 - dread * 0.2) * (1 - g.rain * 0.1);
    const vs = 0.1 + dread * 0.6;
    const sick = dread * 0.1;
    for (let i = 0; i < n; i++) {
      const c = px[i];
      let r = c & 255, gg = (c >> 8) & 255, b = (c >> 16) & 255;
      if (sunny) {
        if (hts[i]) {
          if (edge[i]) {
            // Sunlight: a warm rim on the edges turned to the sun, a little less light on the ones turned away.
            const facing = (nrmX[i] * sun.x + nrmY[i] * sun.y) / 127;
            const e = (edge[i] / 255) * sun.power;
            if (facing < 0) { const k = 1 + L.sunShade * e * facing; r *= k; gg *= k; b *= k; }
            else { const q = L.sunRim * e * facing; r = 255 - (255 - r) * (1 - q * sun.r); gg = 255 - (255 - gg) * (1 - q * sun.g); b = 255 - (255 - b) * (1 - q * sun.b); }
          }
        } else if (!lit && cast[i] > 0) {
          // Shade on the grass is cooler as well as darker.
          const sh = cast[i];
          r *= 1 - sh; gg *= 1 - sh * 0.9; b *= 1 - sh * 0.72;
        }
      }
      if (tinted) { r *= aR; gg *= aG; b *= aB; }
      if (lit) {
        // Shadows thrown on the ground take the lamp light away again, down toward the ambient.
        const sh = hts[i] ? 0 : cast[i];
        let mr = litR[i], mg = litG[i], mb = litB[i];
        if (sh > 0) { mr += (aR - mr) * sh; mg += (aG - mg) * sh; mb += (aB - mb) * sh; mr *= 1 - sh * 0.35; mg *= 1 - sh * 0.35; mb *= 1 - sh * 0.35; }
        r *= mr > 1.08 ? 1.08 : mr; gg *= mg > 1.08 ? 1.08 : mg; b *= mb > 1.08 ? 1.08 : mb;
        if (edge[i] && hts[i]) {
          // The rim is added like light on a screen: it brightens without washing out.
          const qr = rimR[i] > 1 ? 1 : rimR[i], qg = rimG[i] > 1 ? 1 : rimG[i], qb = rimB[i] > 1 ? 1 : rimB[i];
          r = 255 - (255 - r) * (1 - qr); gg = 255 - (255 - gg) * (1 - qg); b = 255 - (255 - b) * (1 - qb);
        }
      }
      if (desat > 0.01) {
        const gray = r * 0.3 + gg * 0.59 + b * 0.11;
        r = (r + (gray - r) * desat) * dim * (1 + sick);
        gg = (gg + (gray - gg) * desat) * dim;
        b = (b + (gray - b) * desat) * dim * (1 - sick);
      }
      const v = 1 - vig[i] * vs;
      r *= v; gg *= v; b *= v;
      px[i] = (0xff000000 | ((b > 255 ? 255 : b) << 16) | ((gg > 255 ? 255 : gg) << 8) | (r > 255 ? 255 : r)) >>> 0;
    }
  }

  /** Mist lying low over the lawn, drifting: between the things that stand, not over them. */
  function drawFog(g: Game, time: number) {
    const s = g.s;
    const amount = clamp((72 - s.peace) / 70, 0, 1) * (0.1 + 0.3 * g.dark + 0.15 * g.rain);
    if (amount < 0.02) return;
    const px = fb.px;
    const a1 = (time * 5) | 0, a2 = (time * 3) | 0;
    for (let y = 30 * Z; y < h; y++) {
      const ny = (y >> 2) & 63, ny2 = ((y / 3) | 0) & 63;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (hts[i]) continue;
        const nse = 0.6 * NOISE[(ny << 6) | (((x + a1) >> 2) & 63)] + 0.4 * NOISE[(ny2 << 6) | ((((x - a2) / 5) | 0) & 63)];
        const a = (nse - 0.42) * 2.4 * amount;
        if (a <= 0.01) continue;
        const k = a > 0.6 ? 0.6 : a;
        const c = px[i];
        const r = c & 255, gg = (c >> 8) & 255, b = (c >> 16) & 255;
        px[i] = (0xff000000 | ((b + (FOG_B - b) * k) << 16) | ((gg + (FOG_G - gg) * k) << 8) | (r + (FOG_R - r) * k)) >>> 0;
      }
    }
  }

  /** Rain: slanting streaks, and a small crown where a drop lands on the lawn. */
  function drawRain(g: Game, time: number) {
    const rain = g.rain;
    if (rain < 0.02) return;
    const count = Math.round(RAIN.count * rain * (w * h) / (288 * 448));
    for (let i = 0; i < count; i++) {
      const fall = (hash01(i * 13 + 1) + time * (1.5 + hash01(i * 3) * 0.7)) % 1;
      const y = fall * (h + 40) - 20;
      const x = hash01(i * 7 + 3) * (w + 140) - 20 - y * RAIN.slant;
      for (let k = 0; k < RAIN.length; k++) fb.mix(x + k * RAIN.slant, y - k, RAIN_C, RAIN.alpha * (1 - k / RAIN.length));
    }
    const hits = Math.round(RAIN.hits * rain);
    for (let i = 0; i < hits; i++) {
      const at = time / 0.18 + hash01(i * 5 + 2);
      const slot = Math.floor(at), age = at - slot;
      const x = Math.floor(hash01(i * 31 + slot * 17) * w), y = 34 * Z + Math.floor(hash01(i * 11 + slot * 29) * (h - 34 * Z));
      if (age < 0.4) fb.mix(x, y, SPLASH_C, 0.7);
      else { fb.mix(x - 1, y - 1, SPLASH_C, 0.6); fb.mix(x + 1, y - 1, SPLASH_C, 0.6); fb.mix(x, y, SPLASH_C, 0.25); }
    }
  }

  function drawGlow(g: Game, time: number) {
    const s = g.s;
    const dark = g.dark;
    const dread = 1 - s.peace / 100;
    // The kitchen window: lit while there is someone in who wants a light on.
    const wx = ox + WIN_X * Z, wy = WIN_Y * Z, ww = WIN_W * Z, wh = WIN_H * Z;
    const pane = (x: number, y: number) => x !== (ww >> 1) && x !== (ww >> 1) - 1 && y !== 10 && y !== 11;
    if (dark > 0.3) {
      if (s.peace > 44) {
        for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) if (pane(x, y)) fb.mix(wx + x, wy + y, C.glassLit, dark * 0.9);
      } else {
        // Somebody stands at it in the dark. Later, somebody shorter.
        for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) if (pane(x, y)) fb.mix(wx + x, wy + y, C.glassDark, dark);
        if (s.peace > 16) {
          fb.ellipse(wx + 19, wy + 11, 3, 3.5, hex('#4a4f5e'));
          fb.rect(wx + 14, wy + 14, 11, 10, hex('#3a3f4e'));
        } else {
          for (let k = 0; k < 9; k++) fb.rect(wx + 19 - (k >> 1), wy + 3 + k, 1 + k, 1, C.hatDark);
          fb.rect(wx + 14, wy + 12, 11, 4, hex('#3a2a30'));
          fb.rect(wx + 16, wy + 13, 2, 2, C.eyeRed); fb.rect(wx + 21, wy + 13, 2, 2, C.eyeRed);
        }
      }
    }
    if (dark > 0.4) {
      for (let i = 0; i < 40; i++) {
        const x = Math.floor(hash01(i * 71 + 5) * w), y = Math.floor(hash01(i * 37 + 1) * 22);
        if (x < X(COTTAGE_W + 6)) continue;
        if (Math.sin(time * (0.6 + hash01(i) * 1.5) + i) > -0.5) fb.mix(x, y, C.star, dark * 0.8);
      }
      // Late on there are eyes in the hedge as well.
      const pairs = Math.floor(clamp((dread - 0.42) * 22, 0, 12));
      for (let i = 0; i < pairs; i++) {
        const x = X(COTTAGE_W + 8) + Math.floor(hash01(i * 97 + 3) * (w - X(COTTAGE_W + 8) - 16));
        const y = 30 + Math.floor(hash01(i * 41 + 7) * 16);
        if (Math.sin(time * 0.7 + i * 2.3) > -0.7) { fb.rect(x, y, 2, 2, C.eyeRed); fb.rect(x + 5, y, 2, 2, C.eyeRed); }
      }
    }
    // Every pair of eyes that was queued while drawing the gnomes.
    for (let i = 0; i < eyeN; i++) {
      const kind = eyes[i * 3 + 2];
      if (kind === 0) continue;
      const ex = eyes[i * 3], ey = eyes[i * 3 + 1];
      if (hat.hh > 0 && kind !== 3) {
        // Eyes behind the hat stay behind it.
        const k = (ey - (hat.base - hat.hh)) / hat.hh;
        if (ey + 14 <= hat.base && k > 0 && Math.abs(ex - hat.cx) <= hat.hw * k + 1) continue;
      }
      const c = kind === 3 ? C.lampCore : kind === 2 ? C.eyeRed : C.eyePale;
      const a = kind === 3 ? clamp(dark * 1.5, 0, 1) : clamp((dark - 0.3) * 1.6, 0, kind === 2 ? 1 : 0.75);
      fb.mix(ex, ey, c, a); fb.mix(ex + 1, ey, c, a); fb.mix(ex, ey + 1, c, a * 0.8); fb.mix(ex + 1, ey + 1, c, a * 0.8);
    }
    eyeN = 0;
  }

  function drawPopups(g: Game) {
    for (const p of g.popups) {
      if (p.life < 0.25 && Math.floor(p.life * 30) % 2) continue;
      const tw = textWidth(p.text, 2);
      text(fb, p.text, clamp(X(p.x) - (tw >> 1), 2, w - tw - 2), Y(p.y), TEXT_COLORS[p.color] ?? C.white, C.ink, 2);
    }
  }

  function unsettle(g: Game, time: number) {
    const s = g.s;
    const px = fb.px;
    // The lawn rises and falls.
    if (s.flags.breath && !g.ending && Math.sin(time * 1.05) > 0.55) {
      const from = 46 * Z * w;
      px.copyWithin(from + Z * w, from, (h - Z) * w);
    }
    // Very late on, the picture itself slips.
    if (s.peace < 18 && hash01(Math.floor(time * 12)) < 0.05 + (18 - s.peace) * 0.006) {
      const y0 = Math.floor(hash01(Math.floor(time * 12) + 9) * (h - 20));
      const shift = hash01(Math.floor(time * 12) + 4) > 0.5 ? 6 : -6;
      for (let y = y0; y < y0 + 10 + Math.floor(hash01(y0) * 12) && y < h; y++) {
        if (shift > 0) px.copyWithin(y * w + shift, y * w, y * w + w - shift);
        else px.copyWithin(y * w, y * w - shift, y * w + w);
      }
    }
    if (g.fx.shake > 0.02) {
      const amp = Math.min(8, g.fx.shake * 6);
      const sx = Math.round((hash01(Math.floor(time * 60)) - 0.5) * 2 * amp);
      const sy = Math.round((hash01(Math.floor(time * 60) + 77) - 0.5) * 2 * amp);
      const off = sy * w + sx;
      if (off > 0) px.copyWithin(off, 0, w * h - off);
      else if (off < 0) px.copyWithin(0, -off, w * h);
    }
    if (g.fx.flash > 0.01) {
      const a = Math.min(1, g.fx.flash);
      for (let i = 0; i < w * h; i++) {
        const c = px[i];
        const r = c & 255, gg = (c >> 8) & 255, b = (c >> 16) & 255;
        px[i] = (0xff000000 | ((b + (255 - b) * a) << 16) | ((gg + (255 - gg) * a) << 8) | (r + (255 - r) * a)) >>> 0;
      }
    }
  }

  /** Asleep or looking away: eyelids come down, and the garden is only a dim shape behind them. */
  function shutEyes(g: Game, time: number) {
    // Asleep, the lids follow the dark; looking away, they take half a second to shut and open.
    const left = g.s.buff.away ?? 0;
    const shut = left > 0 ? Math.min(clamp((12 - left) / 0.5, 0, 1), clamp(left / 0.3, 0, 1)) : g.lids;
    const lid = Math.round((h / 2) * shut);
    const px = fb.px;
    for (let y = 0; y < h; y++) {
      const covered = y < lid || y >= h - lid;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (covered) { px[i] = LID; continue; }
        const c = px[i];
        px[i] = (0xff000000 | (((c >> 16) & 255) * 0.3 << 16) | (((c >> 8) & 255) * 0.25 << 8) | ((c & 255) * 0.3)) >>> 0;
      }
    }
    const msg = left > 0 ? 'TAP TO PEEK' : g.s.flags.restless ? 'Z Z Z ...?' : 'Z Z Z';
    if (lid >= h / 2 - 1) text(fb, msg, (w - textWidth(msg, 2)) >> 1, (h >> 1) - 6 + (g.asleep ? Math.round(Math.sin(time * 2) * 3) : 0), hex('#5a4650'), LID, 2);
  }

  /** You open your eyes and one of them is right there. */
  function scare(g: Game) {
    const f = S.GNOME[0][2].stand;
    const k = Math.floor(Math.min(w / f.w, h / f.h)) + 1;
    const x0 = (w - f.w * k) >> 1, y0 = (h - f.h * k) >> 1;
    const a = Math.min(1, g.fx.scare / 0.12);
    for (let y = 0; y < f.h * k; y++)
      for (let x = 0; x < f.w * k; x++) {
        const c = f.px[Math.floor(y / k) * f.w + Math.floor(x / k)];
        if (c) fb.mix(x0 + x, y0 + y, c, a);
      }
  }

  // ------------------------------------------------------------ a frame

  function render(g: Game, time: number) {
    const s = g.s;
    const dread = Math.round((1 - s.peace / 100) * 8) / 8;
    const key = `${s.plots}|${dread}|${g.holeR > 0 ? 1 : 0}|${cottageLook}`;
    if (key !== bgKey) { bgKey = key; buildBackground(g, dread); }
    fb.px.set(bg);
    hts.set(hbg);
    collectLights(g, time);

    drawHole(g, time);

    // Props on the doorstep.
    stand(s.blooms > 0 ? S.BASKET_FULL : S.BASKET, BASKET.x, BASKET.y);
    if (S.SIGN) stand(S.SIGN, SIGN.x, SIGN.y);
    if (s.flags.teeth) stand(S.JAR[s.teeth > 500 ? 3 : s.teeth > 40 ? 2 : s.teeth > 0 ? 1 : 0], JAR.x, JAR.y);

    gatherFlowers(g, time);
    gatherGnomes(g, time);
    gatherVisitors(g, time);
    gatherCritters(g, time);
    // The hat comes up through the crowd: whoever stands behind the hole is behind it.
    const mid = Y(HOLE.y + g.holeR * HOLE_RY * 0.3) + 2;
    drawSorted(-PAD, mid);
    drawHat(g, time);
    drawSorted(mid, rows);
    cullEyes();
    drawSparks(g);

    drawFog(g, time);
    grade(g);
    drawRain(g, time);
    drawGlow(g, time);
    drawPopups(g);
    unsettle(g, time);
    if (g.blind || g.lids > 0) shutEyes(g, time);
    if (g.fx.scare > 0) scare(g);
  }

  return { fb, toWorld: (fx, fy) => ({ x: (fx - ox) / Z, y: fy / Z }), render, setCottage: (look) => { cottageLook = look; } };
}

// How light behaves, after testp's: the bands a pool falls off in, how strongly a lamp lifts what it reaches, how fast
// it fades, how much it wavers, the rim on edges that face it, the shade on sides that do not, how flat its pool lies
// on the ground, and the shadows things throw away from it.
const L = { steps: 5, brightness: 1.25, falloff: 1.4, flicker: 0.04, rim: 0.5, shade: 0.5, ground: 0.6, shadow: 0.7, short: 0.3, long: 1.4, near: 14, sunRim: 0.42, sunShade: 0.3, sunShadow: 0.38 };
// The colour of daylight by the time of day: [how far through the day, red, green, blue].
const DAY = [[0, 1, 0.84, 0.8], [0.12, 1, 0.94, 0.86], [0.3, 1, 1, 0.97], [0.55, 1, 1, 1], [0.8, 1, 0.94, 0.8], [1, 1, 0.8, 0.64]];
// What the light passes through between day and night.
const DUSK = [0.74, 0.52, 0.72];
const FALL = new Float32Array(256).map((_, i) => Math.pow(Math.max(0, 1 - Math.sqrt(i / 255)), L.falloff));
const DITHER = [-0.15, -0.05, 0.05, 0.15];
const WARM = [1, 0.8, 0.5], WARM_WINDOW = [1, 0.86, 0.58], EMBER = [0.9, 0.22, 0.16], COOL = [0.82, 0.9, 1], FIREFLY = [0.85, 0.96, 0.45];
const RAIN = { count: 300, slant: 0.25, length: 7, alpha: 0.45, hits: 40 };
const RAIN_C = hex('#b4c0d6'), SPLASH_C = hex('#d2dcee');
const FOG_R = 0x9a, FOG_G = 0xa2, FOG_B = 0xb0;
/** A 64 by 64 tile of smooth noise, for the mist. */
const NOISE = (() => {
  const out = new Float32Array(64 * 64);
  const at = (x: number, y: number) => hash01((x & 7) * 53 + (y & 7) * 311 + 5);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const gx = x / 8, gy = y / 8, x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = smooth(gx - x0), fy = smooth(gy - y0);
      out[y * 64 + x] = lerp(lerp(at(x0, y0), at(x0 + 1, y0), fx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
    }
  return out;
})();

const solid = (wd: number, ht: number, c: number): Frame => ({ w: wd, h: ht, px: new Uint32Array(wd * ht).fill(c) });
const PUPIL: Frame = solid(2, 2, hex('#0b0609'));
const TOOTH: Frame = (() => {
  const a = hex('#ffffff'), b = hex('#e6dfd0'), c = hex('#cfc6b4');
  return { w: 4, h: 4, px: new Uint32Array([0, a, a, 0, a, a, a, b, a, a, b, c, 0, b, c, 0]) };
})();

/** A small speech bubble with a heart in it: somebody would like to be said hello to. */
const HELLO: Frame = (() => {
  const wht = hex('#fffdf5'), shade = hex('#e2dccb'), pink = hex('#f083aa'), deep = hex('#c84f7e');
  const art = [
    '..wwwwwwwwww..',
    '.wwwwwwwwwwww.',
    'wwwppwwwwppwww',
    'wwppppwwppppww',
    'wwppppppppppww',
    'wwwppppppppPww',
    'wwwwppppppPwww',
    'wwwwwppppPwwww',
    'wwwwwwppPwwwws',
    '.wwwwwwwwwwws.',
    '..wwwwwwwwss..',
    '...www........',
    '...ww.........',
  ];
  const px = new Uint32Array(14 * art.length);
  art.forEach((r, y) => [...r].forEach((ch, x) => { px[y * 14 + x] = ch === 'w' ? wht : ch === 's' ? shade : ch === 'p' ? pink : ch === 'P' ? deep : 0; }));
  return { w: 14, h: art.length, px };
})();

/** What a gnome carries back, by the best flower in the beds. */
const BUNCH: Frame[] = ['#f7f1e3', '#f083aa', '#f8d24c', '#d5392f', '#d5392f', '#f7f1e3', '#f0b98d', '#9d2431', '#d5392f'].map((c) => {
  const col = hex(c), leaf = hex('#3f7f32'), stem = hex('#6fb646');
  const art = ['cc..cc', 'cc..cc', '..cc..', '..cc..', '..sl..', '..ll..'];
  const px = new Uint32Array(36);
  art.forEach((r, y) => [...r].forEach((ch, x) => { px[y * 6 + x] = ch === 'c' ? col : ch === 'l' ? leaf : ch === 's' ? stem : 0; }));
  return { w: 6, h: 6, px };
});
