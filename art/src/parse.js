// Art format:
//   // comment lines
//   <char> = #rrggbb | #rrggbbaa | none | keep   (palette, one per line; keep: see KEEP)
//   <blank line>
//   grid rows, one char per pixel
// Animations: start a named animation with `=== <name>`; all animations share palette and size.
// Separate frames with a `---` line, optionally with a duration in ms (`--- 200`).
// A `---` directly after `===` (or before the first grid) sets the duration of that first frame. A frame can
// be empty: a `---` on a frame that already had its own `---` starts the next one (a skin's depth map has
// pixels only where it differs from the base, see attach.js).
// Shapes: lines starting with `@` draw on the frame, in order, on top of its grid rows (see SHAPES).
// `@size <w> <h>` sets the canvas size, needed when a frame has only shapes.
// `@ref <path.png> [x y w h]` names a reference image (optionally cropped); the render shows it next to the art at the same size.
// `@base <project>` makes this project an attachment of that project (see attach.js), worn in `@slot <slot>`.
// `@anchor <slot> x y [depth] [r<degrees>]` (per frame, in a base) marks where a pinned attachment of that slot
// goes, optionally turned clockwise around its pin (frames without r get it interpolated, see attach.js);
// `@pin x y` makes the frame it is in a pivot image of an attachment, whose point (x, y) is placed on that anchor:
// in an animation called `pivot` the shared one, in an animation named like one of the base's that animation's
// own (see attach.js). One per animation.
// Recolors: `@recolor <name> [from=<recolor>] <char>=#rrggbb ...` is a color variant that swaps those palette
// colors. Once a project has recolors, the palette is only the base they swap from: every look is a recolor, also
// the one in the palette's own colors (a recolor without swaps). `@colors <name>`, from older files, is that one.
// With `from=` it builds on another recolor: that one's swaps and detail layers, with its own swaps over them; a
// recolor others build on is a group, not a look of its own (see looksOf).
// Detail layers: `@variant <name>` in a frame starts the detail layer of that recolor; the shape lines after it,
// up to the next `@variant` or the end of the frame, are only drawn in that variant, on top of the whole frame.
// `@variant` alone goes back to the shared drawing. A depth map has no recolors: its `@variant` layers are the
// depth of those details, by the name of the art's recolor.
// `@depthonly` marks a project drawn only in the five depth tones (a dummy base): the drawing is its own depth
// map, there is no depth/<name>.txt.
// Tiles: `@tiles <w> <h>` cuts the canvas into tiles of that size, `@tile <name> <col> <row> [<cols> <rows>]`
// names one (or a block of them), and `@strip <name> <v|h> <start> <middle> <end>` is a piece that stretches: its
// start tile, the middle one repeated as often as needed, its end tile (`-` for none), downwards (v) or to the
// right (h). A ladder or rope drawn once, used at any length (see tiles.js).
export const DEFAULT_DURATION = 150;

// A palette char with color `keep` shows whatever its pixels covered: drawn with it, a detail is invisible
// until a recolor gives the char a color of its own (a mustache only one variant has).
export const KEEP = 'keep';

// The phases a drawing goes through (see CLAUDE.md), as phase events and requests name them. phaseOf reads
// a phase name, also the Dutch ones older events and worker sessions use.
export const PHASES = ['silhouette', 'color'];
export const phaseOf = (name) => ({ silhouet: 'silhouette', kleur: 'color' })[name?.trim()] ?? name?.trim();

// Attachment slots: a base wears at most one item per slot. At equal depth a later slot lies on top.
export const SLOTS = ['skin', 'back', 'legs', 'feet', 'torso', 'hands', 'head', 'right-hand', 'left-hand'];

// The animation names that hold an attachment's shared pivot image
export const SHARED_PIVOT = ['pivot', 'main'];

export const SHAPES = {
  rect: 'x y w h c',
  ellipse: 'cx cy rx ry c',
  circle: 'cx cy r c',
  line: 'x1 y1 x2 y2 c [width]',
  poly: 'c x1,y1 x2,y2 x3,y3 ...',
  fill: 'x y c',
  outline: 'c',
  px: 'x y chars', // pixels from (x,y) to the right; `_` keeps the pixel, `.` erases
};

