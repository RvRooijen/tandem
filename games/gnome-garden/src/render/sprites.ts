// The garden's sprites, built from the sheets drawn in pixeldraw
// (../pixeldraw: gnome, garden-flowers, garden-visitor, garden-props) and
// brought in by `npm run art` as art.gen.ts.
import { ALPHABET, ART } from './art.gen.ts';
import { hex, recolor, type Frame } from './fb.ts';

/** Sheets drawn at the picture's own resolution. The rest are older drawings at half of it, shown doubled until they are redrawn. */
const FINE = new Set<string>(['garden-cottage', 'gnome', 'garden-flowers', 'garden-props', 'garden-critters', 'garden-visitor']);

/** The frames of one animation of one look of a sheet, at the picture's resolution. `raw` keeps a half-size sheet as it is. */
function frames(sheet: string, look: string, anim: string, raw = false): Frame[] {
  const s = ART[sheet];
  // A drawing can gain looks (a cottage per season) before the game knows what to do with them: until it does,
  // a look it does not have is its first one, which is the drawing as it was.
  const list = (s?.looks[look] ?? (s && Object.values(s.looks)[0]))?.[anim];
  if (!list) throw new Error(`no drawing for ${sheet}/${look}/${anim}; run \`npm run art\``);
  const colors = s.pal.map(hex);
  const up = raw || FINE.has(sheet) ? 1 : 2;
  const A = ALPHABET.length;
  const depths = s.depth?.[look]?.[anim];
  return list.map((text, n) => {
    const px = new Uint32Array(s.w * up * s.h * up);
    // How near each pixel is: from the drawing's depth map, or flat where it has none.
    const d = new Uint8Array(px.length);
    const dtext = depths?.[n];
    for (let i = 0; i < s.w * s.h; i++) {
      const at = i * s.cpp;
      if (text[at] === '.') continue;
      const c = colors[s.cpp === 1 ? ALPHABET.indexOf(text[at]) : ALPHABET.indexOf(text[at]) * A + ALPHABET.indexOf(text[at + 1])];
      const x = (i % s.w) * up, y = Math.floor(i / s.w) * up;
      const near = dtext && dtext[i] !== '.' ? Number(dtext[i]) : 3;
      for (let dy = 0; dy < up; dy++) for (let dx = 0; dx < up; dx++) { px[(y + dy) * s.w * up + x + dx] = c; d[(y + dy) * s.w * up + x + dx] = near; }
    }
    return { w: s.w * up, h: s.h * up, px, d };
  });
}

