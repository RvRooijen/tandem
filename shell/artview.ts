// A drawing, drawn in the page from its text: every animation a row, its
// frames side by side. This is what makes watching a worker live possible: the
// text arrives as it is typed, and each version that can be read is shown.
// The parser is pixeldraw's, the same one the engine renders and builds with.
import * as THREE from 'three';
import { recolor } from '../art/src/attach.js';
import { looksOf, parseArt } from '../art/src/parse.js';

interface Art {
  width: number; height: number;
  anims: { name: string; frames: number[] }[];
  frames: { pixels: (number[] | null)[][] }[];
}

/**
 * Draw a drawing's text on a canvas: every look (colour variant) a block, one under the other, in the order it
 * gives back. Null when the text cannot be read (half-typed): the canvas keeps what it had.
 */
export function drawArt(canvas: HTMLCanvasElement, text: string, maxWidth = 480): string[] | null {
  let art: Art;
  try { art = parseArt(text) as Art; } catch { return null; }
  if (!art.width || !art.height || !art.frames.length) return null;
  const named = looksOf(art) as string[];
  const looks = named.length ? named : ['default'];
  let variants: Art[];
  try { variants = looks.map((l) => (l === 'default' ? art : recolor(art, l) as Art)); } catch { return null; }
  const anims = art.anims.length ? art.anims : [{ name: 'main', frames: art.frames.map((_f, i) => i) }];
  // One row per animation, per look.
  const rows = variants.flatMap((v) => anims.map((a) => ({ art: v, frames: a.frames })));
  const cols = Math.max(...rows.map((r) => r.frames.length));
  const gap = 1;
  const w = cols * (art.width + gap) + gap, h = rows.length * (art.height + gap) + gap;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = w;
  canvas.height = h;
  const img = ctx.createImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  // A dark check, so what is see-through shows.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = ((x >> 2) + (y >> 2)) & 1 ? 0xff3c3232 : 0xff332a2a;
  rows.forEach((row, r) => row.frames.forEach((f, c) => {
    const ox = gap + c * (art.width + gap), oy = gap + r * (art.height + gap);
    row.art.frames[f]?.pixels.forEach((line, y) => line.forEach((p, x) => {
      if (!p || y >= art.height || x >= art.width) return;
      const a = (p[3] ?? 255) / 255, at = (oy + y) * w + ox + x, under = px[at];
      const mix = (c1: number, shift: number) => Math.round(c1 * a + ((under >> shift) & 255) * (1 - a));
      px[at] = ((255 << 24) | (mix(p[2], 16) << 16) | (mix(p[1], 8) << 8) | mix(p[0], 0)) >>> 0;
    }));
  }));
  ctx.putImageData(img, 0, 0);
  // As large as fits, in whole pixels, so it stays crisp.
  const scale = Math.max(1, Math.min(10, Math.floor(maxWidth / w)));
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
  return looks;
}

// ---------------------------------------------------------------- a 3D model

// A 3D model (art/model) is watched as a thing that can be turned, and one with
// animations moves. The engine builds it (its text is a program, which runs
// only there, shut in) and gives it as a .glb; it is drawn here by the graphics
// card (three.js, as the figure is). The engine's own pictures, dot by dot, are
// for who looks without one: the agent and the workers.

/** A model as the engine gives it (art.mesh). */
export interface Mesh { glb: string; profiles: { front: string[]; side: string[]; rows?: [number, number] }[]; bones: string[]; anims: Record<string, number>; triangles: number }
/** How it is shown: in which animation it moves (none: at rest), with the outlines of its faces. */
export interface Showing { anim?: string; wire?: boolean }

interface Stage {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; turn: THREE.Group;
  model?: THREE.Object3D; mixer?: THREE.AnimationMixer; clips: THREE.AnimationClip[];
  yaw: number; pitch: number; distance: number; show: Showing; glb?: string; dirty: boolean; clock: THREE.Clock;
  /** The model last asked to be shown, which may still be being read; and how large the one shown is. */
  wanted?: string; radius: number;
}
const SIDE = 320;
/** Per canvas its stage, or null where the graphics card cannot be used: there a model is not shown. */
const stages = new WeakMap<HTMLCanvasElement, Stage | null>();

