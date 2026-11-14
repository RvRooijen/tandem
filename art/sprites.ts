// A drawing as a game wants it: every frame of every animation in every look,
// on one sheet, with a list of where each frame is. This is pixeldraw's sprite
// export as a function, straight from the drawing's text: no files in between.
// A game's own tool turns the sheet into whatever it loads.
import { looksOf, parseArt } from './src/parse.js';
import { recolor } from './src/attach.js';

export interface SpriteSheet {
  name: string;
  /** The size of one frame. */
  width: number;
  height: number;
  /** looks[look][animation] = [x, y, durationMs] per frame, on the sheet. A drawing without recolors has one look, `default`. */
  looks: Record<string, Record<string, [number, number, number][]>>;
  /** The sheet: RGBA, sheetW by sheetH. */
  sheetW: number;
  sheetH: number;
  rgba: Uint8ClampedArray;
  /** The same sheet in the five depth tones, when the drawing has a depth map. */
  depthRgba?: Uint8ClampedArray;
  /** A tilesheet (@tiles): where each named tile is, [x, y, w, h] in the first frame of the first look. */
  tiles?: Record<string, [number, number, number, number]>;
  /** A tilesheet: the pieces that stretch, by the names of their tiles: start, the middle repeated, end, down (v) or right (h). */
  strips?: Record<string, { dir: string; start: string | null; middle: string | null; end: string | null }>;
}

type Rgba = number[] | null;
interface Art {
  width: number; height: number; base?: string;
  anims: { name: string; frames: number[] }[];
  frames: { pixels: Rgba[][]; duration: number; pin?: unknown }[];
  tiles?: { w: number; h: number; list: { name: string; col: number; row: number; cols: number; rows: number }[]; strips?: { name: string; dir: string; start?: string; middle?: string; end?: string }[] };
}

/**
 * `icon`: an attachment goes into a game with its base, but one that is pinned (a sword, a helmet) has an upright
 * image of its own, which is a sheet too: the picture of the item.
 */
export function spriteSheet(name: string, text: string, depthText?: string, icon = false): SpriteSheet {
  const art = parseArt(text) as Art;
  if (art.base && !(icon && art.frames.some((f) => f.pin))) throw new Error(`${name} is an attachment of ${art.base}: it goes into a game with its base`);
  const named = looksOf(art) as string[];
  const looks = named.length ? named : ['default'];
  const { width: w, height: h } = art;
  const frameCount = art.anims.reduce((n, a) => n + a.frames.length, 0);

  // One row per look, its frames side by side, a pixel apart.
  const PAD = 1;
  const sheetW = frameCount * (w + PAD) - PAD, sheetH = looks.length * (h + PAD) - PAD;
  const rgba = new Uint8ClampedArray(sheetW * sheetH * 4);
  const where: SpriteSheet['looks'] = {};
  looks.forEach((look, row) => {
    const variant = (look === 'default' ? art : recolor(art, look)) as Art;
    let col = 0;
    where[look] = {};
    for (const anim of art.anims)
      where[look][anim.name] = anim.frames.map((f) => {
        const x = col++ * (w + PAD), y = row * (h + PAD);
        variant.frames[f].pixels.forEach((line, py) =>
          line.forEach((c, px) => { if (c) rgba.set([c[0], c[1], c[2], c[3] ?? 255], ((y + py) * sheetW + x + px) * 4); }));
        return [x, y, variant.frames[f].duration];
      });
  });

  let depthRgba: Uint8ClampedArray | undefined;
  if (depthText) {
    const depth = parseArt(depthText) as Art;
    depthRgba = new Uint8ClampedArray(sheetW * sheetH * 4);
    for (const look of looks)
      for (const anim of art.anims)
        anim.frames.forEach((_f, k) => {
          const [x, y] = where[look][anim.name][k];
          // A frame the depth map does not have gets its first frame.
          const own = depth.anims.find((a) => a.name === anim.name)?.frames[k];
          depth.frames[own ?? 0].pixels.forEach((line, py) =>
            line.forEach((c, px) => { if (c && py < h && px < w) depthRgba!.set([c[0], c[1], c[2], 255], ((y + py) * sheetW + x + px) * 4); }));
        });
  }
  let tiles: SpriteSheet['tiles'], strips: SpriteSheet['strips'];
  if (art.tiles) {
    const { w: tw, h: th, list } = art.tiles;
    const [ox, oy] = Object.values(where[looks[0]])[0][0];
    tiles = Object.fromEntries(list.map((t) => [t.name, [ox + t.col * tw, oy + t.row * th, t.cols * tw, t.rows * th]]));
    strips = Object.fromEntries((art.tiles.strips ?? []).map((st) => [st.name, { dir: st.dir, start: st.start ?? null, middle: st.middle ?? null, end: st.end ?? null }]));
  }
  return { name, width: w, height: h, looks: where, sheetW, sheetH, rgba, depthRgba, ...(tiles && { tiles, strips }) };
}

/** What a drawing is, without drawing it: its size, its looks, and per animation how many frames. */
export function describeDrawing(name: string, text: string) {
  const art = parseArt(text) as Art;
  const named = looksOf(art) as string[];
  return {
    name, w: art.width, h: art.height,
    looks: named.length ? named : ['default'],
    anims: Object.fromEntries(art.anims.map((a) => [a.name, a.frames.length])),
  };
}
