// 3D models as drawings (art/model): a short program that gives back simple
// shapes, run where it can do nothing else; the shapes as faces, with joints
// that turn in animations; pictures of it without a graphics card; and the
// .glb a project loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportArt } from '../art/export.ts';
import { byHeat, clipsOf, pokesOf } from '../art/model/clips.ts';
import { closed, sketchesIn, soFar } from '../art/model/draft.ts';
import { checkModel, isModel, type Model } from '../art/model/format.ts';
import { toGlb } from '../art/model/glb.ts';
import { ringsFromSilhouettes } from '../art/model/profile.ts';
import { readModel, readModelLater } from '../art/model/run.ts';
import { boneMatrices, boxOf, buildModel, posed, sample, transform } from '../art/model/shapes.ts';
import { describeDrawing } from '../art/sprites.ts';

const ART = fileURLToPath(new URL('../art', import.meta.url));

const SIGN = `// @model
const WOOD = '#6b4a2b';
// a plank per step, in a loop
const planks = [0, 1, 2].map((i) => ({ shape: 'box', size: [1, 0.15, 0.05], pos: [0, 0.1 + i * 0.17, 0] }));
export default {
  parts: [
    { shape: 'cylinder', radiusTop: 0.05, radiusBottom: 0.05, height: 1, pos: [0, 0.5, 0], color: WOOD },
    { bone: 'board', pos: [0, 1, 0], color: '#e8d9b0', group: planks },
  ],
  anims: { swing: { seconds: 2, keys: { board: [{ t: 0, rot: [0, 0, 20] }, { t: 0.5, rot: [0, 0, -20] }] } } },
};
`;

test('a model is a program that gives back shapes; what it gives back is checked, and it can do nothing else', async () => {
  assert.ok(isModel(SIGN) && isModel('  // @model\n') && !isModel('a = #ff0000\n@size 2 2\n'));
  const { model } = readModel(SIGN);
  assert.equal(model.parts.length, 2);
  assert.equal(('group' in model.parts[1]) && model.parts[1].group.length, 3, 'the loop made three planks');
  assert.deepEqual(Object.keys(model.anims), ['swing']);
  assert.equal(readModel(SIGN), readModel(SIGN), 'the same text is read once');
  assert.deepEqual((await readModelLater(SIGN)).model, model);

  const wrong = (text: string, says: RegExp) => assert.throws(() => readModel(`// @model\n${text}`), says);
  wrong("import fs from 'node:fs';\nexport default { parts: [] };", /cannot import anything/);
  wrong('const x = 1;', /export default/);
  wrong('const x = ;\nexport default { parts: [] };', /SyntaxError.*\(line 2\)/);
  wrong('\n\nfoo();\nexport default {};', /ReferenceError: foo is not defined \(line 4\)/);
  wrong('while (true) {}\nexport default {};', /timed out|did not end/);
  wrong('export default { parts: [{ shape: "blob" }] };', /parts\[0\]\.shape: is not one of box, wedge/);
  wrong('export default { parts: [{ group: [{ shape: "box", pos: [0, 1] }] }] };', /parts\[0\]\.group\[0\]\.pos: is not \[x, y, z\]/);
  wrong('export default { parts: [{ shape: "box", color: "red" }] };', /parts\[0\]\.color: is not a colour/);
  wrong('export default { parts: [{ shape: "box" }], anims: { walk: { seconds: 1, keys: { leg: [{ t: 0 }] } } } };', /anims\.walk\.keys\.leg: there is no bone called leg/);
  wrong('export default { parts: [{ shape: "box", size: [1, NaN, 1] }] };', /size\[1\]: is not a number/);
  // Out of its own little world it cannot reach: no process, and reaching round the world it is in finds nothing it may read.
  wrong('process.exit(1);\nexport default {};', /process is not defined/);
  wrong(`const p = this.constructor.constructor('return process')();\np.binding;\nconst s = p.getBuiltinModule('node:fs').readFileSync('/etc/hostname', 'utf8');\nexport default { parts: [{ shape: 'box', name: s }] };`, /ERR_ACCESS_DENIED|Access to this API has been restricted|not a function|is not defined/);
  assert.throws(() => checkModel({ parts: [] }), /parts: there are none/);
  // As it is typed, leniently: what is not right yet is left out, and the rest is the model so far.
  assert.deepEqual(checkModel({ parts: [{ shape: 'box' }, { shape: 'loft', rings: [{ y: 0, rx: 1 }] }], anims: { x: { seconds: 0 } } }, true), { parts: [{ shape: 'box' }], anims: {} });
});