function stageOf(canvas: HTMLCanvasElement): Stage | null {
  const had = stages.get(canvas);
  if (had !== undefined) return had;
  let stage: Stage | null = null;
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(SIDE, SIDE, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('rgb(51, 42, 42)');
    scene.add(new THREE.HemisphereLight('#ffffff', '#5a4a4a', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(-0.45, 0.65, 0.6);
    scene.add(sun);
    const turn = new THREE.Group();
    scene.add(turn);
    stage = { renderer, scene, camera: new THREE.PerspectiveCamera(30, 1, 0.01, 1000), turn, clips: [], yaw: -35, pitch: 20, distance: 1, show: {}, dirty: true, clock: new THREE.Clock(), radius: 1 };
    Object.assign(canvas.style, { width: `min(100%, ${SIDE}px)`, height: 'auto', imageRendering: 'auto', touchAction: 'none', cursor: 'grab' });
    // Dragging turns it; two fingers or the wheel bring it nearer.
    const s = stage, down = new Map<number, { x: number; y: number }>();
    let from: { yaw: number; pitch: number; x: number; y: number; apart?: number; distance: number } | undefined;
    const apart = () => { const [a, b] = [...down.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : undefined; };
    canvas.addEventListener('pointerdown', (e) => {
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      from = { yaw: s.yaw, pitch: s.pitch, x: e.clientX, y: e.clientY, apart: apart(), distance: s.distance };
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!from || !down.has(e.pointerId)) return;
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = apart();
      if (now && from.apart) s.distance = Math.max(0.2, Math.min(4, from.distance * (from.apart / now)));
      else { s.yaw = from.yaw + (e.clientX - from.x) * 0.6; s.pitch = Math.max(-89, Math.min(89, from.pitch + (e.clientY - from.y) * 0.4)); }
      s.dirty = true;
    });
    for (const end of ['pointerup', 'pointercancel']) canvas.addEventListener(end, (e) => { down.delete((e as PointerEvent).pointerId); from = down.size ? { yaw: s.yaw, pitch: s.pitch, ...[...down.values()][0], apart: apart(), distance: s.distance } : undefined; });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); s.distance = Math.max(0.2, Math.min(4, s.distance * (e.deltaY > 0 ? 1.1 : 0.9))); s.dirty = true; }, { passive: false });
    run(canvas, stage);
  } catch { /* no graphics card to draw with here */ }
  stages.set(canvas, stage);
  return stage;
}

/** Keeps a stage drawn while its model moves, or when it was turned or changed; until its canvas has left the page. */
function run(canvas: HTMLCanvasElement, s: Stage) {
  let shown = false, waited = 0;
  const frame = () => {
    if (canvas.isConnected) shown = true;
    if (shown ? !canvas.isConnected : ++waited > 600) {
      s.renderer.dispose();
      s.renderer.forceContextLoss();
      stages.delete(canvas);
      return;
    }
    const dt = s.clock.getDelta();
    if (s.mixer && s.show.anim) { s.mixer.update(dt); s.dirty = true; }
    if (s.dirty && s.model) {
      s.dirty = false;
      s.turn.rotation.set(s.pitch * Math.PI / 180, s.yaw * Math.PI / 180, 0, 'XYZ');
      s.camera.position.set(0, 0, s.radius * 4.2 * s.distance);
      s.renderer.render(s.scene, s.camera);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The outlines of a mesh's faces, as lines over it: where two faces meet at an angle, so a quad shows as one. */
function wireOf(root: THREE.Object3D) {
  const lines: THREE.LineSegments[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const l = new THREE.LineSegments(new THREE.EdgesGeometry((o as THREE.Mesh).geometry, 1), new THREE.LineBasicMaterial({ color: '#fff0c0' }));
    l.name = 'wire';
    lines.push(l);
    o.add(l);
  });
  return lines;
}

/**
 * Draw a model on a canvas, as the engine built it; dragging over it turns it, and in an animation it moves.
 * False when there is no graphics card to draw with: the canvas keeps what it had.
 */
export async function drawModel(canvas: HTMLCanvasElement, mesh: Mesh, show: Showing = {}): Promise<boolean> {
  const s = stageOf(canvas);
  if (!s) return false;
  s.wanted = mesh.glb;
  if (s.glb !== mesh.glb) {
    const bytes = Uint8Array.from(atob(mesh.glb), (c) => c.charCodeAt(0));
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
    // (Another came in while this one was read: that one is shown.)
    if (s.wanted !== mesh.glb) return true;
    const first = !s.model;
    if (s.model) s.turn.remove(s.model);
    s.model = gltf.scene;
    s.clips = gltf.animations;
    s.mixer = new THREE.AnimationMixer(gltf.scene);
    s.glb = mesh.glb;
    s.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }); });
    wireOf(s.model);
    // In the middle, and the whole of it in view (the first time; after that it stays where it was looked at from).
    const box = new THREE.Box3().setFromObject(s.model), middle = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    s.model.position.sub(middle);
    s.turn.add(s.model);
    if (first) s.distance = 1;
    s.camera.position.set(0, 0, radius * 4.2 * s.distance);
    s.camera.near = radius * 0.05; s.camera.far = radius * 40;
    s.camera.updateProjectionMatrix();
    s.radius = radius;
    s.show = {};
  }
  // How it is shown: its animation playing, its lines on or off.
  if (show.anim !== s.show.anim) {
    s.mixer?.stopAllAction();
    const clip = show.anim ? s.clips.find((c) => c.name === show.anim) : undefined;
    if (clip) s.mixer?.clipAction(clip).play();
    else s.mixer?.setTime(0);
  }
  s.model?.traverse((o) => { if (o.name === 'wire') o.visible = !!show.wire; });
  s.show = { ...show };
  s.camera.position.set(0, 0, s.radius * 4.2 * s.distance);
  s.dirty = true;
  return true;
}

/** A silhouette a tube was made from, as a small picture: filled where it is #. */
export function drawProfile(canvas: HTMLCanvasElement, rows: string[], scale = 3) {
  const w = Math.max(1, ...rows.map((r) => r.length)), h = Math.max(1, rows.length);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h), px = new Uint32Array(img.data.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = rows[y]?.[x] === '#' ? 0xffe8e0d8 : ((x >> 2) + (y >> 2)) & 1 ? 0xff3c3232 : 0xff332a2a;
  ctx.putImageData(img, 0, 0);
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
}
