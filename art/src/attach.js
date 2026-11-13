// Attachments: projects drawn to fit a base project (`@base <project>` in the file), like clothing and gear
// on a body, each in a slot (`@slot <slot>`, see SLOTS). They follow the base's animations by name and
// frame index. Per pixel the nearest layer wins, by depth tone (1 = farthest .. 5 = nearest) from the depth
// maps; on equal depth the later layer wins, so an attachment lies over the body part it covers and a
// later slot over an earlier one.
import { chainOf, draftOf, SLOTS, variantOf } from './parse.js';
export { SLOTS };

export const TONES = ['#2b3048', '#3f4a68', '#5a6988', '#7d90ab', '#a6bccf'];
export const MISSING = [220, 50, 60, 255];

const hex = (c) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
const toneOf = (c) => {
  const i = TONES.indexOf(hex(c));
  return i < 0 ? null : i + 1;
};

// Projects whose `@base` is this project (drafts excluded), in slot order, then by name.
export function attachmentsOf(base, arts) {
  return Object.keys(arts)
    .filter((n) => !draftOf(n) && arts[n]?.base === base)
    .sort((a, b) => SLOTS.indexOf(arts[a].slot) - SLOTS.indexOf(arts[b].slot) || a.localeCompare(b));
}

// An animation that holds a pivot image of an attachment (a frame with @pin): the shared one, or the own one of
// the base's animation of that name. Not an animation drawn frame by frame.
export const isPivotAnim = (art, a) => a.frames.some((f) => art.frames[f].pin);
// The pivot image an attachment (or its depth map) shows in the base's animation `anim`: that animation's own,
// else the shared one, else none
export function pivotFor(art, anim) {
  const own = art?.anims.find((a) => a.name === anim && isPivotAnim(art, a));
  if (own) return art.frames[own.frames.find((f) => art.frames[f].pin)];
  return art?.pinFrame != null ? art.frames[art.pinFrame] : null;
}

// Frame `index` of the animation called `anim`, or null when the art doesn't have it (the pivot image is no
// animation of it).
function frameOf(art, anim, index) {
  const f = art?.anims?.find((a) => a.name === anim && !isPivotAnim(art, a))?.frames[index];
  return f == null ? null : art.frames[f];
}

// Where a layer goes in frame `index` of animation `anim`: its pixels and depth map pixels with their
// top-left corner (x, y) in base coordinates, and a fixed depth. Its own frame for that animation when it has
// one; otherwise, for an attachment with pivot images (`anchor`: its base), the one for that animation (see
// pivotFor), moved so its pin is on the base's anchor for its slot and turned by the anchor's angle, at the
// anchor's depth when it has one, drawn over `region` (it may stick out of the base's canvas); without that
// anchor it is left out of the frame. A depth-only project has no depth map: its own tones are its depth.
function place({ art, depth, anchor, hidden, follow }, anim, index, region) {
  if (art.depthOnly) depth = null;
  const own = frameOf(art, anim, index);
  if (own || !anchor) return own && { src: own.pixels, depth: frameOf(depth, anim, index)?.pixels, x: 0, y: 0, hidden, follow };
  const image = pivotFor(art, anim);
  const a = image && frameOf(anchor, anim, index)?.anchors?.[art.slot];
  if (!a) return null;
  const r = angleAt(anchor, anim, index, art.slot);
  // Its depth: the same pivot image in the depth map; a depth map without it (made before it was added) leaves
  // the anchor's depth, else the image's own tones
  const shade = depth && pivotFor(depth, anim);
  const at = { x: a.x - region.x, y: a.y - region.y };
  return {
    src: turn(image.pixels, image.pin, at, r, region.w, region.h),
    depth: shade && turn(shade.pixels, shade.pin, at, r, region.w, region.h),
    x: region.x,
    y: region.y,
    z: a.z,
  };
}

// Angle of the anchor for `slot` in frame `index`: its own `r`, else interpolated between the nearest
// frames before and after it that have one (the animation loops), else 0.
function angleAt(art, anim, index, slot) {
  const list = art.anims.find((x) => x.name === anim).frames.map((f) => art.frames[f].anchors[slot]?.r);
  if (list[index] != null) return list[index];
  const keys = list.flatMap((r, i) => (r == null ? [] : [i]));
  if (!keys.length) return 0;
  const n = list.length;
  const prev = keys.findLast((i) => i < index) ?? keys.at(-1);
  const next = keys.find((i) => i > index) ?? keys[0];
  const span = (next - prev + n) % n || n;
  const t = ((index - prev + n) % n) / span;
  return list[prev] + (list[next] - list[prev]) * t;
}