test('a model as it is being typed is built as far as it is whole', async () => {
  // What is open is closed after the last whole line; a string, a comment and a bracket in one do not count.
  assert.equal(closed("export default { parts: [\n  { shape: 'box', name: '[x' }, // ]\n  { shape: 'sph"), undefined, 'a string left open is no whole line');
  assert.equal(closed("export default { parts: [\n  { shape: 'box', name: '[x' }, // ]"), "export default { parts: [\n  { shape: 'box', name: '[x' }, // ]\n]}\n");
  const typing = "// @model\nconst a = 1;\nexport default {\n  parts: [\n    { shape: 'box' },\n    { shape: 'loft', rings: [\n      { y: 0, rx: 1 },\n      { y: 1, r";
  assert.equal(soFar(typing).length, 5, 'the lines that can be closed, each a line less, as long as export default is in it');
  assert.throws(() => readModel(typing));
  const read = await readModelLater(typing, true);
  assert.deepEqual([read.draft, read.model.parts], [true, [{ shape: 'box' }]], 'the loft with one ring so far is left out');
  await assert.rejects(readModelLater('// @model\nconst a = [\n', true), /export default/);
  // Its drawings are read as text as they are typed, row by row: the one half typed too, and a list of words is none.
  const drawing = "// @model\nconst thighFront = [\n  '..##..',\n  '.####.', // the knee\n];\nconst names = [\n  'a',\n  'b',\n];\nconst thighSide = [\n  '..##..',\n  '.###";
  assert.deepEqual(sketchesIn(drawing), [{ name: 'thighFront', rows: ['..##..', '.####.'] }, { name: 'thighSide', rows: ['..##..', '.###'] }]);
});

test('a round part is drawn from the front and the side: a ring per row, where the shape turns', () => {
  const front = ['..##..', '..##..', '..##..', '.####.', '######'];
  const side = ['..##..', '..##..', '..##..', '..##..', '.####.'];
  const rings = ringsFromSilhouettes(front, side, { pixel: 0.5, tolerance: 0.25 });
  // The straight part above is two rings, not three: where it starts to widen is one.
  assert.deepEqual(rings.map((r) => r.y), [2.25, 1.25, 0.75, 0.25]);
  assert.deepEqual(rings.map((r) => r.rx), [0.5, 0.5, 1, 1.5]);
  assert.deepEqual(rings.at(-1), { y: 0.25, x: 0, z: 0, rx: 1.5, rz: 1 });
  assert.equal(ringsFromSilhouettes(front, side, { rows: [0, 2] }).length, 2);
  assert.throws(() => ringsFromSilhouettes(['....'], ['....']), /fewer than two rows/);
  // A part that leans: along() goes through the middle of the rows, and is thinner across the way it goes than a row is flat.
  const shin = readModel(`// @model\nconst s = along(['.##...', '..##..', '...##.', '....##'], ['##....', '.##...', '..##..', '...##.'], { pixel: 1 });\nexport default { parts: [{ shape: 'tube', ...s }] };\n`);
  const t = shin.model.parts[0] as { path: number[][]; radii: number[] };
  assert.deepEqual(t.path.map((p) => p.map((v) => Math.round(v * 100) / 100)), [[-1, 3.5, -2], [2, 0.5, 1]], 'a straight lean: its two ends');
  assert.ok(Math.abs(t.radii[0] - Math.cos(Math.atan(Math.hypot(3, 3) / 3)) * 1) < 1e-9, 'thinner across than flat');
  assert.equal(shin.profiles.length, 1, 'and shown beside it, as a drawing it was made from');
  // From a model, with what it was drawn from beside it.
  const read = readModel(`// @model\nconst leg = rings(${JSON.stringify(front)}, ${JSON.stringify(side)}, { pixel: 0.1, tolerance: 0.25 });\nexport default { parts: [{ shape: 'loft', rings: leg, segments: 6 }] };\n`);
  assert.deepEqual(read.profiles, [{ front, side }]);
  assert.equal(('rings' in read.model.parts[0]) && read.model.parts[0].rings.length, rings.length);
  assert.equal(buildModel(read.model).triangles, (rings.length - 1) * 6 * 2 + 2 * 4, 'quads between the rings, and a cap at each end');
});