/** Cut the empty margin off a frame: for things drawn at an offset from somebody's hand. */
function trim(f: Frame): Frame {
  let x0 = f.w, y0 = f.h, x1 = -1, y1 = -1;
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++)
      if (f.px[y * f.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return f;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const px = new Uint32Array(w * h);
  const d = f.d && new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { px[y * w + x] = f.px[(y0 + y) * f.w + x0 + x]; if (d) d[y * w + x] = f.d![(y0 + y) * f.w + x0 + x]; }
  return { w, h, px, d };
}

/** A few colours the renderer uses for sparks and lights. */
export const PAL: Record<string, number> = {
  w: hex('#fcf7ec'), y: hex('#f9d650'), p: hex('#f590b3'), r: hex('#e24d40'), n: hex('#8a5a33'),
  v: hex('#9a72d6'), g: hex('#6fb646'), k: hex('#241722'), e: hex('#aab0ba'),
};

// ---------------------------------------------------------------- gnomes

export interface Walker { stand: Frame; a: Frame; b: Frame }

/** The coat as drawn: light, mid, dark. Every look swaps these three. */
const COAT = ['#4d83c8', '#37639f', '#274678'];

/** Coats per look. 0-4 are shop gnomes; 5-10 used to be somebody, and still wear their colours. */
const COATS: [string, string, string][] = [
  ['#4d83c8', '#37639f', '#274678'],
  ['#5fae56', '#3f8a44', '#2b6435'],
  ['#9b74d8', '#7350b0', '#503585'],
  ['#dba040', '#b0762a', '#82531c'],
  ['#4fb0ad', '#33878a', '#226266'],
  // the neighbour, the postman, a jogger, a birdwatcher, a salesman, the inspector
  ['#7d9c52', '#55733a', '#3c5429'],
  ['#3f66b0', '#294784', '#1c3160'],
  ['#f27fa8', '#c4547f', '#8f3a5c'],
  ['#8d8d4c', '#656536', '#474726'],
  ['#80858e', '#595e66', '#3e4249'],
  ['#f2a02e', '#bb741c', '#855014'],
];

const FACES = ['cozy', 'odd', 'hollow'];

/** GNOME[look][face]: as bought, smiling too wide, hollow. */
export const GNOME: Walker[][] = COATS.map((coat) =>
  FACES.map((face) => {
    const swaps = COAT.map((from, i) => [hex(from), hex(coat[i])] as const);
    const [stand] = frames('gnome', face, 'stand');
    const [a, b] = frames('gnome', face, 'walk');
    return { stand: recolor(stand, swaps), a: recolor(a, swaps), b: recolor(b, swaps) };
  }));

/** Where the eyes are in a gnome frame, from its top-left: for the glow at night. */
export const GNOME_EYES = { y: 14, x: [12, 18] };

// ---------------------------------------------------------------- visitors

const PEOPLE = ['neighbour', 'postman', 'jogger', 'birdwatcher', 'salesman', 'inspector'];

export const VISITOR: Walker[] = PEOPLE.map((who) => {
  const [stand] = frames('garden-visitor', who, 'stand');
  const [a, b] = frames('garden-visitor', who, 'walk');
  return { stand, a, b };
});

// ---------------------------------------------------------------- flowers

export interface FlowerSet { sprout: Frame; bud: Frame; ripe: Frame[]; eye?: { x: number; y: number } }

const KINDS = ['daisy', 'tulip', 'sunflower', 'rose', 'toadstool', 'eyebright', 'fingerwort', 'heartbloom', 'gnomecap'];

export const FLOWER: FlowerSet[] = KINDS.map((kind) => {
  const [sprout, bud, ...ripe] = frames('garden-flowers', 'default', kind);
  // The eyebright's pupil is drawn on top by the renderer, looking at you.
  return { sprout, bud, ripe, eye: kind === 'eyebright' ? { x: 15, y: 8 } : undefined };
});

// ---------------------------------------------------------------- things

const basket = frames('garden-props', 'default', 'basket');
export const BASKET = basket[0];
export const BASKET_FULL = basket[1];
export const JAR = frames('garden-props', 'default', 'jar');
export const SHOVEL = trim(frames('garden-props', 'default', 'shovel')[0]);
export const LANTERN = trim(frames('garden-props', 'default', 'lantern')[0]);

// ---------------------------------------------------------------- what passes through, and the round buttons

/** By CRITTER kind in components.ts: butterfly, firefly, mound, crow, glint. Two frames each. */
export const CRITTERS: Frame[][] = ['butterfly', 'firefly', 'mound', 'crow', 'glint'].map((k) => frames('garden-critters', 'default', k));

/** Where the glint's eyes are in its frame, each two pixels square. */
export const GLINT_EYES = { y: 14, x: [10, 12, 18, 20] };

/** A weed as it is, and as it is later. */
export const WEED = frames('garden-critters', 'default', 'weed');

/** Icons for the round buttons and the shop, by id: every animation in the garden-icons sheet is one. */
export const ICONS: Record<string, Frame> = Object.fromEntries(
  Object.keys(ART['garden-icons'].looks.default).map((id) => [id, frames('garden-icons', 'default', id, true)[0]] as [string, Frame]),
);
ICONS.nap ??= ICONS.away;

/** Spark colours, by SPARK kind in components.ts. */
export const SPARK_COLOR = [
  PAL.w, PAL.y, PAL.p, PAL.r, PAL.n, PAL.p, PAL.w, PAL.v, PAL.g, PAL.y, hex('#62b0e0'),
];

/** The cottage, if it has been drawn; the renderer makes do with flat shapes until then. */
export const COTTAGE: Frame | undefined = ART['garden-cottage'] ? frames('garden-cottage', 'default', 'main')[0] : undefined;