// Pixels of an image placed on the canvas (w x h) with its point `pin` on (to.x, to.y), turned `deg` degrees
// clockwise around it. Turned images are sampled from the image scaled up 8x with Scale2x (RotSprite), so
// lines stay clean instead of breaking up like plain nearest-neighbour rotation.
function turn(pixels, pin, to, deg, w, h) {
  const big = deg ? upscaled(pixels) : null;
  const k = big ? 8 : 1;
  const src = big ?? pixels;
  const [cos, sin] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      // Back from the canvas pixel's center to the image, around the pin's center
      const [dx, dy] = [x - to.x, y - to.y];
      const sx = pin[0] + 0.5 + dx * cos + dy * sin;
      const sy = pin[1] + 0.5 - dx * sin + dy * cos;
      return src[Math.floor(sy * k)]?.[Math.floor(sx * k)] ?? null;
    })
  );
}

const upscaledCache = new WeakMap();
function upscaled(pixels) {
  if (!upscaledCache.has(pixels)) upscaledCache.set(pixels, scale2x(scale2x(scale2x(pixels))));
  return upscaledCache.get(pixels);
}

// Scale2x (EPX): doubles a pixel grid, rounding diagonal edges instead of making blocky steps.
function scale2x(grid) {
  const key = (c) => (c ? c.join() : '');
  const at = (x, y) => grid[y]?.[x] ?? null;
  const out = Array.from({ length: grid.length * 2 }, () => []);
  grid.forEach((row, y) =>
    row.forEach((p, x) => {
      const [a, b, c, d] = [at(x, y - 1), at(x + 1, y), at(x - 1, y), at(x, y + 1)];
      const same = (m, n) => key(m) === key(n);
      const ok = !same(a, d) && !same(c, b);
      out[y * 2][x * 2] = ok && same(c, a) ? c : p;
      out[y * 2][x * 2 + 1] = ok && same(a, b) ? b : p;
      out[y * 2 + 1][x * 2] = ok && same(c, d) ? c : p;
      out[y * 2 + 1][x * 2 + 1] = ok && same(d, b) ? b : p;
    })
  );
  return out;
}

// Depth per pixel of one layer frame (0 = empty). From its depth map; where the drawing has grown past the
// silhouette, the nearest depth pixel within 2; otherwise its own color if that is a depth tone (silhouette
// phase, before there is a depth map), else the middle tone.
function depthGrid(pixels, depth) {
  return pixels.map((row, y) =>
    row.map((c, x) => {
      if (!c) return 0;
      if (depth)
        for (let r = 0; r <= 2; r++)
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const d = depth[y + dy]?.[x + dx];
              if (d) return toneOf(d) ?? 3;
            }
      return toneOf(c) ?? 3;
    })
  );
}

// A skin lies on the body: per pixel the depth of its own depth map where that has a pixel (an override, like
// hair behind the back), otherwise the base's depth where the base has a pixel. Outside the body its own depth
// map defines it; where that is missing, its own tone if that is a depth tone (silhouette), else the middle tone.
function followGrid(pixels, depth, base) {
  return pixels.map((row, y) =>
    row.map((c, x) => {
      if (!c) return 0;
      const d = depth?.[y]?.[x];
      if (d) return toneOf(d) ?? 3;
      return base?.[y]?.[x] || (toneOf(c) ?? 3);
    })
  );
}

// The text of an empty depth map for a skin (art), with its animations and frames, to draw its own depth in.
export function skinDepthText(name, art) {
  return [
    `// ${name}: depth map of the skin, only pixels outside the body of ${art.base} and where it differs from it`,
    ...TONES.map((hex, i) => `${i + 1} = ${hex}`),
    '',
    `@base ${art.base}`,
    '@slot skin',
    `@size ${art.width} ${art.height}`,
    ...art.anims.flatMap((a) => [`=== ${a.name}`, ...a.frames.map((f) => `--- ${art.frames[f].duration}`)]),
    '',
  ].join('\n');
}