test('the shapes are faces that look outward, and a mirrored part too', () => {
  const shapes = [
    { shape: 'box', size: [1, 2, 3] }, { shape: 'wedge', size: [1, 1, 1] }, { shape: 'cylinder', height: 2 }, { shape: 'cylinder', radiusTop: 0, height: 1 },
    { shape: 'sphere', radius: 1, detail: 1 }, { shape: 'loft', rings: [{ y: -1, rx: 0.5 }, { y: 0, rx: 1, rz: 0.6 }, { y: 1, rx: 0.3 }] },
    { shape: 'tube', path: [[0, -1, 0], [0, 1, 0]], radii: [0.5, 0.5] }, { shape: 'extrude', outline: [[-1, -1], [1, -1], [1, 0.5], [0, 1], [-1, 0.5]], depth: 1 },
    { shape: 'extrude', outline: [[-1, 0.5], [0, 1], [1, 0.5], [1, -1], [-1, -1]], depth: 1 }, { shape: 'box', size: [1, 1, 1], scale: [-1, 1, 1] },
  ];
  for (const shape of shapes) {
    const p = buildModel(checkModel({ parts: [shape] })).pieces[0].positions;
    for (let t = 0; t < p.length; t += 9) {
      const a = p.slice(t, t + 3), b = p.slice(t + 3, t + 6), c = p.slice(t + 6, t + 9);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      assert.ok(n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] >= -1e-9, `${JSON.stringify(shape)}: a face looks inward`);
    }
  }
  // Open ends: a hat is one tube from its brim to its tip, open underneath, and closes in a point.
  const hat = buildModel(checkModel({ parts: [{ shape: 'tube', segments: 8, caps: 'none', path: [[0, 0, 0], [0, 0.05, 0], [0, 1, 0]], radii: [1, 0.4, 0] }] }));
  assert.equal(hat.triangles, 2 * 8 * 2, 'two bands of quads, no cap below and none at the point');
  const pot = (caps?: string) => buildModel(checkModel({ parts: [{ shape: 'loft', segments: 6, caps, rings: [{ y: 0, rx: 1 }, { y: 1, rx: 1 }] }] })).triangles;
  assert.deepEqual([pot(), pot('start'), pot('end'), pot('none')], [12 + 8, 12 + 4, 12 + 4, 12]);
  assert.throws(() => checkModel({ parts: [{ shape: 'loft', caps: 'top', rings: [{ y: 0, rx: 1 }, { y: 1, rx: 1 }] }] }), /caps: is both, start, end or none/);
  // A loop goes round without a seam: its last ring runs into its first, with no caps.
  const round = Array.from({ length: 12 }, (_, i) => [Math.sin(i / 12 * Math.PI * 2), 0.2 * Math.sin(i / 6 * Math.PI * 2), Math.cos(i / 12 * Math.PI * 2)]);
  const scarf = buildModel(checkModel({ parts: [{ shape: 'tube', loop: true, segments: 6, path: [...round, round[0]], radii: [0.2] }] }));
  assert.equal(scarf.triangles, 12 * 6 * 2, 'twelve bands, the last back to the first, written twice it is there once');
  const p = scarf.pieces[0].positions, corners = new Map<string, number>();
  for (let i = 0; i < p.length; i += 3) { const k = [p[i], p[i + 1], p[i + 2]].map((v) => v.toFixed(4)).join(); corners.set(k, (corners.get(k) ?? 0) + 1); }
  assert.equal(corners.size, 12 * 6, 'every corner of a ring is shared with the next: closed all round');
  // A ring of any shape: a helmet with a ridge down its middle, in its own surface.
  const ridge = (y: number, r: number, h: number) => Array.from({ length: 12 }, (_, i) => { const a = i / 12 * Math.PI * 2, top = i === 0 ? h : 0; return [Math.sin(a) * (r + top), Math.cos(a) * (r + top)]; });
  const helmet = buildModel(checkModel({ parts: [{ shape: 'loft', rings: [{ y: 0, outline: ridge(0, 1, 0.3) }, { y: 1, rx: 0.5 }, { y: 1.5, outline: ridge(1.5, 0.3, 0.1) }] }] }));
  assert.equal(helmet.triangles, 2 * 12 * 2 + 2 * 10, 'twelve points round every ring, the ellipse one too');
  assert.deepEqual(boxOf(helmet).max.map((v) => Math.round(v * 100) / 100), [1, 1.5, 1.3], 'the ridge stands out in front');
  assert.throws(() => checkModel({ parts: [{ shape: 'loft', rings: [{ y: 0, outline: ridge(0, 1, 0) }, { y: 1, outline: [[0, 1], [1, 0], [0, -1]] }] }] }), /has 3 points, and the rings before it 12/);
  // An outline that is not convex keeps its notch.
  const l = buildModel(checkModel({ parts: [{ shape: 'extrude', outline: [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]], depth: 1 }] }));
  assert.deepEqual(boxOf(l), { min: [0, 0, -0.5], max: [2, 2, 0.5] });
  assert.equal(l.triangles, 6 * 2 + 4 * 2, 'six sides of two triangles, and an L of four on each end');
});