// Parses the text into palette chars and a char grid per frame, plus line ranges.
export function parseGrids(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const palette = { '.': null };
  const newFrame = (anim, duration = DEFAULT_DURATION, start, sep = false) => ({ anim, rows: [], shapes: [], anchors: {}, duration, start, sep });
  const filled = (f) => f.rows.length || f.shapes.length || Object.keys(f.anchors).length;
  // A frame that is there, even when empty: drawn in, or started with its own `---`
  const begun = (f) => filled(f) || f.sep;
  const anims = [{ name: 'main' }];
  const frames = [newFrame(0)];
  let size = null;
  let ref = null;
  let base = null;
  let slot = null;

  let depthOnly = false;
  let tiles = null; // { w, h, list: [{ name, col, row, cols, rows }], strips: [{ name, dir, start, middle, end }] }
  const tileLines = [];
  const recolors = {};
  const from = {}; // recolor → the recolor it builds on
  const layered = new Map(); // name of a `@variant` layer → line of its first use
  let variant = null; // the detail layer shape lines go to, in the current frame
  let inGrid = false;

  for (const [i, raw] of lines.entries()) {
    if (raw.trim().startsWith('//')) continue;
    const head = raw.match(/^\s*===\s*([\w-]+)?\s*$/);
    const sep = raw.match(/^\s*---\s*(\d+)?\s*$/);
    const shape = raw.match(/^\s*@(\w+)\s*(.*)$/);
    if (!inGrid && !sep && !head && !shape) {
      if (raw.trim() === '') {
        if (Object.keys(palette).length > 1) inGrid = true;
        continue;
      }
      const m = raw.match(/^\s*(\S)\s*=\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|none|keep)\s*$/);
      if (!m) throw new Error(`Invalid palette line: "${raw}"`);
      palette[m[1]] = m[2] === 'none' ? null : m[2] === KEEP ? KEEP : hexToRgba(m[2]);
      continue;
    }
    inGrid = true;
    const current = frames.at(-1);
    if (head) {
      const name = head[1] ?? `anim${anims.length + 1}`;
      if (begun(current)) {
        anims.push({ name, start: i });
        frames.push(newFrame(anims.length - 1));
      } else Object.assign(anims.at(-1), { name, start: i });
      variant = null;
    } else if (sep) {
      const duration = sep[1] ? Number(sep[1]) : DEFAULT_DURATION;
      if (begun(current)) frames.push(newFrame(current.anim, duration, i, true));
      else Object.assign(current, { duration, start: current.start ?? i, sep: true });
      variant = null;
    } else if (shape) {
      current.start ??= i;
      const [, cmd, rest] = shape;
      const args = rest.trim().split(/\s+/).filter(Boolean);
      if (cmd === 'size') size = args.map(Number);
      else if (cmd === 'ref') ref = rest.trim();
      else if (cmd === 'base') base = args[0] ?? null;
      else if (cmd === 'slot') slot = args[0] ?? null;
      // Older files named the palette's own colors: a recolor without swaps
      else if (cmd === 'colors') {
        if (!/^[\w-]+$/.test(args[0] ?? '')) throw new Error(`@colors needs a name (line ${i + 1})`);
        recolors[args[0]] = {};
      }
      else if (cmd === 'depthonly') depthOnly = true;
      else if (cmd === 'tiles') {
        const [w, h] = args.map(Number);
        if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) throw new Error(`@tiles needs <w> <h> (line ${i + 1})`);
        tiles = { w, h, list: tiles?.list ?? [], strips: tiles?.strips ?? [] };
      } else if (cmd === 'tile' || cmd === 'strip') tileLines.push({ cmd, args, line: i + 1 });
      // How the body is seen in this animation, for whoever draws something to fit it
      else if (cmd === 'view') anims.at(-1).view = rest.trim();
      else if (cmd === 'recolor') {
        const [name, ...swaps] = args;
        if (!/^[\w-]+$/.test(name ?? '')) throw new Error(`@recolor needs <name> [from=<recolor>] <char>=#rrggbb ... (line ${i + 1})`);
        recolors[name] = {};
        for (const swap of swaps) {
          const base = swap.match(/^from=([\w-]+)$/);
          if (base) {
            from[name] = base[1];
            continue;
          }
          const m = swap.match(/^(\S)=(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)$/);
          if (!m || !(m[1] in palette) || !palette[m[1]]) throw new Error(`@recolor ${name}: "${swap}" is not <char>=#rrggbb for a palette color (line ${i + 1})`);
          recolors[name][m[1]] = hexToRgba(m[2]);
        }
      } else if (cmd === 'variant') {
        variant = args[0] ?? null;
        if (variant && !/^[\w-]+$/.test(variant)) throw new Error(`@variant needs a recolor name, or nothing to go back to the shared drawing (line ${i + 1})`);
        if (variant && !layered.has(variant)) layered.set(variant, i + 1);
        current.open = variant;
      } else if (cmd === 'pin') {
        if (frames.some((f) => f.anim === current.anim && f.pin)) throw new Error(`An animation has one pivot image: a second @pin (line ${i + 1})`);
        current.pin = args.slice(0, 2).map(Number);
        if (current.pin.length < 2 || !current.pin.every(Number.isInteger)) throw new Error(`@pin needs <x> <y> (line ${i + 1})`);
      } else if (cmd === 'anchor') {
        const [name, x, y, ...rest] = args;
        const anchor = { x: Number(x), y: Number(y) };
        let ok = SLOTS.includes(name) && Number.isInteger(anchor.x) && Number.isInteger(anchor.y);
        for (const t of rest) {
          if (/^r-?\d+(\.\d+)?$/.test(t)) anchor.r = Number(t.slice(1));
          else if (/^[1-5]$/.test(t)) anchor.z = Number(t);
          else ok = false;
        }
        if (!ok) throw new Error(`@anchor needs <${SLOTS.join('|')}> <x> <y> [depth 1-5] [r<degrees>] (line ${i + 1})`);
        current.anchors[name] = anchor;
      }
      else if (!SHAPES[cmd]) throw new Error(`Unknown shape "@${cmd}" (line ${i + 1}); use ${Object.keys(SHAPES).join(', ')}`);
      else current.shapes.push({ cmd, args, line: i + 1, variant });
    } else if (raw.trim() !== '') {
      current.start ??= i;
      current.rows.push(raw.trimEnd());
    }
  }

  if (frames.some((f) => f.pin) && !base) throw new Error('@pin is only for an attachment (with @base)');
  for (const [name, on] of Object.entries(from)) {
    if (!recolors[on]) throw new Error(`@recolor ${name} from=${on}: there is no recolor ${on}`);
    if (chainOf({ recolors, from }, name).length > Object.keys(recolors).length) throw new Error(`@recolor ${name}: from= goes round in a circle`);
  }
  // A recolor's swaps: those of the one it builds on, with its own over them
  const swapsOf = (name) => ({ ...(from[name] ? swapsOf(from[name]) : {}), ...recolors[name] });
  const own = Object.fromEntries(Object.keys(recolors).map((name) => [name, swapsOf(name)]));
  // In an art the layers belong to its recolors; a depth map (or a draft, without them) names them freely
  if (Object.keys(recolors).length)
    for (const [name, line] of layered)
      if (!recolors[name]) throw new Error(`@variant ${name}: there is no @recolor ${name} (line ${line})`);
  if (base && !SLOTS.includes(slot)) throw new Error(`An attachment needs \`@slot <${SLOTS.join('|')}>\``);
  if (!begun(frames.at(-1))) frames.pop();
  if (!frames.length) throw new Error('No grid rows found');
  if (anims.length > frames.at(-1).anim + 1) throw new Error(`Animation "${anims.at(-1).name}" has no frames`);
  const width = Math.max(size?.[0] ?? 0, ...frames.flatMap((f) => f.rows.map((r) => r.length)));
  const height = Math.max(size?.[1] ?? 0, ...frames.map((f) => f.rows.length));
  if (!width || !height) throw new Error('Canvas has no size: add grid rows or `@size <w> <h>`');

  if (tileLines.length) tiles = parseTiles(tiles, tileLines, width, height);

  // Line ranges, so a frame or animation can be cut out of (or replaced in) the text
  anims.forEach((a, n) => {
    a.start ??= frames.find((f) => f.anim === n).start;
  });
  anims.forEach((a, n) => (a.end = anims[n + 1]?.start ?? lines.length));
  frames.forEach((f, n) => {
    const next = frames[n + 1];
    f.end = next?.anim === f.anim ? next.start : anims[f.anim].end;
  });

  // The variants that can have a detail layer: an art's recolors (with what they build on), or the layers a depth
  // map names
  const variants = Object.keys(recolors).length ? Object.keys(recolors) : [...layered.keys()];
  for (const f of frames) {
    f.chars = Array.from({ length: height }, (_, y) => Array.from((f.rows[y] ?? '').padEnd(width, '.')));
    // What a `keep` char covers, per pixel
    f.under = Array.from({ length: height }, () => Array(width).fill('.'));
    for (const s of f.shapes) if (!s.variant) drawShape(f.chars, s, palette, f.under);
    // Per variant with a detail layer in this frame (its own or one it builds on): the frame with it drawn in
    for (const name of variants) {
      const chain = chainOf({ recolors, from }, name) ?? [name];
      const shapes = chain.flatMap((v) => f.shapes.filter((s) => s.variant === v));
      if (!shapes.length) continue;
      const chars = f.chars.map((row) => [...row]);
      const under = f.under.map((row) => [...row]);
      for (const s of shapes) drawShape(chars, s, palette, under);
      (f.variants ??= {})[name] = { chars, under };
    }
  }
  // Pivot images: the shared one is in an animation called `pivot` (or the only one, `main`, of an older pinned
  // attachment); one in an animation named like one of the base's is that animation's own (see attach.js)
  const pinned = frames.filter((f) => f.pin);
  const shared = pinned.find((f) => SHARED_PIVOT.includes(anims[f.anim].name));
  const pinFrame = shared ? frames.indexOf(shared) : null;
  const pin = (shared ?? pinned[0])?.pin ?? null;
  return { palette, width, height, frames, anims, lines, ref, base, slot, pin, pinFrame, recolors: own, from, depthOnly, tiles };
}

