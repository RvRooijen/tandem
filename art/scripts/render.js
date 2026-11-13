// Usage: node scripts/render.js <art.txt> [scale] [--grid] [--crop=x,y,w,h] [--anim=<name>,...] [--frame=<n>] [--with=<attachment[:recolor],...>|all] [--recolor=<name>]
// Writes out/<name>.png: upscaled art on a checkerboard, plus a 2x preview below.
// --crop renders only that part of the canvas, to zoom in. Depth maps (depth/<name>.txt) go to out/depth/.
// --anim renders only those animations (with their rows on the base and recolor rows), --frame only frame n
// (from 1) of each; the grid file then holds only those frames too.
// The depth map of a skin (depth/<skin>.txt, also when it doesn't exist yet) renders as the depth the skin gets:
// see-through what it takes from its base, solid its own depth map, red where it is outside the body without
// a depth; its grid file shows that as 1-5, a-e and ! (see SKIN_LEGEND).
// Animations render as a grid: one row per animation, its frames left to right, separated by dark gaps.
// An attachment (`@base <project>`) renders two rows per animation: the attachment alone, then on its base.
// A pinned attachment (`@pin`) renders its image alone, then one row per animation of its base.
// Anchors of a base (`@anchor`) and the pin of a pinned attachment are marked with a magenta dot.
// --with puts other attachments of the same base on too (`all`: the first of every slot), one per slot: on an
// attachment its rows on the base show the whole outfit, a base renders dressed.
// --recolor renders the art in one of its color variants (`@recolor`), with its detail layers (`@variant`), and
// the grid file shows that variant; on a depth map the depth of that variant's detail layers. Without it, an
// attachment with recolors gets one extra row per look (see looksOf): its first animation on the base.
// With `@ref <png>` in the art, the reference is shown in an extra column, scaled down to the canvas size.
// A tilesheet (`@tiles`) shows its tile borders, and under the frames every `@strip` put together at length (start,
// the middle three times, end), to check that the tiles join without a seam.
// Next to the PNG goes <name>.grid.txt: every frame's final char grid (after all shapes) with x/y rulers,
// to find exact pixels to fix instead of guessing them from the image.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parseArt, parseGrids, compareGrids, draftOf, chainOf, looksOf, variantOf, SLOTS, SHARED_PIVOT } from '../src/parse.js';
import { stripPixels } from '../src/tiles.js';
import { compose, layerOf, attachmentsOf, recolor, splitItem, skinDepth, skinDepthText, variantDepth, TONES, MISSING } from '../src/attach.js';
import { sendEvent } from './bus.js';
import { encodePng } from './png.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const grid = args.includes('--grid');
if (!file) {
  console.error('Usage: node scripts/render.js <art.txt> [scale] [--grid] [--crop=x,y,w,h] [--anim=<name>,...] [--frame=<n>] [--with=<attachment,...>|all]');
  process.exit(1);
}

const name = basename(file, extname(file));
const isDepth = /(^|[/\\])depth[/\\]/.test(file);
const load = (dir, n) => (existsSync(`${dir}/${n}.txt`) ? parseArt(readFileSync(`${dir}/${n}.txt`, 'utf8')) : null);
const skinArt = isDepth ? load('art', name) : null;
const skin = skinArt?.slot === 'skin' ? skinArt : null;
const text = existsSync(file) ? readFileSync(file, 'utf8') : skin ? skinDepthText(name, skin) : readFileSync(file, 'utf8');
const parsed = parseArt(text);
const recolorArg = args.find((a) => a.startsWith('--recolor='))?.slice(10);
// The variant's recolors (see chainOf); a depth map takes the depth of their detail layers
const variantChain = (recolorArg && chainOf(isDepth ? skinArt : parsed, recolorArg)) || (isDepth && recolorArg ? [recolorArg] : null);
let art = skin
  ? skinDepth(recolor(skin, recolorArg), variantDepth(parsed, variantChain), load('art', skin.base), load('depth', skin.base))
  : isDepth
    ? variantDepth(parsed, variantChain)
    : parsed;
