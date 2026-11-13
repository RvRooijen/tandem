// A drawing, drawn in the page from its text: every animation a row, its
// frames side by side. This is what makes watching a worker live possible: the
// text arrives as it is typed, and each version that can be read is shown.
// The parser is pixeldraw's, the same one the engine renders and builds with.
import { recolor } from '../art/src/attach.js';
import { looksOf, parseArt } from '../art/src/parse.js';

interface Art {
  width: number; height: number;
  anims: { name: string; frames: number[] }[];
  frames: { pixels: (number[] | null)[][] }[];
}

/**
 * Draw a drawing's text on a canvas: every look (colour variant) a block, one under the other, in the order it
 * gives back. Null when the text cannot be read (half-typed): the canvas keeps what it had.
 */
export function drawArt(canvas: HTMLCanvasElement, text: string, maxWidth = 480): string[] | null {
  let art: Art;
  try { art = parseArt(text) as Art; } catch { return null; }
  if (!art.width || !art.height || !art.frames.length) return null;
  const named = looksOf(art) as string[];
  const looks = named.length ? named : ['default'];
  let variants: Art[];
  try { variants = looks.map((l) => (l === 'default' ? art : recolor(art, l) as Art)); } catch { return null; }
  const anims = art.anims.length ? art.anims : [{ name: 'main', frames: art.frames.map((_f, i) => i) }];
  // One row per animation, per look.
  const rows = variants.flatMap((v) => anims.map((a) => ({ art: v, frames: a.frames })));
  const cols = Math.max(...rows.map((r) => r.frames.length));
  const gap = 1;
  const w = cols * (art.width + gap) + gap, h = rows.length * (art.height + gap) + gap;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = w;
  canvas.height = h;
  const img = ctx.createImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  // A dark check, so what is see-through shows.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = ((x >> 2) + (y >> 2)) & 1 ? 0xff3c3232 : 0xff332a2a;
  rows.forEach((row, r) => row.frames.forEach((f, c) => {
    const ox = gap + c * (art.width + gap), oy = gap + r * (art.height + gap);
    row.art.frames[f]?.pixels.forEach((line, y) => line.forEach((p, x) => {
      if (!p || y >= art.height || x >= art.width) return;
      const a = (p[3] ?? 255) / 255, at = (oy + y) * w + ox + x, under = px[at];
      const mix = (c1: number, shift: number) => Math.round(c1 * a + ((under >> shift) & 255) * (1 - a));
      px[at] = ((255 << 24) | (mix(p[2], 16) << 16) | (mix(p[1], 8) << 8) | mix(p[0], 0)) >>> 0;
    }));
  }));
  ctx.putImageData(img, 0, 0);
  // As large as fits, in whole pixels, so it stays crisp.
  const scale = Math.max(1, Math.min(10, Math.floor(maxWidth / w)));
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
  return looks;
}