// The named tiles and strips (see the top), checked against the tile size and the canvas
function parseTiles(tiles, lines, width, height) {
  const named = /^[\w-]+$/;
  for (const { cmd, args, line } of lines) {
    if (!tiles) throw new Error(`@${cmd} needs \`@tiles <w> <h>\` first, the tile size (line ${line})`);
    if (cmd === 'tile') {
      const [name, ...nums] = args;
      const [col, row, cols = 1, rows = 1] = nums.map(Number);
      if (!named.test(name ?? '') || ![col, row, cols, rows].every((n) => Number.isInteger(n) && n >= 0) || !cols || !rows || nums.length > 4)
        throw new Error(`@tile needs <name> <col> <row> [<cols> <rows>] (line ${line})`);
      if ((col + cols) * tiles.w > width || (row + rows) * tiles.h > height) throw new Error(`@tile ${name} is outside the canvas (line ${line})`);
      if (tiles.list.some((t) => t.name === name)) throw new Error(`@tile ${name} is named twice (line ${line})`);
      tiles.list.push({ name, col, row, cols, rows });
    } else {
      const [name, dir, ...parts] = args;
      if (!named.test(name ?? '') || !['v', 'h'].includes(dir) || parts.length !== 3 || parts[1] === '-')
        throw new Error(`@strip needs <name> <v|h> <start> <middle> <end>, - for no start or end (line ${line})`);
      for (const t of parts) if (t !== '-' && !tiles.list.some((x) => x.name === t)) throw new Error(`@strip ${name}: there is no @tile ${t} (line ${line})`);
      const [start, middle, end] = parts.map((t) => (t === '-' ? null : t));
      tiles.strips.push({ name, dir, start, middle, end });
    }
  }
  return tiles;
}