// The skin's depth view as chars: its own depth 1-5, from the base a-e, ! missing
const SKIN_LEGEND = "// 1-5: the skin's own depth map, a-e: depth of the base (a = 1 .. e = 5), !: outside the body without a depth (red), .: no pixel of the skin";
const skinGrids = skin && {
  width: art.width,
  anims: art.anims.map(({ name }) => ({ name })),
  frames: art.frames.map((f) => ({
    anim: f.anim,
    duration: f.duration,
    chars: f.pixels.map((row) =>
      row.map((c) => {
        if (!c) return '.';
        if (c.every((v, i) => v === MISSING[i])) return '!';
        const t = TONES.findIndex((h) => [1, 3, 5].every((i, k) => parseInt(h.slice(i, i + 2), 16) === c[k]));
        return c[3] === 255 ? String(t + 1) : 'abcde'[t];
      })
    ),
  })),
};
if (recolorArg && !isDepth) {
  if (!art.recolors[recolorArg]) throw new Error(`--recolor: no recolor "${recolorArg}" (${Object.keys(art.recolors).join(', ') || 'none'})`);
  art = recolor(art, recolorArg);
}
const animArg = args.find((a) => a.startsWith('--anim='))?.slice(7).split(',').filter(Boolean);
const frameArg = args.find((a) => a.startsWith('--frame='))?.slice(8);
const frameNo = frameArg && Number(frameArg);
if (frameArg && !(Number.isInteger(frameNo) && frameNo >= 1)) throw new Error('--frame needs a frame number, from 1');
// An attachment with a pivot image shows its base's animations (with its own frames where it has them)
const animsOf = (art.pin && load('art', art.base)?.anims) || art.anims;
const missingAnim = animArg?.find((n) => !animsOf.some((a) => a.name === n));
if (missingAnim) throw new Error(`--anim: no animation "${missingAnim}" (${animsOf.map((a) => a.name).join(', ')})`);
// Magenta dots per frame: the anchors of a base, the pin on an attachment's pivot images
const marks = new Map(art.base ? art.frames.flatMap((f, i) => (f.pin ? [[i, [f.pin]]] : [])) : art.frames.map((f, i) => [i, Object.values(f.anchors).map((a) => [a.x, a.y])]));