test('a group with a bone is a joint: it turns around its place in an animation, with what hangs on it', () => {
  const model: Model = checkModel({
    parts: [
      { shape: 'box', size: [1, 1, 1], pos: [0, 0.5, 0] },
      { bone: 'arm', pos: [0.5, 1, 0], group: [
        { shape: 'box', size: [1, 0.2, 0.2], pos: [0.5, 0, 0] },
        { bone: 'hand', pos: [1, 0, 0], group: [{ shape: 'sphere', radius: 0.1 }] },
      ] },
    ],
    anims: { wave: { seconds: 1, keys: { arm: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [0, 0, 90] }], hand: [{ t: 0.25, pos: [0, 0.1, 0] }] } } },
  });
  const built = buildModel(model);
  assert.deepEqual(built.bones.map((b) => [b.name, b.parent]), [['arm', -1], ['hand', 0]]);
  assert.deepEqual(built.pieces.map((p) => p.bone), [-1, 0, 1], 'a piece per bone, and one for the model itself');
  const at = (anim: string | undefined, t: number, bone: number) => transform(boneMatrices(built, anim, t)[bone], [0, 0, 0]).map((v) => Math.round(v * 1000) / 1000);
  assert.deepEqual(at(undefined, 0, 1), [1.5, 1, 0], 'at rest the hand is at the end of the arm');
  assert.deepEqual(at('wave', 0.5, 1), [0.4, 2, 0], 'raised: the arm turned up around the shoulder, and the hand with it (shifted along the arm\'s up, as its one key says)');
  assert.deepEqual(at('wave', 0.25, 1), [1.136, 1.778, 0], 'halfway there');
  // The loop goes from the last key back to the first.
  assert.deepEqual(sample([{ t: 0.25, rot: [10, 0, 0] }, { t: 0.75, rot: [30, 0, 0] }], 0).rot, [20, 0, 0]);
  assert.deepEqual(sample([{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [40, 0, 0] }], 0.75).rot, [20, 0, 0]);
  const rest = posed(built), up = posed(built, 'wave', 0.5);
  assert.equal(rest.positions.length, up.positions.length);
  assert.deepEqual([...rest.positions.slice(0, 36)], [...up.positions.slice(0, 36)], 'what does not hang on a bone stays');
});

test('where one shape pokes out through another it is in, it is found, and glows', () => {
  // A skirt, and under it a thigh that bulges out through its side at the hip, and comes out below as it should.
  const model = checkModel({ parts: [
    { shape: 'box', size: [1, 1, 1], pos: [0, 0.5, 0], name: 'skirt' },
    { shape: 'loft', segments: 16, name: 'thigh', pos: [0.3, 0, 0], rings: [{ y: -0.6, rx: 0.12 }, { y: 0.15, rx: 0.12 }, { y: 0.45, rx: 0.12 }, { y: 0.5, rx: 0.24 }, { y: 0.56, rx: 0.24 }, { y: 0.62, rx: 0.12 }, { y: 0.9, rx: 0.1 }] },
  ] });
  const built = buildModel(model), clips = clipsOf(built), pokes = pokesOf(built, clips);
  assert.ok(clips.some((c) => c.a === 0 && c.b === 1), 'they cross');
  assert.equal(pokes.length, 1, 'one piece pokes through: the bulge at the hip, not the leg below the skirt');
  assert.deepEqual([pokes[0].shape, pokes[0].in], [1, 0]);
  assert.ok(pokes[0].at[0] > 0.5 && Math.abs(pokes[0].at[1] - 0.53) < 0.05, `at the hip, on the outside (${pokes[0].at})`);
  // As a heatmap: what pokes through glows; the rest is grey.
  const hot = byHeat(built).pieces[0].colors, grey = hot.slice(0, 3);
  const glowing = pokes[0].out.filter((i) => hot[i * 9] > 0.9 && hot[i * 9 + 1] > 0.8);
  assert.equal(glowing.length, pokes[0].out.length);
  assert.ok(grey[0] < 0.6 && Math.abs(grey[0] - grey[2]) < 0.1, 'the skirt is grey');
  // Two shapes that only touch, or one all inside the other, do not poke.
  assert.deepEqual(pokesOf(buildModel(checkModel({ parts: [{ shape: 'box', size: [1, 1, 1] }, { shape: 'box', size: [0.2, 0.2, 0.2] }] }))), []);
});