// The recolors a variant is made of, the one it builds on first (`from=`, see above), itself last. Null for no
// recolor.
export function chainOf(art, name) {
  if (!name || !art?.recolors?.[name]) return null;
  const chain = [name];
  while (art.from?.[chain[0]] && chain.length <= Object.keys(art.recolors).length) chain.unshift(art.from[chain[0]]);
  return chain;
}

// The looks of an art: its recolors that no other recolor builds on. One that others build on is a group (the
// details and colors they share), not a look of its own.
export const looksOf = (art) => Object.keys(art?.recolors ?? {}).filter((r) => !Object.values(art.from ?? {}).includes(r));

// A frame's chars in a variant (chain: see chainOf): with the detail layer of the last of the chain it has one
// for. In an art that is the variant's own (it holds what it builds on); a depth map only has the layers it draws.
export function variantOf(frame, chain) {
  const name = chain?.findLast((v) => frame.variants?.[v]);
  return name ? frame.variants[name] : frame;
}

// A frame's pixels from its char rows: each char's palette color, for a `keep` char the color it covers.
// Pixels of the same char share one color array.
function pixelsOf(rows, under, palette) {
  return rows.map((row, y) => Array.from(row, (ch, x) => (palette[ch] === KEEP ? palette[under[y][x]] : palette[ch])));
}

// Parses the text into an art object: per frame its char rows (with `under`, what its `keep` chars cover,
// when the palette has one) and pixels, rows of rgba arrays (null = transparent). The rows let a recolor swap
// per char (see attach.js), and are what the viewer gets instead of the pixels (see slim).
export function parseArt(text) {
  const { palette, width, height, frames, anims, ref, base, slot, pin, pinFrame, recolors, from, depthOnly, tiles } = parseGrids(text);
  const keeps = Object.values(palette).includes(KEEP);
  const parsed = frames.map(({ anim, chars, under, variants, duration, start, end, anchors, pin: framePin }, f) => {
    for (const grid of [chars, ...Object.values(variants ?? {}).map((v) => v.chars)])
      grid.forEach((row, y) =>
      row.forEach((ch, x) => {
        if (!(ch in palette)) throw new Error(`Unknown color "${ch}" at ${x},${y} (frame ${f + 1})`);
      })
    );
    const asRows = (v) => ({ rows: v.chars.map((row) => row.join('')), ...(keeps && { under: v.under.map((row) => row.join('')) }) });
    const { rows, under: covered = null } = asRows({ chars, under });
    // Per variant with a detail layer in this frame: its rows (see attach.js recolor)
    const layers = variants && { variants: Object.fromEntries(Object.entries(variants).map(([name, v]) => [name, asRows(v)])) };
    return { anim, duration, anchors, ...(framePin && { pin: framePin }), lines: [start, end], rows, ...(keeps && { under: covered }), ...layers, pixels: pixelsOf(rows, covered, palette) };
  });
  return {
    width,
    height,
    ref,
    base,
    slot,
    pin,
    pinFrame,
    depthOnly,
    tiles,
    // Per recolor: palette char → its color in that recolor (with those of the one it builds on); with the
    // palette to color the other chars. `from`: per recolor the one it builds on.
    recolors,
    from,
    palette,
    pixels: parsed[0].pixels,
    frames: parsed,
    anims: anims.map(({ name, start, end, view }, n) => ({
      name,
      view,
      lines: [start, end],
      frames: parsed.flatMap((f, i) => (f.anim === n ? [i] : [])),
    })),
  };
}

// The wire form of a parsed art, from the bus to the viewer: without its pixels, which are most of its size;
// the char rows and the palette make them again (inflate). An error ({ error }) stays as it is.
export function slim(art) {
  if (!art || art.error) return art;
  const { pixels, frames, ...rest } = art;
  return { ...rest, frames: frames.map(({ pixels, ...frame }) => frame) };
}
export function inflate(art) {
  if (!art || art.error || art.frames[0]?.pixels) return art;
  const frames = art.frames.map((f) => ({ ...f, pixels: pixelsOf(f.rows, f.under, art.palette) }));
  return { ...art, frames, pixels: frames[0].pixels };
}