// --with: other attachments of the base, at most one per slot; the art's own slot is taken by itself
const baseName = art.base ?? draftOf(name)?.project ?? name;
const withArg = args.find((a) => a.startsWith('--with='))?.slice(7);
const others = [];
if (withArg && !isDepth) {
  const all = () =>
    Object.fromEntries(readdirSync('art').filter((f) => f.endsWith('.txt')).flatMap((f) => {
      try {
        return [[f.slice(0, -4), parseArt(readFileSync(`art/${f}`, 'utf8'))]];
      } catch {
        return [];
      }
    }));
  const taken = new Set(art.base ? [art.slot] : []);
  for (const item of withArg === 'all' ? attachmentsOf(baseName, all()) : withArg.split(',').filter(Boolean)) {
    const { name: n, colors } = splitItem(item);
    const a = load('art', n);
    if (!a) throw new Error(`--with: art/${n}.txt not found`);
    if (a.base !== baseName) throw new Error(`--with: ${n} is not an attachment of ${baseName}`);
    if (colors && !a.recolors[colors]) throw new Error(`--with: ${n} has no recolor "${colors}"`);
    if (n === name || taken.has(a.slot)) continue;
    taken.add(a.slot);
    others.push([n, recolor(a, colors)]);
  }
}
// Layers of the base with the other attachments and `own`, in slot order. A depth-only base (a mannequin) shows
// faded, so the body is there to place things on (where the head is, where a hand grips) while what it wears
// stands out; it still hides what is behind it.
const faded = (art) => ({ ...art, frames: art.frames.map((f) => ({ ...f, pixels: f.pixels.map((row) => row.map((c) => c && [c[0], c[1], c[2], Math.round((c[3] ?? 255) * 0.35)])) })) });
const outfit = (base, own) => {
  const depths = Object.fromEntries([[baseName, load('depth', baseName)], ...[...others, ...own].map(([n]) => [n, load('depth', n)])]);
  const items = [...others, ...own].sort(([, a], [, b]) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  return [{ art: base.depthOnly ? faded(base) : base, depth: depths[baseName] }, ...items.map(([n, a]) => layerOf(n, a, depths, base))];
};
const wearing = others.length ? ` with ${others.map(([n]) => n).join(', ')}` : '';

if (!art.base && others.length) {
  const [, ...items] = outfit(art, []);
  art = compose(art, [{ art, depth: load('depth', name) }, ...items]);
  art.anims = art.anims.map((a) => ({ ...a, name: `${a.name}${wearing}` }));
}
if (art.base && !isDepth) {
  const base = load('art', art.base);
  if (!base) throw new Error(`@base ${art.base}: art/${art.base}.txt not found`);
  const on = compose(art.pin ? base : art, outfit(base, [[name, art]]));
  const n = art.frames.length;
  const onBase = (a) => ({ name: `${a.name} on ${art.base}${wearing}`, frames: on.anims.find((b) => b.name === a.name).frames.map((f) => f + n) });
  // The attachment alone goes on the same (possibly grown) canvas, where the base's (0, 0) is
  const [ox, oy] = on.offset;
  const pad = (pixels) => Array.from({ length: on.height }, (_, y) => Array.from({ length: on.width }, (_, x) => pixels[y - oy]?.[x - ox] ?? null));
  // Each color variant: the first animation on the base (same canvas: it only swaps colors)
  const variants = recolorArg ? [] : looksOf(art);
  const first = on.anims[0];
  const variantFrames = variants.flatMap((r) => {
    const v = compose(art.pin ? base : art, outfit(base, [[name, recolor(art, r)]]));
    return first.frames.map((f) => v.frames[f]);
  });
  const k = n + on.frames.length;
  art = {
    ...art,
    width: on.width,
    height: on.height,
    offset: on.offset,
    frames: [...art.frames.map((f) => ({ ...f, pixels: pad(f.pixels) })), ...on.frames, ...variantFrames],
    anims: [
      // With pivot images: the shared one alone, then per animation of the base its own frames or own pivot image
      // alone (where it has them) and the attachment on the base
      ...(art.pin
        ? [...art.anims.filter((a) => !base.anims.some((b) => b.name === a.name)), ...base.anims.flatMap((b) => [...art.anims.filter((a) => a.name === b.name), onBase(b)])]
        : art.anims.flatMap((a) => [a, onBase(a)])),
      ...variants.map((r, i) => ({ name: `${first.name} on ${art.base} · ${r}`, frames: first.frames.map((_, j) => k + i * first.frames.length + j) })),
    ],
  };
}
// --anim and --frame: only those rows (a row of an animation is named after it, with what follows after a
// space) and that frame of each
const picked = (rowName) => !animArg || (art.pin && SHARED_PIVOT.includes(rowName)) || animArg.some((n) => rowName === n || rowName.startsWith(`${n} `));
art = {
  ...art,
  anims: art.anims
    .filter((a) => picked(a.name))
    .map((a) => (frameNo ? { ...a, frames: a.frames.slice(frameNo - 1, frameNo) } : a))
    .filter((a) => a.frames.length),
};
if (!art.anims.length) throw new Error(`--frame ${frameNo}: no animation has that many frames`);
// Marks and --crop are in the base's coordinates; a grown canvas has the base's (0, 0) at `offset`
const [shiftX, shiftY] = art.offset ?? [0, 0];
for (const [f, list] of marks) marks.set(f, list.map(([x, y]) => [x + shiftX, y + shiftY]));
const cropArg = args.find((a) => a.startsWith('--crop='));
const cropBox = cropArg && cropArg.slice(7).split(',').map(Number);
if (cropBox) [cropBox[0], cropBox[1]] = [cropBox[0] + shiftX, cropBox[1] + shiftY];
const [cropX, cropY] = cropBox ?? [0, 0];
if (cropBox) art = cropArt(art, cropBox);
// `@ref <png> [x y w h]`: optional crop in source pixels, to zoom in on the subject
const [refPath, ...crop] = (!cropArg && art.ref?.split(/\s+/)) || [];
const ref = refPath && fitRef(cropImage(decodePng(readFileSync(refPath)), crop.map(Number)), art.width, art.height);
const n = Math.max(...art.anims.map((a) => a.frames.length)) + (ref ? 1 : 0);
const rows = art.anims.length;
const gap = n > 1 || rows > 1 ? 8 : 0;
const maxWidth = 2000;
const scale = Number(
  args.find((a) => /^\d+$/.test(a)) ?? Math.max(2, Math.min(16, Math.floor((maxWidth - gap * n) / (art.width * n))))
);
const pad = 4;
const fw = art.width * scale + gap;
const fh = art.height * scale + pad + art.height * 2 + gap;
// A tilesheet's strips, put together from the first frame shown, in a band under the frames
const tiles = !cropBox && !art.offset && !art.base && parsed.tiles;
const strips = tiles ? tiles.strips.map((st) => stripPixels(tiles, art.frames[art.anims[0].frames[0]].pixels, st)) : [];
const bandGap = 8;
const bandW = strips.reduce((sum, p) => sum + (p[0]?.length ?? 0) * scale + bandGap, 0);
const bandH = strips.length ? bandGap + Math.max(...strips.map((p) => p.length)) * scale : 0;
const W = Math.max(fw * n - gap, bandW - bandGap);
const H = fh * rows - gap + bandH;
const buf = Buffer.alloc(W * H * 4);

const set = (x, y, [r, g, b, a = 255]) => {
  const i = (y * W + x) * 4;
  const t = a / 255;
  buf[i] = buf[i] * (1 - t) + r * t;
  buf[i + 1] = buf[i + 1] * (1 - t) + g * t;
  buf[i + 2] = buf[i + 2] * (1 - t) + b * t;
  buf[i + 3] = 255;
};

const checker = (x, y, size) => ((Math.floor(x / size) + Math.floor(y / size)) % 2 ? [200, 200, 200] : [240, 240, 240]);

// Background
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, checker(x, y, Math.max(4, scale / 2)));