test('a model is a .glb: its bones a tree of nodes with their meshes, its animations under their names', () => {
  const built = buildModel(readModel(SIGN).model);
  const glb = toGlb(built, 'sign');
  const view = new DataView(glb.buffer, glb.byteOffset);
  assert.deepEqual([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)], [0x46546c67, 2, glb.length]);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const binLength = view.getUint32(20 + jsonLength, true);
  assert.equal(20 + jsonLength + 8 + binLength, glb.length);
  assert.deepEqual(json.nodes.map((n: any) => [n.name, n.mesh, n.children]), [['sign', 0, [1]], ['board', 1, undefined]]);
  assert.deepEqual(json.nodes[1].translation, [0, 1, 0]);
  assert.deepEqual(json.meshes.map((m: any) => Object.keys(m.primitives[0].attributes)), [['POSITION', 'NORMAL', 'COLOR_0'], ['POSITION', 'NORMAL', 'COLOR_0']]);
  assert.equal(json.animations[0].name, 'swing');
  assert.deepEqual(json.animations[0].channels.map((c: any) => [c.target.node, c.target.path]), [[1, 'rotation']]);
  const times = json.accessors[json.animations[0].samplers[0].input];
  assert.deepEqual([times.min, times.max, times.count], [[0], [2], 3], 'its keys, and the end of the loop, in seconds');
  for (const v of json.bufferViews) assert.ok(v.byteOffset % 4 === 0 && v.byteOffset + v.byteLength <= binLength, 'every run is in the file, on a whole four bytes');
  const colors = json.accessors[json.meshes[0].primitives[0].attributes.COLOR_0];
  const at = 28 + jsonLength + json.bufferViews[colors.bufferView].byteOffset;
  assert.ok(Math.abs(new DataView(glb.buffer, glb.byteOffset + at).getFloat32(0, true) - 0.147) < 0.002, 'its colours as light has them (0x6b, linear)');
});