// Removes one frame (flat index), one animation or one recolor from the art text, keeping everything else
// intact.
export function removePart(text, { frame, anim, recolor }) {
  const art = parseArt(text);
  if (recolor != null) {
    if (!art.recolors?.[recolor]) throw new Error(`No recolor ${recolor}`);
    const on = Object.keys(art.from).filter((r) => art.from[r] === recolor);
    if (on.length) throw new Error(`${on.join(', ')} builds on ${recolor} (from=${recolor})`);
    const drop = (l) => [`@recolor ${recolor}`, `@colors ${recolor}`].includes(l.trim().split(/\s+/).slice(0, 2).join(' '));
    return removeLayers(text.replace(/\r/g, '').split('\n').filter((l) => !drop(l)).join('\n'), recolor);
  }
  let range;
  if (anim != null) {
    if (!art.anims[anim]) throw new Error(`No animation ${anim + 1}`);
    if (art.anims.length < 2) throw new Error('Cannot remove the only animation');
    range = art.anims[anim].lines;
  } else {
    const f = art.frames[frame];
    if (!f) throw new Error(`No frame ${frame + 1}`);
    if (art.anims[f.anim].frames.length < 2) throw new Error('Cannot remove the only frame of an animation');
    range = f.lines;
  }
  const lines = text.replace(/\r/g, '').split('\n');
  lines.splice(range[0], range[1] - range[0]);
  return lines.join('\n');
}

// Removes the detail layers of variant `name` (`@variant <name>` up to the next `@variant` or the end of its
// frame) from an art or depth map text
export function removeLayers(text, name) {
  let inside = false;
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => {
      const v = l.match(/^\s*@variant\b\s*(\S*)/);
      if (v || /^\s*(===|---)/.test(l)) inside = v?.[1] === name;
      return !inside;
    })
    .join('\n');
}

// Renames the detail layers of variant `from` (see removeLayers)
export const renameLayers = (text, from, to) =>
  text.replace(/\r/g, '').split('\n').map((l) => l.replace(new RegExp(`^(\\s*@variant\\s+)${from}(?=\\s|$)`), `$1${to}`)).join('\n');

// Removes the anchors of `slot` from the animation called `anim` in a base's text: an attachment's pivot image no
// longer shows in that animation. The rest of the text stays as it is.
export function removeAnchors(text, anim, slot) {
  const a = parseGrids(text).anims.find((x) => x.name === anim);
  if (!a) throw new Error(`No animation ${anim}`);
  const anchor = new RegExp(`^\\s*@anchor\\s+${slot}(\\s|$)`);
  return text.replace(/\r/g, '').split('\n').filter((l, i) => !(i >= a.start && i < a.end && anchor.test(l))).join('\n');
}

// Sets how the body is seen in the animation called `anim` (its `@view` line, right after its `===`); an empty
// view removes the line
export function setView(text, anim, view) {
  const lines = text.replace(/\r/g, '').split('\n');
  const a = parseGrids(text).anims.find((x) => x.name === anim);
  if (!a) throw new Error(`No animation ${anim}`);
  const at = lines.findIndex((l, i) => i >= a.start && i < a.end && /^\s*@view(\s|$)/.test(l));
  const line = view.trim() ? [`@view ${view.trim()}`] : [];
  if (at >= 0) lines.splice(at, 1, ...line);
  else lines.splice(/^\s*===/.test(lines[a.start]) ? a.start + 1 : a.start, 0, ...line);
  return lines.join('\n');
}

// Adds pixels drawn by hand to the art text, as `@px` lines at the end of their frames. `strokes` in drawing
// order, each { anim, pos, variant?, px: [[x, y, char], ...] } with the frame as animation name and position in
// it, so they still land on the right frame when the file changed meanwhile; with `variant` in the detail layer
// of that recolor. A later stroke wins where they overlap.
export function applyPaint(text, strokes) {
  if (!strokes.length) return text;
  const { frames, anims, palette, width, height } = parseGrids(text);
  const perFrame = new Map(); // flat frame index → variant ('' = the shared drawing) → y → x → char
  for (const { anim, pos, variant, px } of strokes) {
    const a = anims.findIndex((x) => x.name === anim);
    const f = frames.indexOf(frames.filter((fr) => fr.anim === a)[pos]);
    if (a < 0 || f < 0) throw new Error(`Frame ${pos + 1} of ${anim} no longer exists`);
    const layers = perFrame.get(f) ?? perFrame.set(f, new Map()).get(f);
    const rows = layers.get(variant ?? '') ?? layers.set(variant ?? '', new Map()).get(variant ?? '');
    for (const [x, y, c] of px) {
      if (!(c in palette)) throw new Error(`Unknown color "${c}"`);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) continue;
      (rows.get(y) ?? rows.set(y, new Map()).get(y)).set(x, c);
    }
  }
  const lines = text.replace(/\r/g, '').split('\n');
  // From the last frame back, so the line numbers of the frames before stay right
  for (const f of [...perFrame.keys()].sort((a, b) => b - a)) {
    const out = ['// drawn by hand'];
    // The shared drawing first, then each detail layer; after an open detail layer `@variant` goes back
    const layers = [...perFrame.get(f)].sort(([a], [b]) => (a !== '') - (b !== ''));
    let open = frames[f].open ?? null;
    for (const [variant, rows] of layers) {
      if ((variant || null) !== open) out.push(variant ? `@variant ${variant}` : '@variant');
      open = variant || null;
      for (const y of [...rows.keys()].sort((a, b) => a - b)) {
        let run = null;
        for (const x of [...rows.get(y).keys()].sort((a, b) => a - b)) {
          if (run && x === run.x + run.chars.length) run.chars += rows.get(y).get(x);
          else (run && out.push(`@px ${run.x} ${y} ${run.chars}`), (run = { x, chars: rows.get(y).get(x) }));
        }
        out.push(`@px ${run.x} ${y} ${run.chars}`);
      }
    }
    // After the frame's last line, before blank lines and comments that lead into the next one
    let at = frames[f].end;
    while (at > frames[f].start && (lines[at - 1].trim() === '' || lines[at - 1].trim().startsWith('//'))) at--;
    lines.splice(at, 0, ...out);
  }
  return lines.join('\n');
}

