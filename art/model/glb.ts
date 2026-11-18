// A model as a file a project loads: glTF in its one-file form (.glb), which
// three.js, Babylon, Godot, Unity and Blender all read. y up, the front toward
// +z, in the model's own units. The colours are in the corners (COLOR_0), so
// there is no texture to load beside it. Every bone is a node, hanging on the
// bone it hangs on, with what moves with it as a mesh of its own; so the
// skeleton is the file's own tree of nodes, and an animation turns (and
// shifts) those nodes, each under its name.
import { sample, eulerQuat, qmul, type Built } from './shapes.ts';

/** A colour as it is written (#rrggbb) to what light does with it: glTF's colours are linear. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function toGlb(built: Built, name = 'model'): Uint8Array {
  const chunks: Uint8Array[] = [], views: Record<string, unknown>[] = [], accessors: Record<string, unknown>[] = [];
  let length = 0;
  const floats = (list: ArrayLike<number>) => new Uint8Array(Float32Array.from(list).buffer);
  const put = (bytes: Uint8Array, type: string, n: number, more: Record<string, unknown> = {}, target?: number) => {
    // (Every run starts on a whole four bytes.)
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target && { target }) });
    chunks.push(bytes);
    length += bytes.length;
    return accessors.push({ bufferView: views.length - 1, componentType: 5126, count: n, type, ...more }) - 1;
  };

  // A mesh per piece: its triangles as they are, each with the way its face looks.
  const meshes: Record<string, unknown>[] = [];
  const meshOf = new Map<number, number>();
  for (const p of built.pieces) {
    const count = p.positions.length / 3;
    if (!count) continue;
    const nrm = new Float32Array(p.positions.length), col = p.colors.map(linear);
    for (let t = 0; t < p.positions.length; t += 9) {
      const a = p.positions.slice(t, t + 3), b = p.positions.slice(t + 3, t + 6), c = p.positions.slice(t + 6, t + 9);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
      for (let k = 0; k < 3; k++) nrm.set([n[0] / l, n[1] / l, n[2] / l], t + k * 3);
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.positions.length; i++) { min[i % 3] = Math.min(min[i % 3], p.positions[i]); max[i % 3] = Math.max(max[i % 3], p.positions[i]); }
    const attributes = {
      POSITION: put(floats(p.positions), 'VEC3', count, { min, max }, 34962),
      NORMAL: put(floats(nrm), 'VEC3', count, {}, 34962),
      COLOR_0: put(floats(col), 'VEC3', count, {}, 34962),
    };
    meshOf.set(p.bone, meshes.push({ name: p.bone < 0 ? name : built.bones[p.bone].name, primitives: [{ attributes, material: 0, mode: 4 }] }) - 1);
  }

  // The model is the first node; the bones hang on it, each on its own.
  const nodes: Record<string, unknown>[] = [{ name, ...(meshOf.has(-1) && { mesh: meshOf.get(-1) }) }];
  built.bones.forEach((b, i) => {
    nodes.push({ name: b.name, translation: b.pos, rotation: b.quat, scale: b.scale, ...(meshOf.has(i) && { mesh: meshOf.get(i) }) });
    const parent = nodes[b.parent + 1] as { children?: number[] };
    (parent.children ??= []).push(i + 1);
  });

  const animations = Object.entries(built.model.anims).map(([anim, a]) => {
    const samplers: Record<string, unknown>[] = [], channels: Record<string, unknown>[] = [];
    for (const [bone, keys] of Object.entries(a.keys)) {
      const i = built.bones.findIndex((b) => b.name === bone);
      if (i < 0) continue;
      const b = built.bones[i];
      // Its keys, and the ends of the loop, so the file plays round as it does here.
      const moments = [...new Set([0, ...keys.map((k) => k.t), 1])].sort((x, y) => x - y);
      const times = moments.map((t) => t * a.seconds);
      const input = put(floats(times), 'SCALAR', times.length, { min: [times[0]], max: [times.at(-1)] });
      const at = moments.map((t) => sample(keys, t === 1 ? 0 : t));
      if (keys.some((k) => k.rot)) {
        const out = at.flatMap((k) => (k.rot ? qmul(b.quat, eulerQuat(k.rot)) : b.quat));
        samplers.push({ input, output: put(floats(out), 'VEC4', times.length), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: i + 1, path: 'rotation' } });
      }
      if (keys.some((k) => k.pos)) {
        const out = at.flatMap((k) => (k.pos ? [b.pos[0] + k.pos[0], b.pos[1] + k.pos[1], b.pos[2] + k.pos[2]] : b.pos));
        samplers.push({ input, output: put(floats(out), 'VEC3', times.length), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: i + 1, path: 'translation' } });
      }
    }
    return { name: anim, samplers, channels };
  }).filter((a) => a.channels.length);

  const json = {
    asset: { version: '2.0', generator: 'tandem' },
    scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes,
    // (Both sides: a model may be open where something goes in, a hat or a sleeve, and is seen inside there.)
    materials: [{ name, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
    ...(animations.length && { animations }),
    buffers: [{ byteLength: length }],
    bufferViews: views,
    accessors,
  };
  const bin = new Uint8Array(Math.ceil(length / 4) * 4);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.length; }
  let head = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(head.length / 4) * 4).fill(0x20);
  padded.set(head);
  head = padded;
  const out = new Uint8Array(12 + 8 + head.length + 8 + bin.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, head.length, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(head, 20);
  view.setUint32(20 + head.length, bin.length, true); view.setUint32(24 + head.length, 0x004e4942, true);
  out.set(bin, 28 + head.length);
  return out;
}