// What a skin's depth looks like, to show and draw on: per frame the depth each of its pixels gets (see
// followGrid) in the depth tones, from its own depth map `depth` (the overrides) and its base. What it takes
// from the base is see-through, its own depth map solid, and red where it is outside the body without a depth.
export function skinDepth(art, depth, base, baseDepth) {
  const rgb = TONES.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const frames = art.frames.map((fr, f) => {
    const { name, frames: list } = art.anims[fr.anim];
    const index = list.indexOf(f);
    const bf = frameOf(base, name, index);
    const bz = bf && depthGrid(bf.pixels, base.depthOnly ? null : frameOf(baseDepth, name, index)?.pixels);
    const own = frameOf(depth, name, index)?.pixels;
    const z = followGrid(fr.pixels, own, bz);
    const show = (d, x, y) => (!d ? null : own?.[y]?.[x] ? [...rgb[d - 1], 255] : bz?.[y]?.[x] ? [...rgb[d - 1], 100] : MISSING);
    return { ...fr, pixels: z.map((row, y) => row.map((d, x) => show(d, x, y))) };
  });
  return { ...art, recolors: {}, pixels: frames[0].pixels, frames };
}

// Where every layer goes in every frame of `structure` (see place), and the canvas that holds them all: when a
// pinned attachment sticks out of the base's canvas in some frame, it grows on that side for all frames.
// `only`: the frames (flat indices) to place, all when null.
function placeAll(structure, layers, only = null) {
  const { width, height } = structure;
  // Pinned images may reach out from an anchor by their diagonal
  const reach = Math.max(0, ...layers.filter((l) => l.anchor).map((l) => Math.ceil(Math.hypot(l.art.width, l.art.height))));
  const region = { x: -reach, y: -reach, w: width + 2 * reach, h: height + 2 * reach };
  const placed = (only ?? structure.frames.map((_, f) => f)).map((f) => {
    const fr = structure.frames[f];
    const { name, frames: list } = structure.anims[fr.anim];
    const index = list.indexOf(f);
    return layers.map((layer) => place(layer, name, index, region));
  });
  let [minX, minY, maxX, maxY] = [0, 0, width, height];
  for (const frame of placed)
    for (const at of frame) {
      if (!at || (!at.x && !at.y)) continue;
      at.src.forEach((row, y) =>
        row.forEach((c, x) => {
          if (!c) return;
          [minX, minY] = [Math.min(minX, at.x + x), Math.min(minY, at.y + y)];
          [maxX, maxY] = [Math.max(maxX, at.x + x + 1), Math.max(maxY, at.y + y + 1)];
        })
      );
    }
  return { placed, minX, minY, w: maxX - minX, h: maxY - minY };
}

// Depth per pixel of the placed layers of one frame: a following layer (a skin) takes the base's, the first one
const depthsOf = (frame) => {
  let baseZ = null;
  return frame.map((at) => {
    if (!at) return null;
    const z = at.follow ? followGrid(at.src, at.depth, baseZ) : depthGrid(at.src, at.depth);
    baseZ ??= z;
    return z;
  });
};

// Composites layers [{ art, depth, anchor?, hidden?, follow? }] (bottom to top; the first is the base, a hidden
// layer only takes up depth, a following layer takes the base's depth, see followGrid) into an art object with the animations and
// frames of `structure`. A layer without the animation or frame is left out of that frame. When a pinned
// attachment sticks out of the base's canvas in some frame, the canvas grows on that side for all frames;
// `offset` is then where the base's (0, 0) is. With `anims` (indices) only those animations are composed, and the
// result has only those: a thumbnail that plays the first animation doesn't need the other hundred frames.
export function compose(structure, layers, { anims = null } = {}) {
  const picked = anims && anims.flatMap((a) => structure.anims[a]?.frames ?? []);
  const only = picked?.length ? picked : null;
  const { placed, minX, minY, w, h } = placeAll(structure, layers, only);
  const frames = (only ?? structure.frames.map((_, f) => f)).map((src, f) => {
    const fr = structure.frames[src];
    const pixels = Array.from({ length: h }, () => Array(w).fill(null));
    const zbuf = Array.from({ length: h }, () => Array(w).fill(0));
    const zs = depthsOf(placed[f]);
    placed[f].forEach((at, i) => {
      if (!at) return;
      at.src.forEach((row, y) =>
        row.forEach((c, x) => {
          const [tx, ty] = [at.x + x - minX, at.y + y - minY];
          const d = at.z ?? zs[i][y][x];
          if (!c || tx < 0 || ty < 0 || tx >= w || ty >= h || d < zbuf[ty][tx]) return;
          if (!at.hidden) pixels[ty][tx] = over(c, pixels[ty][tx]);
          zbuf[ty][tx] = d;
        })
      );
    });
    return { ...fr, pixels };
  });
  const out = { ...structure, width: w, height: h, offset: [-minX, -minY], frames, pixels: frames[0].pixels };
  if (!only) return out;
  anims = anims.filter((a) => structure.anims[a]);
  // Frames renumbered: the kept animations point at their place in the shorter list
  const at = new Map(only.map((src, i) => [src, i]));
  out.anims = anims.map((a) => ({ ...structure.anims[a], frames: structure.anims[a].frames.map((f) => at.get(f)) }));
  out.frames = frames.map((fr, i) => ({ ...fr, anim: out.anims.findIndex((a) => a.frames.includes(i)) }));
  return out;
}