// Final chars per frame of two parsed drawings (parseGrids), frames matched by animation name and position:
// { count, lines } with the number of pixels that differ from `goal`, and per frame which ones.
export function compareGrids(own, goal) {
  const lines = [];
  let count = 0;
  if (own.width !== goal.width || own.height !== goal.height) (count += 1), lines.push(`canvas is ${own.width}x${own.height}, should be ${goal.width}x${goal.height}`);
  goal.anims.forEach((a, n) => {
    const want = goal.frames.filter((f) => f.anim === n);
    const m = own.anims.findIndex((x) => x.name === a.name);
    const have = own.frames.filter((f) => f.anim === m);
    want.forEach((f, i) => {
      const where = `${a.name} frame ${i + 1}`;
      if (!have[i]) return (count += 1), lines.push(`${where}: missing`);
      // The shared drawing, and every variant with a detail layer in either
      for (const v of [null, ...new Set([...Object.keys(f.variants ?? {}), ...Object.keys(have[i].variants ?? {})])]) {
        const [mine, want] = [variantOf(have[i], v && [v]).chars, variantOf(f, v && [v]).chars];
        const off = [];
        want.forEach((row, y) => row.forEach((c, x) => mine[y]?.[x] !== c && off.push(`${x},${y} is '${mine[y]?.[x] ?? ''}', should be '${c}'`)));
        count += off.length;
        if (off.length) lines.push(`${where}${v ? ` (variant ${v})` : ''}: ${off.length} differ: ${off.slice(0, 20).join('; ')}${off.length > 20 ? '; …' : ''}`);
      }
    });
  });
  return { count, lines };
}

// Renames a recolor in the art text (`@colors` in older files)
export function renameColors(text, from, to) {
  const art = parseArt(text);
  if (!art.recolors?.[from]) throw new Error(`No recolor ${from}`);
  if (art.recolors?.[to]) throw new Error(`Recolor ${to} already exists`);
  const re = new RegExp(`^(\\s*@(?:recolor|colors)\\s+)${from}(?=\\s|$)`);
  // Recolors that build on it, and its detail layers, follow
  const base = new RegExp(`^(\\s*@recolor\\s.*\\sfrom=)${from}(?=\\s|$)`);
  return renameLayers(text.replace(/\r/g, '').split('\n').map((l) => l.replace(re, `$1${to}`).replace(base, `$1${to}`)).join('\n'), from, to);
}