test('a model is described, pictured from its sides with the worker\'s tool, and exported for the project', async () => {
  const d = describeDrawing('sign', SIGN);
  assert.deepEqual({ ...d }, { name: 'sign', w: 1, h: 1.515, d: 0.1, looks: ['default'], anims: { swing: 2 }, model: true, shapes: 4, triangles: 3 * 12 + 6 * 2 + 2 * 4, bones: ['board'] });

  const root = mkdtempSync(join(tmpdir(), 'tandem-model-'));
  try {
    mkdirSync(join(root, 'art'));
    writeFileSync(join(root, 'art/sign.txt'), SIGN);
    writeFileSync(join(root, 'art/blob.txt'), 'a = #ff0000\n\n@size 2 2\naa\naa\n');
    writeFileSync(join(root, 'art/broken.txt'), '// @model\nexport default { parts: [{ shape: "blob" }] };\n');
    // As a worker runs it, from its workspace with the link to the tools.
    symlinkSync(join(ART, 'model'), join(root, 'model'));
    const said = execFileSync(process.execPath, ['--no-warnings', 'model/render.ts', 'art/sign.txt', '--views=front,side,top', '--wire', '--size=96'], { cwd: root, encoding: 'utf8' });
    assert.match(said, /^out\/sign\.png: front, side, top\n56 triangles; it stands in x -0\.5\.\.0\.5, y 0\.\.1\.515, z -0\.05\.\.0\.05; bones: board; animations: swing\n$/);
    const png = readFileSync(join(root, 'out/sign.png'));
    assert.deepEqual([png.subarray(1, 4).toString(), png.readUInt32BE(16), png.readUInt32BE(20)], ['PNG', 96 * 3, 96]);
    execFileSync(process.execPath, ['--no-warnings', 'model/render.ts', 'art/sign.txt', '--anim=swing', '--at=0,0.5', '--size=64'], { cwd: root });
    assert.deepEqual([readFileSync(join(root, 'out/sign.png')).readUInt32BE(16), readFileSync(join(root, 'out/sign.png')).readUInt32BE(20)], [64, 128], 'a row per moment, from three-quarter');
    // Every shape in a colour of its own: the post and its three planks are four colours, not two.
    execFileSync(process.execPath, ['--no-warnings', 'model/render.ts', 'art/sign.txt', '--clips', '--views=front', '--size=128'], { cwd: root });
    const { inflateSync } = await import('node:zlib');
    const sheet = readFileSync(join(root, 'out/sign.png')), idat = inflateSync(sheet.subarray(sheet.indexOf('IDAT') + 4, sheet.indexOf('IEND') - 8));
    const hues = new Set<string>();
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const o = y * (128 * 4 + 1) + 1 + x * 4; const c = [idat[o], idat[o + 1], idat[o + 2]]; if (Math.max(...c) - Math.min(...c) > 60) hues.add(c.map((v) => v >> 5).join()); }
    assert.ok(hues.size >= 4, `four shapes, four colours (${hues.size})`);
    // Where shapes cross is measured: the planks sit in the board on the post's top? No: the post stops at 1, the board hangs on above it; but a plank stuck through the post shows.
    writeFileSync(join(root, 'art/cross.txt'), "// @model\nexport default { parts: [{ shape: 'box', size: [1, 1, 1], pos: [0, 0.5, 0], name: 'block' }, { shape: 'box', size: [0.2, 0.2, 2], pos: [0, 0.5, 0], name: 'bar' }, { shape: 'box', size: [0.1, 0.1, 0.1], pos: [0, 0.5, 0], name: 'hidden' }] };\n");
    const crossing = execFileSync(process.execPath, ['--no-warnings', 'model/render.ts', 'art/cross.txt', '--clips', '--size=64'], { cwd: root, encoding: 'utf8' });
    assert.match(crossing, /^1 places where two shapes cross and it shows from outside/m);
    assert.match(crossing, /shape 0 \(box "block", #cccccc\) and shape 1 \(box "bar", #cccccc\) cross along 1\.6 at 0, 0\.5, 0 .*; seen three-quarter$/m, 'from straight in front the bar hides where it goes in');
    assert.match(crossing, /^0 more cross only inside/m, 'the little box inside the block crosses nothing: it is all inside');
    rmSync(join(root, 'art/cross.txt'));
    assert.throws(() => execFileSync(process.execPath, ['--no-warnings', 'model/render.ts', 'art/broken.txt'], { cwd: root, stdio: 'pipe' }), (e: any) => /parts\[0\]\.shape/.test(String(e.stderr)));
    assert.throws(() => execFileSync(process.execPath, ['--no-warnings', 'model/render.ts', 'art/sign.txt', '--anim=dance'], { cwd: root, stdio: 'pipe' }), (e: any) => /no animation dance; there are: swing/.test(String(e.stderr)));

    const did = exportArt(root, 'public/assets');
    assert.deepEqual([did.drawings, did.models], [['blob'], ['sign']]);
    assert.match(did.skipped.join(), /broken \(parts\[0\]\.shape/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'public/assets/models.json'), 'utf8')), { sign: { file: 'sign.glb', size: [1, 1.515, 0.1], triangles: 56, bones: ['board'], animations: { swing: 2 } } });
    assert.equal(readFileSync(join(root, 'public/assets/sign.glb')).subarray(0, 4).toString(), 'glTF');
    // One that went wrong keeps what it was built as; one that is gone takes its file with it.
    writeFileSync(join(root, 'art/sign.txt'), '// @model\nexport default {};\n');
    assert.deepEqual(exportArt(root, 'public/assets').models, ['sign']);
    assert.ok(existsSync(join(root, 'public/assets/sign.glb')));
    rmSync(join(root, 'art/sign.txt'));
    exportArt(root, 'public/assets');
    assert.ok(!existsSync(join(root, 'public/assets/sign.glb')));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'public/assets/models.json'), 'utf8')), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