// The same layers as compose, not composited but each split into its depths: per frame of `structure`, per layer,
// per depth 1-5 its pixels there as a trimmed image { d, x, y, pixels } on the composed canvas (none for a depth it
// has nothing at). Drawing every layer's depth 1, then every layer's depth 2 and so on, each round in layer order,
// gives what compose gives, for any choice of layers: how a game puts a character together (see gamekit.js).
// `onFrame(f, slicesPerLayer)` gets them frame by frame, so they are never all in memory at once.
export function depthSlices(structure, layers, onFrame) {
  const { placed, minX, minY, w, h } = placeAll(structure, layers);
  structure.frames.forEach((_, f) => {
    const zs = depthsOf(placed[f]);
    onFrame(
      f,
      placed[f].map((at, i) => {
        if (!at || at.hidden) return [];
        const boxes = {}; // depth → bounds
        at.src.forEach((row, y) =>
          row.forEach((c, x) => {
            const [tx, ty] = [at.x + x - minX, at.y + y - minY];
            if (!c || tx < 0 || ty < 0 || tx >= w || ty >= h) return;
            const d = at.z ?? zs[i][y][x];
            const b = (boxes[d] ??= { x0: tx, y0: ty, x1: tx, y1: ty });
            [b.x0, b.y0, b.x1, b.y1] = [Math.min(b.x0, tx), Math.min(b.y0, ty), Math.max(b.x1, tx), Math.max(b.y1, ty)];
          })
        );
        return Object.entries(boxes).map(([d, b]) => {
          const pixels = Array.from({ length: b.y1 - b.y0 + 1 }, (_, y) =>
            Array.from({ length: b.x1 - b.x0 + 1 }, (_, x) => {
              const [sx, sy] = [b.x0 + x + minX - at.x, b.y0 + y + minY - at.y];
              const c = at.src[sy]?.[sx];
              return c && (at.z ?? zs[i][sy][sx]) === Number(d) ? c : null;
            })
          );
          return { d: Number(d), x: b.x0, y: b.y0, pixels };
        });
      })
    );
  });
  return { width: w, height: h, offset: [-minX, -minY] };
}

// A recolor of an art (see parse.js): the same frames with its swapped colors and its detail layers drawn in.
// Null or the art's own colors name: the art itself. `chain` remembers which variant it is, so its depth map
// takes the depth of those layers (see layerOf).
const recolorCache = new WeakMap();
export function recolor(art, name) {
  const swaps = name && art?.recolors?.[name];
  if (!swaps) return art;
  const cache = recolorCache.get(art) ?? new Map();
  recolorCache.set(art, cache);
  if (!cache.has(name)) {
    // Per char, so two chars with the same color can still differ in a recolor; a `keep` char without a
    // color in this recolor shows what it covers, in this recolor's colors
    const own = (ch) => swaps[ch] ?? art.palette[ch] ?? null;
    const color = (ch, covered) => (own(ch) === 'keep' ? own(covered) : own(ch));
    const frames = art.frames.map((f) => {
      const { rows, under } = f.variants?.[name] ?? f;
      return { ...f, rows, under, pixels: rows.map((row, y) => [...row].map((ch, x) => color(ch, under?.[y][x]))) };
    });
    cache.set(name, { ...art, chain: chainOf(art, name), frames, pixels: frames[0].pixels });
  }
  return cache.get(name);
}

