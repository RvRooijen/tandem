// Tiles of an art (`@tiles`, `@tile`, `@strip`, see parse.js): their place on the canvas, a strip put together at
// some length, and the JSON that tells a game where each tile is in the exported image. Used by the render, the
// viewer's tile panel and the export.

// A named tile's rectangle in canvas pixels
export function rectOf(tiles, name) {
  const t = tiles.list.find((x) => x.name === name);
  return t && { x: t.col * tiles.w, y: t.row * tiles.h, w: t.cols * tiles.w, h: t.rows * tiles.h };
}

// The pixels of one tile, cut out of a frame's pixel rows
export function tilePixels(pixels, rect) {
  return Array.from({ length: rect.h }, (_, y) => Array.from({ length: rect.w }, (_, x) => pixels[rect.y + y]?.[rect.x + x] ?? null));
}

// A strip put together: its start, the middle `repeat` times, its end, as pixel rows. Tiles of another size than the
// middle are centered across the strip.
export function stripPixels(tiles, pixels, strip, repeat = 3) {
  const parts = [strip.start, ...Array(repeat).fill(strip.middle), strip.end].filter(Boolean).map((n) => tilePixels(pixels, rectOf(tiles, n)));
  const v = strip.dir === 'v';
  const across = Math.max(...parts.map((p) => (v ? p[0]?.length ?? 0 : p.length)));
  const along = parts.reduce((sum, p) => sum + (v ? p.length : p[0]?.length ?? 0), 0);
  const [w, h] = v ? [across, along] : [along, across];
  const out = Array.from({ length: h }, () => Array(w).fill(null));
  let at = 0;
  for (const p of parts) {
    const pw = p[0]?.length ?? 0;
    const ph = p.length;
    const off = Math.floor((across - (v ? pw : ph)) / 2);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) out[v ? at + y : off + y][v ? off + x : at + x] = p[y][x];
    at += v ? ph : pw;
  }
  return out;
}

// Where everything is in the exported image (at `scale`), for a game to cut it up: every tile's rectangle and
// every strip's tiles
export function tilesJson(tiles, image, scale) {
  const s = (r) => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale });
  return {
    image,
    scale,
    tileWidth: tiles.w * scale,
    tileHeight: tiles.h * scale,
    tiles: Object.fromEntries(tiles.list.map((t) => [t.name, s(rectOf(tiles, t.name))])),
    strips: Object.fromEntries(tiles.strips.map((st) => [st.name, { direction: st.dir === 'v' ? 'vertical' : 'horizontal', start: st.start, middle: st.middle, end: st.end }])),
  };
}
