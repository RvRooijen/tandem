// A software framebuffer: the garden is drawn into a small Uint32Array, one
// entry per pixel, and the browser only scales it up. No canvas calls, so the
// same code renders in node for tests and screenshots.

/** Pixels are 0xAABBGGRR (little-endian RGBA). 0 is transparent. */
export const rgb = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

export function hex(s: string): number {
  const n = parseInt(s.replace('#', ''), 16);
  return rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** A drawing. `d`, when it has one, is its depth map: per pixel how near it is, 1 (far) to 5 (near), 0 where there is nothing. */
export interface Frame { w: number; h: number; px: Uint32Array; d?: Uint8Array }

/** Build a frame from rows of characters and a palette. '.' and ' ' are transparent. */
export function frame(rows: readonly string[], pal: Record<string, number>): Frame {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === '.' || ch === ' ') continue;
      const c = pal[ch];
      if (c === undefined) throw new Error(`sprite uses '${ch}', which is not in the palette`);
      px[y * w + x] = c;
    }
  return { w, h, px };
}

/** A copy of a frame with some colours swapped. */
export function recolor(f: Frame, swaps: readonly (readonly [number, number])[]): Frame {
  const px = new Uint32Array(f.px);
  for (let i = 0; i < px.length; i++)
    for (const [from, to] of swaps) if (px[i] === from) { px[i] = to; break; }
  return { w: f.w, h: f.h, px, d: f.d };
}

export class FB {
  w: number;
  h: number;
  px: Uint32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint32Array(w * h);
  }

  set(x: number, y: number, c: number) {
    x |= 0; y |= 0;
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c;
  }

  get(x: number, y: number): number {
    x |= 0; y |= 0;
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[y * this.w + x] : 0;
  }

  rect(x: number, y: number, w: number, h: number, c: number) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) this.px.fill(c, yy * this.w + x0, yy * this.w + Math.max(x0, x1));
  }

  /** A filled ellipse centred on (cx, cy). */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: number) {
    if (rx <= 0 || ry <= 0) return;
    const y0 = Math.max(0, Math.ceil(cy - ry)), y1 = Math.min(this.h - 1, Math.floor(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const t = (y - cy) / ry;
      const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
      const x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(this.w, Math.round(cx + half) + 1);
      if (x1 > x0) this.px.fill(c, y * this.w + x0, y * this.w + x1);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: number) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Draw a frame with its top-left at (x, y). */
  blit(f: Frame, x: number, y: number, flip = false) {
    x |= 0; y |= 0;
    const { w, h, px } = f;
    const W = this.w, H = this.h, out = this.px;
    for (let sy = 0; sy < h; sy++) {
      const dy = y + sy;
      if (dy < 0 || dy >= H) continue;
      const row = sy * w, drow = dy * W;
      for (let sx = 0; sx < w; sx++) {
        const c = px[row + (flip ? w - 1 - sx : sx)];
        if (!c) continue;
        const dx = x + sx;
        if (dx >= 0 && dx < W) out[drow + dx] = c;
      }
    }
  }

  /** Draw a frame standing on (x, y): centred, feet on y. */
  stand(f: Frame, x: number, y: number, flip = false) {
    this.blit(f, Math.round(x) - (f.w >> 1), Math.round(y) - f.h + 1, flip);
  }

  /** Darken a pixel: a cheap shadow. */
  shade(x: number, y: number, keep = 0.72) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    const c = this.px[i];
    this.px[i] = rgb((c & 255) * keep, ((c >> 8) & 255) * keep, ((c >> 16) & 255) * keep);
  }

  /** Mix a colour into a pixel. */
  mix(x: number, y: number, c: number, a: number) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    const d = this.px[i];
    const r = (d & 255) + ((c & 255) - (d & 255)) * a;
    const g = ((d >> 8) & 255) + (((c >> 8) & 255) - ((d >> 8) & 255)) * a;
    const b = ((d >> 16) & 255) + (((c >> 16) & 255) - ((d >> 16) & 255)) * a;
    this.px[i] = rgb(r, g, b);
  }
}

// ---------------------------------------------------------------- a 3x5 font

const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111',
  '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110', '4': '101101111001001',
  '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  '+': '000010111010000', '-': '000000111000000', '.': '000000000000010', '!': '010010010000010', '?': '110001010000010',
};

export function textWidth(s: string, scale = 1): number {
  return (s.length * 4 - 1) * scale;
}

/** Draw text with its top-left at (x, y), with a dark edge so it reads on anything. */
export function text(fb: FB, s: string, x: number, y: number, c: number, edge = 0xff20151f, scale = 1) {
  x |= 0; y |= 0;
  for (let pass = 0; pass < 2; pass++) {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = GLYPHS[ch];
      if (g) {
        for (let i = 0; i < 15; i++) {
          if (g[i] !== '1') continue;
          const px = cx + (i % 3) * scale, py = y + ((i / 3) | 0) * scale;
          if (pass === 0) fb.rect(px - 1, py - 1, scale + 2, scale + 2, edge);
          else fb.rect(px, py, scale, scale, c);
        }
      }
      cx += 4 * scale;
    }
  }
}