// A depth map in a variant (chain: see chainOf): per frame with the depth of the detail layers it has for it.
// Without layers for it: the depth map itself.
const variantCache = new WeakMap();
export function variantDepth(depth, chain) {
  if (!depth?.frames || !chain || !depth.frames.some((f) => chain.some((v) => f.variants?.[v]))) return depth;
  const cache = variantCache.get(depth) ?? new Map();
  variantCache.set(depth, cache);
  const key = chain.join(' ');
  if (!cache.has(key)) {
    const frames = depth.frames.map((f) => {
      const { rows } = variantOf(f, chain);
      return rows === f.rows ? f : { ...f, rows, pixels: rows.map((row) => [...row].map((ch) => depth.palette[ch] ?? null)) };
    });
    cache.set(key, { ...depth, frames, pixels: frames[0].pixels });
  }
  return cache.get(key);
}

// The drawing of a project with color variants, without color: its own colors as gray tones, and the
// details only variants show (`keep` chars) in a marker color, so it is clear what is shape and what color.
// With `name`, the drawing of that recolor: with its detail layers (see recolor).
const MARK = [255, 64, 200, 255];
const uncoloredCache = new WeakMap();
const grayCache = new WeakMap();
export function uncolored(art, name) {
  if (!art?.palette || !art.frames[0]?.rows) return art;
  if (name && art.recolors?.[name]) {
    const cache = grayCache.get(art) ?? new Map();
    grayCache.set(art, cache);
    if (!cache.has(name)) {
      const plain = uncolored(art);
      const swapped = recolor(art, name);
      const frames = plain.frames.map((f, i) => {
        const rows = swapped.frames[i].rows;
        return rows === f.rows ? f : uncolored({ ...art, frames: [{ ...f, rows }] }).frames[0];
      });
      cache.set(name, { ...swapped, frames, pixels: frames[0].pixels });
    }
    return cache.get(name);
  }
  if (!uncoloredCache.has(art)) {
    const gray = (c) => {
      if (!c) return null;
      const l = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      return [l, l, l, c[3] ?? 255];
    };
    const color = (ch) => (art.palette[ch] === 'keep' ? MARK : gray(art.palette[ch]));
    const frames = art.frames.map((f) => ({ ...f, pixels: f.rows.map((row) => [...row].map(color)) }));
    uncoloredCache.set(art, { ...art, frames, pixels: frames[0].pixels });
  }
  return uncoloredCache.get(art);
}

// A worn item: an attachment's name, with `:<recolor>` for a color variant
export const splitItem = (item) => {
  const [name, colors = null] = item.split(':');
  return { name, colors };
};

// How a project looks dressed: an attachment on its base, or a base with the given attachments (items,
// see splitItem) on it. `arts` and `depths` map project names to parsed art and depth maps. With `hideBase`
// the base itself is left out but still hides what is behind it, so only its attachments show.
// `anims`: compose only those animations (see compose).
export function dress(name, art, { arts, depths }, attachments = [], { hideBase = false, anims = null } = {}) {
  // A pinned attachment shows the base's animations, with its image moving along
  if (art.base) {
    const base = arts[art.base];
    if (!base || base.error) return art;
    return compose(art.pin ? base : art, [{ art: base, depth: depths[art.base] }, layerOf(name, art, depths, base)], { anims });
  }
  if (!attachments.length && !hideBase) return art;
  return compose(art, [
    { art, depth: depths[name], hidden: hideBase },
    ...attachments.map(splitItem).map(({ name: n, colors }) => layerOf(n, recolor(arts[n], colors), depths, art)),
  ], { anims });
}

// A skin follows the base's depth; its own depth map only holds where it differs (see followGrid).
export function layerOf(name, art, depths, base) {
  return { art, depth: variantDepth(depths[name], art.chain), ...(art.pin ? { anchor: base } : art.slot === 'skin' && { follow: true }) };
}

// Alpha compositing of rgba color c over d.
function over(c, d) {
  const a = (c[3] ?? 255) / 255;
  if (a >= 1 || !d) return c;
  const b = (d[3] ?? 255) / 255;
  const out = a + b * (1 - a);
  const mix = (i) => Math.round((c[i] * a + d[i] * b * (1 - a)) / out);
  return [mix(0), mix(1), mix(2), Math.round(out * 255)];
}
