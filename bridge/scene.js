// Tandem's lines for a page that draws a 3D scene with three.js. Like page.js
// they are added on the way (core/through.ts), before the page's own code
// runs, and the project knows nothing of them. Three tells its devtools of
// every renderer it makes; listening there, the scene and the camera of each
// draw are known, and so what in the scene is at a place on the canvas: a ray
// from the camera through that place, and the nearest thing it meets. What is
// said of it is what the code can be searched for: what kind of thing it is,
// its geometry and material, where it is, which one of how many like it.
(() => {
  if (window.parent === window || window.__tandemScene) return;

  /** What was last drawn on each canvas: the scenes, each with the camera it was seen through, and by which renderer. */
  const drawn = new Map();
  const hooked = new WeakSet();
  /** Who waits for a canvas to be drawn on again, to copy what is on it. */
  const waiting = new Map();
  const isScene = (x) => x && x.isScene && Array.isArray(x.children);
  const isCamera = (x) => x && x.isCamera && x.matrixWorld && x.projectionMatrix;

  function hook(renderer) {
    const canvas = renderer?.domElement;
    if (!canvas || typeof renderer.render !== 'function' || hooked.has(renderer)) return;
    hooked.add(renderer);
    const render = renderer.render;
    renderer.render = function (scene, camera) {
      const out = render.apply(this, arguments);
      if (isScene(scene) && isCamera(camera)) {
        const list = drawn.get(canvas) ?? [];
        drawn.set(canvas, [{ scene, camera, renderer, render, at: Date.now() }, ...list.filter((d) => d.scene !== scene)].slice(0, 6));
      }
      // Once everything of this frame is drawn (the page's own code has run to its end), and before the browser takes it.
      const fns = waiting.get(canvas);
      if (fns) { waiting.delete(canvas); queueMicrotask(() => { for (const fn of fns) fn(); }); }
      return out;
    };
  }
  // (A page that has three's own devtools has this already; then it is listened to as it is.)
  const tools = window.__THREE_DEVTOOLS__ ?? (window.__THREE_DEVTOOLS__ = new EventTarget());
  tools.addEventListener?.('observe', (ev) => { try { hook(ev.detail); } catch { /* not a renderer */ } });

  /** The scenes on a canvas that are still being drawn (or were, when the page draws only when something changes): the one drawn last first. */
  const scenesOn = (canvas) => {
    const all = drawn.get(canvas) ?? [];
    const now = all.filter((d) => Date.now() - d.at < 2000);
    return now.length ? now : all.slice(0, 1);
  };

  // ---- a little of the arithmetic three does, on the numbers three keeps (matrices as sixteen numbers, column by column)

  function inverse(m) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det || !Number.isFinite(det)) return null;
    const d = 1 / det;
    return [
      (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
      (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
      (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
      (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
    ];
  }
  const times = (a, b) => {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return out;
  };
  /** A point through a matrix, with the divide a projection needs; `w` says whether it is in front of the eye. */
  const point = (m, x, y, z) => {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return { x: (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, y: (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, z: (m[2] * x + m[6] * y + m[10] * z + m[14]) / w, w };
  };
  const direction = (m, x, y, z) => ({ x: m[0] * x + m[4] * y + m[8] * z, y: m[1] * x + m[5] * y + m[9] * z, z: m[2] * x + m[6] * y + m[10] * z });
  const round = (n) => Math.round(n * 1000) / 1000;

  /** The ray from the camera through a place of its picture (-1..1 both ways). An orthographic camera looks along one direction from anywhere. */
  function rayFrom(camera, nx, ny) {
    const world = camera.matrixWorld.elements;
    const back = camera.projectionMatrixInverse?.elements ?? inverse(camera.projectionMatrix.elements);
    if (!back) return null;
    const p = point(back, nx, ny, 0.5);
    const through = point(world, p.x, p.y, p.z);
    if (camera.isOrthographicCamera) return { o: through, d: direction(world, 0, 0, -1), behind: true };
    const o = { x: world[12], y: world[13], z: world[14] };
    return { o, d: { x: through.x - o.x, y: through.y - o.y, z: through.z - o.z }, behind: false };
  }

  /** The box a geometry fits in, in its own measure; kept until its points change. */
  const boxes = new WeakMap();
  function boxOf(geometry) {
    const pos = geometry.attributes.position;
    const kept = boxes.get(geometry);
    if (kept && kept.version === pos.version && kept.count === pos.count) return kept.box;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
      if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
    }
    boxes.set(geometry, { version: pos.version, count: pos.count, box });
    return box;
  }
  function meetsBox(o, d, box, behind) {
    let near = -Infinity, far = Infinity;
    for (const [at, dir, lo, hi] of [[o.x, d.x, box[0], box[3]], [o.y, d.y, box[1], box[4]], [o.z, d.z, box[2], box[5]]]) {
      if (Math.abs(dir) < 1e-12) { if (at < lo - 1e-9 || at > hi + 1e-9) return false; continue; }
      const a = (lo - at) / dir, b = (hi - at) / dir;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near <= far + 1e-9 && (behind || far >= 0);
  }

  /** How far along the ray it meets this geometry, placed by this matrix; Infinity when it does not. */
  function meets(ray, geometry, matrix, side, budget) {
    const pos = geometry.attributes.position;
    const back = inverse(matrix);
    if (!back || !pos.count) return Infinity;
    // In the thing's own measure: the same ray, so how far along it is the same number.
    const o = point(back, ray.o.x, ray.o.y, ray.o.z), d = direction(back, ray.d.x, ray.d.y, ray.d.z);
    if (!meetsBox(o, d, boxOf(geometry), ray.behind)) return Infinity;
    const plain = pos.array && pos.itemSize === 3 && !pos.isInterleavedBufferAttribute && !pos.normalized ? pos.array : null;
    const index = geometry.index;
    const all = index ? index.count : pos.count;
    const from = Math.max(0, geometry.drawRange?.start ?? 0);
    const to = Math.min(all, from + (geometry.drawRange?.count ?? Infinity));
    // A thing that is mirrored shows its other side.
    const m = matrix;
    const flipped = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) < 0;
    const want = side === 2 ? 0 : (side === 1) !== flipped ? -1 : 1;
    let best = Infinity;
    for (let i = from; i + 2 < to; i += 3) {
      if (--budget.left < 0) break;
      const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
      let ax, ay, az, bx, by, bz, cx, cy, cz;
      if (plain) {
        ax = plain[a * 3]; ay = plain[a * 3 + 1]; az = plain[a * 3 + 2];
        bx = plain[b * 3]; by = plain[b * 3 + 1]; bz = plain[b * 3 + 2];
        cx = plain[c * 3]; cy = plain[c * 3 + 1]; cz = plain[c * 3 + 2];
      } else {
        ax = pos.getX(a); ay = pos.getY(a); az = pos.getZ(a);
        bx = pos.getX(b); by = pos.getY(b); bz = pos.getZ(b);
        cx = pos.getX(c); cy = pos.getY(c); cz = pos.getZ(c);
      }
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const hx = d.y * e2z - d.z * e2y, hy = d.z * e2x - d.x * e2z, hz = d.x * e2y - d.y * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      // Seen from its front the number is above nothing; a side that is not drawn is not there to point at.
      if (Math.abs(det) < 1e-14 || (want > 0 && det < 0) || (want < 0 && det > 0)) continue;
      const f = 1 / det, sx = o.x - ax, sy = o.y - ay, sz = o.z - az;
      const u = f * (sx * hx + sy * hy + sz * hz);
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = f * (d.x * qx + d.y * qy + d.z * qz);
      if (v < 0 || u + v > 1) continue;
      const t = f * (e2x * qx + e2y * qy + e2z * qz);
      if (t < best && (ray.behind || t > 1e-9)) best = t;
    }
    return best;
  }

  /** Everything in a scene that is drawn, as the camera sees it: what cannot be seen (or its camera leaves out) is skipped with all under it. */
  function each(root, camera, on) {
    const walk = (o) => {
      if (!o || o.visible === false) return;
      // (What this camera leaves out is not drawn; what is under it may be.)
      if (!(camera && o.layers && camera.layers && (o.layers.mask & camera.layers.mask) === 0)) on(o);
      for (const kid of o.children ?? []) walk(kid);
    };
    walk(root);
  }
  const materialOf = (o) => (Array.isArray(o.material) ? o.material[0] : o.material);

  /** The nearest thing in a scene along a ray. */
  function nearest(scene, camera, ray) {
    const budget = { left: 6e6 };
    let best = null;
    each(scene, camera, (o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || !o.matrixWorld) return;
      const side = materialOf(o)?.side ?? 0;
      if (o.isInstancedMesh && o.instanceMatrix?.array) {
        const all = o.instanceMatrix.array, count = Math.min(o.count ?? 0, 20000);
        for (let i = 0; i < count; i++) {
          const t = meets(ray, o.geometry, times(o.matrixWorld.elements, all.subarray ? all.subarray(i * 16, i * 16 + 16) : all.slice(i * 16, i * 16 + 16)), side, budget);
          if (t < (best?.t ?? Infinity)) best = { object: o, t, instance: i };
        }
        return;
      }
      const t = meets(ray, o.geometry, o.matrixWorld.elements, side, budget);
      if (t < (best?.t ?? Infinity)) best = { object: o, t };
    });
    return best;
  }

  // ---- what is said of a thing

  const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  /** The plain values of something (numbers, words, yes or no): what a geometry was made with, what a thing carries. */
  function plain(from, max = 12) {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(from ?? {})) {
      if (n >= max) break;
      if (typeof v === 'number') out[k] = round(v); else if (typeof v === 'string') out[k] = cut(v, 60); else if (typeof v === 'boolean') out[k] = v; else continue;
      n++;
    }
    return n ? out : undefined;
  }
  /** What tells one kind of thing from another, as far as a look at it can: what it is, its shape, what it is made of. */
  const kindOf = (o) => [o.type, o.geometry?.type, o.geometry?.attributes?.position?.count, JSON.stringify(plain(o.geometry?.parameters) ?? ''), materialOf(o)?.type, materialOf(o)?.name, o.name].join('|');

  function corners(o, matrix) {
    const box = o.geometry?.attributes?.position ? boxOf(o.geometry) : [0, 0, 0, 0, 0, 0];
    const out = [];
    for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) out.push(point(matrix, x, y, z));
    return out;
  }
  const matrixOf = (o, instance) => (instance === undefined ? o.matrixWorld.elements : times(o.matrixWorld.elements, Array.from(o.instanceMatrix.array.slice(instance * 16, instance * 16 + 16))));

  function describe(scene, camera, hit, ray) {
    const o = hit.object, g = o.geometry, m = materialOf(o);
    const matrix = matrixOf(o, hit.instance);
    // Which one of the things like it: counted the way the scene holds them.
    const kind = kindOf(o);
    let index = 0, of = 0;
    each(scene, null, (x) => { if (x.isMesh && kindOf(x) === kind) { of++; if (x === o) index = of; } });
    const graph = [];
    for (let at = o; at; at = at.parent) graph.unshift(`${at.type ?? 'Object3D'}${at.name ? ` "${cut(String(at.name), 40)}"` : ''}`);
    const all = corners(o, matrix);
    const size = ['x', 'y', 'z'].map((k) => round(Math.max(...all.map((c) => c[k])) - Math.min(...all.map((c) => c[k]))));
    let data;
    try { const text = JSON.stringify(o.userData ?? {}); if (text && text !== '{}') data = cut(text, 300); } catch { /* something that cannot be written out */ }
    const color = typeof m?.color?.getHexString === 'function' ? `#${m.color.getHexString()}` : undefined;
    const uniforms = m?.uniforms && typeof m.uniforms === 'object' ? Object.keys(m.uniforms).slice(0, 16) : undefined;
    return {
      uuid: String(o.uuid ?? ''),
      type: String(o.type ?? 'Mesh'),
      ...(o.name && { name: cut(String(o.name), 80) }),
      geometry: { type: String(g.type ?? 'BufferGeometry'), ...(g.name && { name: cut(String(g.name), 60) }), ...(plain(g.parameters) && { made: plain(g.parameters) }), points: g.attributes.position.count },
      ...(m && { material: { type: String(m.type ?? 'Material'), ...(m.name && { name: cut(String(m.name), 60) }), ...(color && { color }), ...(m.map && { texture: true }), ...(uniforms?.length && { uniforms }) } }),
      position: [round(matrix[12]), round(matrix[13]), round(matrix[14])],
      size,
      point: [round(ray.o.x + ray.d.x * hit.t), round(ray.o.y + ray.d.y * hit.t), round(ray.o.z + ray.d.z * hit.t)],
      index, of,
      ...(hit.instance !== undefined && { instance: hit.instance, instances: o.count }),
      graph: graph.join(' > '),
      ...(data && { userData: data }),
    };
  }
  /** A few words for it, for the person: its name when it has one, else what it is. */
  const SIZES = ['width', 'height', 'depth', 'radius', 'radiusTop', 'radiusBottom', 'length', 'tube'];
  const sizes = (made) => SIZES.filter((k) => typeof made?.[k] === 'number').map((k) => made[k]).join('×');
  const label = (t) => `${t.name ? `${t.type} "${t.name}"` : `${t.type}, ${t.geometry.type}${sizes(t.geometry.made) ? ` ${sizes(t.geometry.made)}` : ''}`}${t.instance !== undefined ? `, instance ${t.instance + 1} of ${t.instances}` : t.of > 1 ? `, ${t.index} of ${t.of}` : ''}`;

  /** Where a thing is on the screen: the box it fits in, as the camera sees it, within its canvas. */
  function onScreen(canvas, camera, o, instance) {
    const r = canvas.getBoundingClientRect();
    const whole = { x: r.left, y: r.top, w: r.width, h: r.height };
    const view = camera.matrixWorldInverse?.elements ?? inverse(camera.matrixWorld.elements);
    if (!view) return whole;
    const seen = corners(o, matrixOf(o, instance)).map((c) => point(times(camera.projectionMatrix.elements, view), c.x, c.y, c.z));
    // (Partly behind the eye, its box is no box on the screen.)
    if (seen.some((p) => !(p.w > 0))) return whole;
    const xs = seen.map((p) => r.left + ((p.x + 1) / 2) * r.width), ys = seen.map((p) => r.top + ((1 - p.y) / 2) * r.height);
    const x0 = Math.max(r.left, Math.min(...xs)), x1 = Math.min(r.right ?? r.left + r.width, Math.max(...xs));
    const y0 = Math.max(r.top, Math.min(...ys)), y1 = Math.min(r.bottom ?? r.top + r.height, Math.max(...ys));
    return x1 - x0 < 1 || y1 - y0 < 1 ? whole : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  window.__tandemScene = {
    /** What in a scene is at a place of the page, when that place is on a canvas three draws on; null when nothing is. */
    at(canvas, x, y) {
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      const nx = ((x - r.left) / r.width) * 2 - 1, ny = 1 - ((y - r.top) / r.height) * 2;
      for (const d of scenesOn(canvas)) {
        const ray = rayFrom(d.camera, nx, ny);
        const hit = ray && nearest(d.scene, d.camera, ray);
        if (!hit) continue;
        const three = describe(d.scene, d.camera, hit, ray);
        return { three, words: label(three), ...onScreen(canvas, d.camera, hit.object, hit.instance) };
      }
      return null;
    },
    /** Where the thing with this id is now, on which canvas; null when it is in no scene that is drawn. */
    where(uuid) {
      for (const [canvas, list] of drawn) for (const d of list) {
        let found = null;
        each(d.scene, null, (o) => { if (!found && o.uuid === uuid) found = o; });
        if (found && canvas.isConnected !== false) return { canvas, ...onScreen(canvas, d.camera, found) };
      }
      return null;
    },
    /**
     * Call back when a canvas of three's has just been drawn on: between two draws it may hold nothing to copy. A
     * page that draws only when something changes is drawn once more for it.
     */
    whenDrawn(canvas, fn) {
      if (!drawn.has(canvas)) return false;
      const mine = () => fn();
      waiting.set(canvas, [...(waiting.get(canvas) ?? []), mine]);
      setTimeout(() => {
        const list = waiting.get(canvas);
        if (!list?.includes(mine)) return;
        waiting.set(canvas, list.filter((f) => f !== mine));
        if (!waiting.get(canvas).length) waiting.delete(canvas);
        const d = scenesOn(canvas)[0];
        try { d.render.call(d.renderer, d.scene, d.camera); } catch { /* copied as it is */ }
        fn();
      }, 300);
      return true;
    },
  };
})();