// Dark gaps between frames and between animation rows
for (let y = 0; y < fh * rows - gap; y++)
  for (let x = 0; x < fw * n - gap; x++) if (x % fw >= fw - gap || y % fh >= fh - gap) set(x, y, [51, 60, 87]);

const draw = (pixels, ox, oy, dots = [], borders = tiles) => {
  // Upscaled art
  for (let py = 0; py < art.height; py++)
    for (let px = 0; px < art.width; px++) {
      const c = pixels[py][px];
      for (let y = 0; y < scale; y++)
        for (let x = 0; x < scale; x++) {
          if (c) set(ox + px * scale + x, oy + py * scale + y, c);
          if (grid && (x === 0 || y === 0)) set(ox + px * scale + x, oy + py * scale + y, [0, 0, 0, 40]);
          // Tile borders
          if (borders && ((x === 0 && px % borders.w === 0 && px) || (y === 0 && py % borders.h === 0 && py))) set(ox + px * scale + x, oy + py * scale + y, [255, 0, 255, 140]);
        }
    }

  const d = Math.max(2, Math.round(scale / 3));
  for (const [mx, my] of dots.map(([x, y]) => [x - cropX, y - cropY]).filter(([x, y]) => x >= 0 && y >= 0 && x < art.width && y < art.height))
    for (let y = 0; y < d; y++)
      for (let x = 0; x < d; x++) set(ox + mx * scale + Math.floor((scale - d) / 2) + x, oy + my * scale + Math.floor((scale - d) / 2) + y, [255, 0, 255]);

  // 2x preview below each frame, to judge readability at small size
  const py0 = oy + art.height * scale + pad;
  for (let py = 0; py < art.height; py++)
    for (let px = 0; px < art.width; px++) {
      const c = pixels[py][px];
      if (c) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) set(ox + px * 2 + x, py0 + py * 2 + y, c);
    }
};

art.anims.forEach((anim, row) => anim.frames.forEach((f, col) => draw(art.frames[f].pixels, col * fw, row * fh, marks.get(f))));
if (ref) draw(ref, (n - 1) * fw, 0, [], null);
// The strips, side by side under the frames
let stripX = 0;
for (const p of strips) {
  const oy = fh * rows - gap + bandGap;
  for (const [py, row] of p.entries())
    for (const [px, c] of row.entries()) if (c) for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) set(stripX + px * scale + x, oy + py * scale + y, c);
  stripX += (p[0]?.length ?? 0) * scale + bandGap;
}

