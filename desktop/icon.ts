// The window's icon from its drawing (desktop/icon.txt, in pixeldraw's format like every drawing in tandem):
// icon.png for the window, icon.ico for Windows' shortcuts and taskbar. Run it again when the drawing changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArt } from '../art/src/parse.js';
import { encodePng } from '../core/png.ts';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const art = parseArt(readFileSync(here('icon.txt'), 'utf8')) as { width: number; height: number; frames: { pixels: (number[] | null)[][] }[] };
const { width: w, height: h } = art;
const px = new Uint32Array(w * h);
art.frames[0].pixels.forEach((row, y) => row.forEach((c, x) => {
  if (c) px[y * w + x] = (((c[3] ?? 255) << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
}));

/** The drawing at a size: larger in whole pixels, smaller by taking every so many. */
function at(size: number): Buffer {
  if (size >= w) return encodePng(px, w, h, size / w, true);
  const step = w / size, small = new Uint32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) small[y * size + x] = px[Math.floor((y + 0.5) * step) * w + Math.floor((x + 0.5) * step)];
  return encodePng(small, size, size, 1, true);
}

writeFileSync(here('icon.png'), at(256));
// An .ico of PNGs, one per size Windows asks for.
const sizes = [256, 128, 64, 48, 32, 16], pngs = sizes.map(at);
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((size, i) => {
  const o = 6 + 16 * i;
  head[o] = size & 255; head[o + 1] = size & 255;
  head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(pngs[i].length, o + 8); head.writeUInt32LE(offset, o + 12);
  offset += pngs[i].length;
});
writeFileSync(here('icon.ico'), Buffer.concat([head, ...pngs]));
console.log('desktop/icon.png and desktop/icon.ico');