// Gives chars another color in a recolor's own line ({ char: '#rrggbb' }): a swap it has changes in place, a new
// one goes at the end. An older `@colors <name>` becomes a `@recolor`.
export function setRecolor(text, name, swaps) {
  const re = new RegExp(`^(\\s*)@(?:recolor|colors)\\s+${name}(?=\\s|$)(.*)$`);
  let found = false;
  const lines = text.replace(/\r/g, '').split('\n').map((l) => {
    const m = l.match(re);
    if (!m) return l;
    found = true;
    const left = { ...swaps };
    const tokens = m[2].trim().split(/\s+/).filter(Boolean).map((t) => {
      const c = t.match(/^(\S)=#/)?.[1];
      if (c == null || !(c in left)) return t;
      const swap = `${c}=${left[c]}`;
      delete left[c];
      return swap;
    });
    return [`${m[1]}@recolor ${name}`, ...tokens, ...Object.entries(left).map(([c, hex]) => `${c}=${hex}`)].join(' ');
  });
  if (!found) throw new Error(`No recolor ${name}`);
  const out = lines.join('\n');
  parseArt(out);
  return out;
}

function drawShape(grid, { cmd, args, line }, palette, under) {
  const h = grid.length;
  const w = grid[0].length;
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`@${cmd}: "${v}" is not a number (line ${line}); usage: @${cmd} ${SHAPES[cmd]}`);
    return n;
  };
  const color = (c) => {
    if (!c || !(c in palette)) throw new Error(`@${cmd}: unknown color "${c}" (line ${line}); usage: @${cmd} ${SHAPES[cmd]}`);
    return c;
  };
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    // A `keep` char remembers what it covers (or what the `keep` char before it covered)
    if (palette[c] === KEEP) under[y][x] = palette[grid[y][x]] === KEEP ? under[y][x] : grid[y][x];
    grid[y][x] = c;
  };

  if (cmd === 'rect') {
    const [x0, y0, rw, rh] = args.slice(0, 4).map(num);
    const c = color(args[4]);
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) set(x, y, c);
  } else if (cmd === 'ellipse' || cmd === 'circle') {
    const [cx, cy, rx, ry] = cmd === 'circle' ? [...args.slice(0, 3), args[2]].map(num) : args.slice(0, 4).map(num);
    const c = color(args[cmd === 'circle' ? 3 : 4]);
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++)
        if (((x - cx) / (rx + 0.5)) ** 2 + ((y - cy) / (ry + 0.5)) ** 2 <= 1) set(x, y, c);
  } else if (cmd === 'line') {
    let [x0, y0, x1, y1] = args.slice(0, 4).map(num);
    const c = color(args[4]);
    // Round brush of `width` pixels; even widths extend one pixel further right/down
    const bw = Math.max(1, Math.round(args[5] ? num(args[5]) : 1));
    const lo = -Math.floor((bw - 1) / 2);
    const mid = lo + (bw - 1) / 2;
    const stamp = (px, py) => {
      for (let dy = lo; dy < lo + bw; dy++)
        for (let dx = lo; dx < lo + bw; dx++)
          if ((dx - mid) ** 2 + (dy - mid) ** 2 <= (bw / 2) ** 2 + 0.25) set(px + dx, py + dy, c);
    };
    // Bresenham
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) (err += dy), (x0 += sx);
      if (e2 <= dx) (err += dx), (y0 += sy);
    }
  } else if (cmd === 'poly') {
    // Also accept the color glued to the first point (`g47,32`): a color is one char, a point has a comma
    if (args[0]?.length > 1 && args[0].includes(',') && args[0][0] in palette) args.splice(0, 1, args[0][0], args[0].slice(1));
    const c = color(args[0]);
    const pts = args.slice(1).map((p) => p.split(',').map(num));
    if (pts.length < 3) throw new Error(`@poly needs at least 3 points (line ${line})`);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // Even-odd test on the pixel center
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) set(x, y, c);
      }
  } else if (cmd === 'fill') {
    const [x0, y0] = args.slice(0, 2).map(num);
    const c = color(args[2]);
    const from = grid[y0]?.[x0];
    if (from === undefined || from === c) return;
    const stack = [[x0, y0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (grid[y]?.[x] !== from) continue;
      grid[y][x] = c;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  } else if (cmd === 'px') {
    const [x0, y0] = args.slice(0, 2).map(num);
    const chars = args[2] ?? '';
    [...chars].forEach((ch, i) => ch !== '_' && set(x0 + i, y0, color(ch)));
  } else if (cmd === 'outline') {
    const c = color(args[0]);
    const snapshot = grid.map((r) => [...r]);
    const solid = (x, y) => snapshot[y]?.[x] !== undefined && snapshot[y][x] !== '.';
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (!solid(x, y) && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) set(x, y, c);
  }
}

function hexToRgba(hex) {
  const n = hex.slice(1);
  return [0, 2, 4, 6].map((i) => (i < n.length ? parseInt(n.slice(i, i + 2), 16) : 255));
}

// A new animation is drawn in its own draft file, art/<project>--<anim>.txt, and merged into the project
// when the user accepts it. Returns { project, anim } for a draft name, null for a normal project.
export function draftOf(name) {
  const m = name?.match(/^(.+?)--(.+)$/);
  return m ? { project: m[1], anim: m[2] } : null;
}

// Drawings the user mentions in a message: @name, optionally :recolor, /animation and /frame (from 1).
// Returns [{ text, name, recolor, anim, frame }] in the order they appear, each mention once.
export function mentionsIn(message) {
  const found = [...(message ?? '').matchAll(/(?<![\w@])@([\w-]+)(?::([\w-]+))?(?:\/([\w-]+)(?:\/(\d+))?)?/g)];
  const unique = new Map(found.map(([text, name, recolor, anim, frame]) => [text, { text: text.slice(1), name, recolor, anim, frame: frame && +frame }]));
  return [...unique.values()];
}

// Where a shape line has its color char, per shape (see SHAPES); px has a string of chars
const COLOR_ARG = { rect: 4, ellipse: 4, circle: 3, line: 4, poly: 0, fill: 2, outline: 0 };

// Renames palette chars in body lines (grid rows and shape lines; comments and headers stay), by `map`
// (char → char).
function renameChars(lines, map) {
  const swap = (ch) => map.get(ch) ?? ch;
  return lines.map((line) => {
    const t = line.trim();
    if (t === '' || t.startsWith('//') || /^(===|---)/.test(t)) return line;
    const shape = line.match(/^(\s*@)(\w+)(\s*)(.*)$/);
    if (!shape) return [...line].map(swap).join('');
    const [, at, cmd, gap, rest] = shape;
    const args = rest.trim().split(/\s+/).filter(Boolean);
    if (cmd === 'px' && args[2]) args[2] = [...args[2]].map(swap).join('');
    else if (cmd in COLOR_ARG && args[COLOR_ARG[cmd]]) {
      const i = COLOR_ARG[cmd];
      // poly may have its color glued to the first point (`g47,32`)
      args[i] = cmd === 'poly' && args[i].length > 1 ? swap(args[i][0]) + args[i].slice(1) : swap(args[i]);
    }
    return at + cmd + (args.length ? gap || ' ' : '') + args.join(' ');
  });
}

// Merges the draft's frames into the project as animation `anim`: replaces an animation with that name,
// or appends it. Palette colors the project doesn't have yet are added. A project char never changes color:
// a draft char that has another color there is renamed in the draft's frames, to the project's char with
// that color, or else to a free char (a depth map whose palette drifted from the art's still merges).
// With `keepPin`, an @pin in the draft stays: the draft's frames hold a pivot image (see takeAnims).
export function mergeDraft(projectText, draftText, anim, { keepPin = false } = {}) {
  const paletteLine = /^\s*(\S)\s*=\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|none|keep)\s*$/;
  // Palette lines and the index where the body starts (after the blank line that ends the palette)
  const split = (lines) => {
    const palette = [];
    let i = 0;
    for (; i < lines.length; i++) {
      const m = lines[i].match(paletteLine);
      if (m) palette.push({ char: m[1], color: m[2].toLowerCase(), line: i });
      else if (lines[i].trim() === '' && palette.length) break;
      else if (!lines[i].trim().startsWith('//') && lines[i].trim() !== '') break;
    }
    return { palette, body: i };
  };
  const lines = projectText.replace(/\r/g, '').split('\n');
  const draftLines = draftText.replace(/\r/g, '').split('\n');
  const own = split(lines);
  const draft = split(draftLines);

  // Chars the draft's frames really show (or a `keep` char covers)
  const used = new Set(parseGrids(draftText).frames.flatMap((f) => [...f.chars.flat(), ...f.under.flat()]));
  const extra = []; // { char, color } to add to the project's palette
  const rename = new Map();
  const taken = new Set(['.', '_', ...own.palette.map((p) => p.char), ...draft.palette.map((p) => p.char)]);
  const free = () => [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+?!'].find((c) => !taken.has(c));
  for (const { char, color } of draft.palette) {
    const mine = own.palette.find((p) => p.char === char);
    if (!mine) extra.push({ char, color });
    if (!mine || mine.color === color || !used.has(char)) continue;
    const same = [...own.palette, ...extra].find((p) => p.color === color);
    const to = same?.char ?? free();
    if (!to) throw new Error(`Color "${char}" is ${color} in the draft but ${mine.color} in the project, and there is no free char left`);
    taken.add(to);
    rename.set(char, to);
    if (!same) extra.push({ char: to, color });
  }

  // Draft body without its own size/ref/base/slot/depthonly and animation headers, under `=== <anim>`
  const body = renameChars(
    draftLines.slice(draft.body).filter((l) => !/^\s*(@size|@ref|@base|@slot|@colors|@recolor|@depthonly|@tiles|@tile|@strip)\b/.test(l) && !(!keepPin && /^\s*@pin\b/.test(l)) && !/^\s*===/.test(l)),
    rename
  );
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body.at(-1).trim() === '') body.pop();
  if (!body.length) throw new Error('Draft has no frames');
  const section = [`=== ${anim}`, ...body];

  const existing = parseGrids(projectText).anims.find((a) => a.name === anim);
  if (existing) lines.splice(existing.start, existing.end - existing.start, ...section, '');
  else {
    while (lines.length && lines.at(-1).trim() === '') lines.pop();
    lines.push('', ...section, '');
  }
  if (extra.length) lines.splice(own.palette.at(-1).line + 1, 0, ...extra.map((p) => `${p.char} = ${p.color}`));
  const merged = lines.join('\n');
  parseArt(merged);
  return merged;
}

// Puts these animations of `sourceText` (by name) into `targetText`, replacing those of the same name or adding
// them, the rest of the target as it was: an approved silhouette into a depth map that has more animations
// than the ones just drawn (see saveDepth in bus-plugin.js). A pivot image's @pin goes along.
export function takeAnims(targetText, sourceText, names) {
  const lines = sourceText.replace(/\r/g, '').split('\n');
  const { anims } = parseGrids(sourceText);
  // The palette, up to the blank line that ends it
  const header = lines.slice(0, lines.findIndex((l, i) => l.trim() === '' && lines.slice(0, i).some((p) => /^\s*\S\s*=/.test(p))) + 1);
  let text = targetText;
  for (const name of names) {
    const a = anims.find((x) => x.name === name);
    // With the source's @size, @base and @slot, so shapes and a pivot image's @pin parse (mergeDraft leaves them out again)
    const attachment = lines.filter((l) => /^\s*@(size|base|slot)\b/.test(l));
    if (a) text = mergeDraft(text, [...header, ...attachment, ...lines.slice(a.start, a.end)].join('\n'), name, { keepPin: true });
  }
  return text;
}