const outDir = isDepth ? 'out/depth' : 'out';
mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/${name}.png`;
writeFileSync(outPath, encodePng(W, H, buf));
const info =
  `${art.width}x${art.height} @ ${scale}x` +
  (cropArg ? ` crop ${cropArg.slice(7)}` : '') +
  (art.frames.length > 1
    ? ', ' + art.anims.map((a) => `${a.name}: ${a.frames.map((f) => art.frames[f].duration).join('/')}ms`).join(', ')
    : '');
const gridPath = `${outDir}/${name}.grid.txt`;
const grids = parseGrids(text);
// With --recolor the frames of that variant, its detail layers drawn in
const shownGrids = variantChain ? { ...grids, frames: grids.frames.map((f) => ({ ...f, chars: variantOf(f, variantChain).chars })) } : grids;
writeFileSync(gridPath, skin ? `${SKIN_LEGEND}\n\n${gridText(skinGrids)}` : gridText(shownGrids));
// A worker that reworks a drawing into shapes has the result it must keep in target/<name>.txt (target/depth/
// for a depth map)
const targetPath = `target/${isDepth ? 'depth/' : ''}${name}.txt`;
const target = existsSync(targetPath) ? compareTarget(grids, parseGrids(readFileSync(targetPath, 'utf8'))) : null;
console.log(`${outPath} (${info})\n${gridPath} (grid per frame with coordinates)${target ? `\n${target.text}` : ''}`);
// The viewer serves files from the repo root; a worker renders inside its workspace, the project agent in the root
const inWorkspace = process.env.PIXEL_WORKER && process.env.PIXEL_WORKER !== 'agent';
const png = inWorkspace ? `work/${process.env.PIXEL_WORKER}/${outPath}` : outPath;
await sendEvent({ type: 'render', name, png, message: info + (target ? ` · ${target.short}` : '') });

function compareTarget(own, goal) {
  const { count, lines } = compareGrids(own, goal);
  return count
    ? { short: `target: ${count} differ`, text: `target: ${count} pixels differ from ${targetPath}\n${lines.join('\n')}` }
    : { short: 'target: match', text: `target: matches ${targetPath}` };
}

// Every frame's char grid with rulers: tens and units of x above, y in front of each row (only the frames
// picked with --anim and --frame).
function gridText({ frames, anims, width }) {
  const xs = Array.from({ length: width }, (_, x) => x);
  const ruler = [xs.map((x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ')).join(''), xs.map((x) => x % 10).join('')];
  const out = [];
  anims.forEach((a, n) => {
    if (animArg && !animArg.includes(a.name)) return;
    const list = frames.filter((f) => f.anim === n);
    list.forEach((f, i) => {
      if (frameNo && i !== frameNo - 1) return;
      out.push(`=== ${a.name} frame ${i + 1}/${list.length} (${f.duration}ms)`, ...ruler.map((r) => `    ${r}`));
      f.chars.forEach((row, y) => out.push(`${String(y).padStart(3)} ${row.join('')}`));
      out.push('');
    });
  });
  return out.join('\n');
}

function cropArt(art, [x, y, w, h]) {
  if (![x, y, w, h].every(Number.isInteger) || w < 1 || h < 1) throw new Error('--crop needs x,y,w,h');
  const cut = (pixels) => Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => pixels[y + r]?.[x + c] ?? null));
  return { ...art, width: w, height: h, frames: art.frames.map((f) => ({ ...f, pixels: cut(f.pixels) })) };
}

function cropImage(img, [x = 0, y = 0, w = img.width, h = img.height]) {
  x = Math.max(0, Math.min(x, img.width - 1));
  y = Math.max(0, Math.min(y, img.height - 1));
  w = Math.min(w, img.width - x);
  h = Math.min(h, img.height - y);
  const data = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++) img.data.copy(data, r * w * 4, ((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4);
  return { width: w, height: h, data };
}

// Scales an image down to fit w x h (keeping its aspect ratio, centered) by averaging, as rgba pixel rows.
function fitRef(img, w, h) {
  const k = Math.max(img.width / w, img.height / h);
  const dw = Math.round(img.width / k);
  const dh = Math.round(img.height / k);
  const x0 = Math.floor((w - dw) / 2);
  const y0 = Math.floor((h - dh) / 2);
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const dx = x - x0;
      const dy = y - y0;
      if (dx < 0 || dy < 0 || dx >= dw || dy >= dh) return null;
      const sum = [0, 0, 0, 0];
      let count = 0;
      for (let sy = Math.floor(dy * k); sy < Math.min(img.height, Math.ceil((dy + 1) * k)); sy++)
        for (let sx = Math.floor(dx * k); sx < Math.min(img.width, Math.ceil((dx + 1) * k)); sx++) {
          const i = (sy * img.width + sx) * 4;
          const a = img.data[i + 3];
          for (let c = 0; c < 3; c++) sum[c] += img.data[i + c] * a;
          sum[3] += a;
          count++;
        }
      if (!sum[3]) return null;
      return [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3], sum[3] / count].map(Math.round);
    })
  );
}

// Minimal PNG decoder for 8-bit, non-interlaced grayscale/RGB/RGBA images (what the viewer uploads).
function decodePng(file) {
  let pos = 8;
  let width, height, depth, type, interlace;
  const idat = [];
  while (pos < file.length) {
    const len = file.readUInt32BE(pos);
    const kind = file.toString('ascii', pos + 4, pos + 8);
    const data = file.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') [width, height, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error('Reference must be an 8-bit non-interlaced PNG');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    const gray = channels < 3;
    data.set([s[0], gray ? s[0] : s[1], gray ? s[0] : s[2], channels % 2 ? 255 : s[channels - 1]], i * 4);
  }
  return { width, height, data };
}

