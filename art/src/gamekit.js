// Game export of a character: a base with every attachment that fits it, in every look, as one atlas image and a
// manifest a game reads (runtime/pixeldraw.js draws from it). Every layer (the base, each item in each look) is
// split per frame into its depths 1-5 (see depthSlices in attach.js); a game draws depth 1 of the base and of
// everything worn, then depth 2, and so on, and gets what the viewer shows, for any outfit. Pinned items (a
// weapon on an anchor) are put in place and turned per frame already, so they need nothing extra.
import { attachmentsOf, depthSlices, layerOf, recolor } from './attach.js';
import { looksOf, SLOTS } from './parse.js';

export const FORMAT = 'pixeldraw-character';
const PAD = 1; // between images in the atlas, so nothing bleeds when a game scales with filtering

// Builds the atlas and manifest of the base `name`. `arts` and `depths` map project names to parsed art and depth
// maps. Returns { width, height, rgba (Uint8ClampedArray), manifest }.
export function buildGame(name, { arts, depths }, image = `${name}.png`) {
  const base = arts[name];
  if (!base || base.error) throw new Error(`No drawing ${name}`);
  if (base.base) throw new Error(`${name} is an attachment: export its base, ${base.base}`);
  // The layers: the base, then every item in slot order, each look of it
  const items = attachmentsOf(name, arts).filter((n) => arts[n] && !arts[n].error);
  const layers = [{ id: name, slot: 'base', look: 'default', layer: { art: base, depth: depths[name] } }];
  for (const n of items) {
    const looks = looksOf(arts[n]);
    for (const look of looks.length ? looks : [null]) layers.push({ id: n, slot: arts[n].slot, look: look ?? 'default', layer: layerOf(n, recolor(arts[n], look), depths, base) });
  }

  // Every slice, the same image only once
  const images = [];
  const known = new Map();
  const imageOf = (pixels) => {
    const key = pixels.map((row) => row.map((c) => (c ? c.join(',') : '')).join(';')).join('|');
    if (!known.has(key)) known.set(key, images.push({ pixels, w: pixels[0].length, h: pixels.length }) - 1);
    return known.get(key);
  };
  // layer → per frame of the base: [[depth, image, x, y], ...]. A depth-only base (a mannequin) still decides
  // what is in front, but its own grey silhouette isn't part of the game: it exports without pixels.
  const perLayer = layers.map(() => []);
  const canvas = depthSlices(
    base,
    layers.map((l) => l.layer),
    (f, slices) => slices.forEach((list, i) => (perLayer[i][f] = i === 0 && base.depthOnly ? [] : list.map((s) => [s.d, imageOf(s.pixels), s.x, s.y])))
  );

  const { width, height, rgba, at } = pack(images);
  const manifest = {
    format: FORMAT,
    version: 1,
    name,
    image,
    width: canvas.width,
    height: canvas.height,
    // Where the base's (0, 0) is in a frame: pinned items can make the frame larger than the base's canvas
    origin: canvas.offset,
    baseWidth: base.width,
    baseHeight: base.height,
    // per animation its frames' durations, how it is seen, and per frame its anchors ({ slot: [x, y, depth, r] } in the
    // base's pixels), so a game can put things of its own in a hand
    animations: Object.fromEntries(
      base.anims.map((a) => [
        a.name,
        {
          durations: a.frames.map((f) => base.frames[f].duration),
          ...(a.view && { view: a.view }),
          anchors: a.frames.map((f) => Object.fromEntries(Object.entries(base.frames[f].anchors ?? {}).map(([slot, { x, y, z, r }]) => [slot, [x, y, z ?? null, r ?? 0]]))),
        },
      ])
    ),
    slots: SLOTS,
    layers: {},
  };
  layers.forEach(({ id, slot, look }, i) => {
    const entry = (manifest.layers[id] ??= { slot, looks: {} });
    // Per animation, per frame its slices: [depth, x, y, w, h in the atlas, x, y in the frame], depth order
    entry.looks[look] = Object.fromEntries(
      base.anims.map((a) => [
        a.name,
        a.frames.map((f) =>
          (perLayer[i][f] ?? [])
            .map(([d, img, x, y]) => [d, at[img].x, at[img].y, images[img].w, images[img].h, x, y])
            .sort((p, q) => p[0] - q[0])
        ),
      ])
    );
    // An item with nothing in an animation doesn't have it
    for (const [anim, frames] of Object.entries(entry.looks[look])) if (slot !== 'base' && frames.every((s) => !s.length)) delete entry.looks[look][anim];
  });
  return { width, height, rgba, manifest };
}

// Shelf packing, tallest first, into an atlas about as wide as it is high
function pack(images) {
  const order = images.map((_, i) => i).sort((a, b) => images[b].h - images[a].h || images[b].w - images[a].w);
  const area = images.reduce((sum, im) => sum + (im.w + PAD) * (im.h + PAD), 0);
  const width = Math.max(64, ...images.map((im) => im.w + PAD), Math.ceil(Math.sqrt(area) * 1.1));
  const at = [];
  let [x, y, shelf] = [0, 0, 0];
  for (const i of order) {
    const { w, h } = images[i];
    if (x + w > width) [x, y, shelf] = [0, y + shelf + PAD, 0];
    at[i] = { x, y };
    x += w + PAD;
    shelf = Math.max(shelf, h);
  }
  const height = Math.max(1, y + shelf);
  const rgba = new Uint8ClampedArray(width * height * 4);
  images.forEach(({ pixels }, i) =>
    pixels.forEach((row, py) =>
      row.forEach((c, px) => {
        if (!c) return;
        const o = ((at[i].y + py) * width + at[i].x + px) * 4;
        rgba.set([c[0], c[1], c[2], c[3] ?? 255], o);
      })
    )
  );
  return { width, height, rgba, at };
}
