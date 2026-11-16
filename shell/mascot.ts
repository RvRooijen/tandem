// The figure in the round button: a hand puppet of amber fleece with a
// moustache. The button is a hole it comes up out of: its head and body are
// only seen inside the circle, its arms reach out over the edge. What it holds says what the agent is doing:
// a magnifying glass while nothing happens and while the agent looks around, a
// notebook and a pencil while it writes code.
//
// The model (mascot.glb) is made in Blender, its axes kept as they are there
// (z up, the face towards -y): everything below is in those. Only what holds
// still is in the file. What moves is done here: the head nods on its neck and
// its mouth flaps, the arms are tubes along a curve from the shoulder to the hand.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import model from './mascot.glb?url';

export type Mood = 'idle' | 'working' | 'coding';
export interface Mascot {
  el: HTMLCanvasElement;
  /** What the agent is doing now (its status): the figure picks up the tool that goes with it. */
  agent(busy: boolean, doing: string): void;
  /**
   * Dragged from the button: the arm with the glass stretches to that place on the screen, however far it is. When
   * the figure is in another hole than the button (`from`), it does not come over: it puts its arm down its own
   * hole, and the arm comes out of the button with the glass, as through a tunnel between the two.
   */
  reach(x: number, y: number, from?: HTMLElement): void;
  /** Let go: the arm comes back. */
  release(): void;
  /**
   * The other arm takes something from a place on the screen and brings it to another (asked every frame: it may
   * still be moving into view). `card` is what is carried, moved along with the hand. Done when it is delivered.
   */
  /**
   * The tools open or shut beside the page: the loose hand is on their edge while they slide (`edge` is where that is
   * on the screen, asked every frame), pulling them open or pushing them shut.
   */
  hold(edge: () => number, push: boolean): void;
  /**
   * It lives in a hole: the round button, or a small one beside what the agent said in the chat. Told another, it
   * goes down in the one it is in and comes up out of that one (`now`: without going down first). `small`, the
   * hole is one beside a line of text: there its arms come out only while the agent is at work, with what it
   * holds for that, and it faces the other way, away from the edge of the chat. `bare`, its arms stay in whatever the agent does. `says`, it
   * talks for that long once it is up: the line it is beside was just said. `up` is called at that moment.
   */
  into(hole: HTMLElement, how?: { now?: boolean; small?: boolean; bare?: boolean; says?: number; up?: () => void }): void;
  /** Told when it is in another hole than it was, the moment it is moved there (it has yet to come up): `to` gets that hole. */
  moved(to: (hole: HTMLElement) => void): void;
  /** It says something, for this long. */
  say(ms: number): void;
  /** What it is heard to say moves its mouth: asked every frame how far that is open, and nothing when it is silent. */
  voice(mouth: () => number | undefined): void;
  bring(from: { x: number; y: number }, to: () => { x: number; y: number }, card: HTMLElement): Promise<void>;
}

// The canvas is larger than the button, and the button's middle is at (CX, CY) in it.
export const W = 216, H = 175, CX = 124, CY = 70;
/** The hole: the inside of the button, around that middle. */
const HOLE = 51;
/** Pixels to one of the model's units: head and chest fill the hole, what is under them is down in it. */
const PX = 34;
/** The top of its head, in the model's units and in pixels above the button's middle. */
const HEAD_TOP = 3.75, HEAD_UP = 47;
/** One round of every movement, in frames of a 24th of a second. */
const LOOP = 96;
const w = (2 * Math.PI) / LOOP;
/** After code was written the notebook stays out for a while: writing a file takes no time at all. */
const CODING_STAYS = 6000;

type V = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const deg = (d: number) => (d * Math.PI) / 180;
const { sin, cos } = Math;
/** Blender's XYZ angles: three calls that order ZYX. */
const euler = (x: number, y: number, z: number) => new THREE.Euler(x, y, z, 'ZYX');

// Where things are at rest, read off the model in Blender.
const ARM_L = [v(-0.8, 0.03, 1.53), v(-1.556, -0.07, 1.78), v(-2.056, -0.32, 1.13), v(-2.206, -0.47, 0.33), v(-2.006, -0.52, -0.22)];
const ARM_R = [v(0.8, 0.09, 1.47), v(1.619, 0.04, 1.12), v(2.269, -0.31, 1.17), v(2.669, -0.61, 1.67), v(2.869, -0.588, 2.273)];
const MAG = v(2.619, -0.66, 3.29), MAG_ROT = [0.14, -0.209, -0.314];
const STACHE_TIP = v(-0.78, -0.851, 2.68);
/** Where the head turns on the body. */
const NECK = v(0, 0, 1.95);
/** Behind its back, inside the body: where its arms are when they are not out. */
const BEHIND_L = v(-0.5, 0.4, 1.5), BEHIND_R = v(0.5, 0.4, 1.5);
/** Where the arm goes into the hand that holds the magnifying glass, in the glass's own space. */
const PALM = v(0, 0.1, -1.05);

/** How the figure stands at one moment. */
interface Pose {
  head: V;
  /** How far its mouth is open, 0 to 1. */
  mouth: number;
  armL: V[];
  armR: V[];
  /** What the eyes look at. */
  look: V;
  browL: number;
  browR: number;
  /** The frame of the loop at which it blinks. */
  blink: number;
  handL?: { at: V; to: V };
  /** (`small`: under 1 while it comes out of a hole or goes back into one.) */
  mag?: { at: V; rot: THREE.Euler; small?: number };
  book?: { at: V; rot: THREE.Euler };
  pen?: { at: V; axis: V };
  /** Under 1 when the arm with the glass is stretched: thinner the further it reaches. */
  thin?: number;
}

/** An arm from a shoulder to a hand that hangs through in between. */
function arm(shoulder: V, hand: V, sag: V, by = [0, 0.7, 1, 0.45, 0]): V[] {
  return [0, 0.25, 0.5, 0.8, 1].map((s, i) => shoulder.clone().lerp(hand, s).addScaledVector(sag, by[i]!));
}

const POSES: Record<Mood, (t: number) => Pose> = {
  // Nothing to do: it sways, one arm dangles, the other holds the glass up.
  idle(t) {
    const head = (at: number) => v(0.06 * sin(w * at + 1.2), 0.02 * sin(w * at), 0.08 * sin(w * at - 0.5));
    const h = head(t);
    const m = v(0.07 * sin(w * t + 2), 0.03 * sin(2 * w * t), 0.11 * sin(w * t + 0.8));
    const rot = euler(MAG_ROT[0]!, MAG_ROT[1]! + deg(5) * sin(w * t + 2.6), MAG_ROT[2]! + deg(4) * sin(w * t + 1));
    const at = MAG.clone().add(m);
    const armL = ARM_L.map((p, i) => {
      if (i === 0) return p.clone().addScaledVector(h, 0.3);
      const amp = [0, 0.03, 0.09, 0.17, 0.26][i]!;
      return p.clone().add(v(amp * sin(w * t - i * 0.55), amp * 0.6 * cos(w * t - i * 0.55), amp * 0.15 * sin(2 * w * t)));
    });
    const armR = ARM_R.map((p, i) => p.clone().addScaledVector(m, [0, 0.15, 0.4, 0.75, 1][i]!));
    armR[0]!.addScaledVector(h, 0.3);
    armR[2]!.z += 0.08 * sin(w * t - 1);
    armR[3]!.add(v(0, 0.12, -0.1));
    armR[4] = PALM.clone().applyEuler(rot).add(at);
    return {
      head: h, mouth: 0, armL, armR,
      look: v(1.3, -4.5, 3.1), browL: 0, browR: 0, blink: 60,
      handL: { at: armL[4]!, to: armL[4]!.clone().sub(armL[3]!) }, mag: { at, rot },
    };
  },
  // The agent is at work: it looks through the glass, to and fro, and twirls its moustache.
  working(t) {
    const head = (at: number) => v(0.11 * sin(w * at - 0.4), -0.07 + 0.02 * sin(2 * w * at), 0.05 * sin(2 * w * at));
    const h = head(t);
    const lens = v(0.25 + 0.6 * sin(w * t), -2.05 + 0.08 * sin(2 * w * t + 0.5), 3.05 + 0.13 * sin(2 * w * t + 1));
    const rot = euler(deg(6), deg(-14) * sin(w * t), deg(-6) * sin(w * t));
    const palm = PALM.clone().applyEuler(rot).add(lens);
    const wrist = STACHE_TIP.clone().add(h).add(v(-0.3 + 0.05 * cos(4 * w * t), -0.22, -0.34 + 0.05 * sin(4 * w * t)));
    return {
      head: h, mouth: 0.4 * Math.max(0, sin(2 * w * t + 1)) ** 3,
      armL: arm(ARM_L[0]!.clone().addScaledVector(h, 0.3), wrist, v(-0.6, -0.25, -0.5)),
      armR: arm(ARM_R[0]!.clone().addScaledVector(h, 0.3), palm, v(0.45, 0.1, -0.45)),
      look: lens, browL: -0.05, browR: -0.05 + 0.16 * Math.max(0, sin(w * t - 1.2)) ** 3, blink: 73,
      handL: { at: wrist, to: STACHE_TIP.clone().add(h).add(v(-0.08, -0.2, 0)).sub(wrist) }, mag: { at: lens, rot },
    };
  },
  // The agent writes code: the notebook up beside its head, the pencil going over it line by line.
  coding(t) {
    const head = (at: number) => v(-0.09 + 0.03 * sin(w * at), -0.04, -0.01 + 0.03 * sin(2 * w * at));
    const h = head(t);
    const at = v(-1.6 + 0.02 * sin(w * t), -1.15, 2.45 + 0.03 * sin(2 * w * t + 0.6));
    const rot = euler(deg(55 + 2 * sin(w * t)), deg(3 * sin(w * t + 1)), deg(30));
    const onPage = (p: V) => p.applyEuler(rot).add(at);
    // Four lines to a round: written from left to right with a scribble, then back to the start of the next.
    const u = ((t % 24) + 24) % 24, line = ((Math.floor(t / 24) % 4) + 4) % 4, row = (n: number) => 0.2 - 0.11 * n;
    const back = (u - 18) / 6;
    const tip = onPage(u < 18
      ? v(-0.3 + 0.5 * (u / 18), row(line) + 0.02 * sin(u * 2.4), 0.05)
      : v(0.2 - 0.5 * back, row(line) * (1 - back) + row((line + 1) % 4) * back, 0.05 + 0.08 * sin(Math.PI * back)));
    const axis = v(0.5 + 0.06 * sin(t * 0.6), -0.3, 0.3).normalize();
    return {
      // (It mutters along with what it writes.)
      head: h, mouth: u < 18 ? 0.3 * Math.abs(sin(6 * w * t)) : 0,
      armL: arm(ARM_L[0]!.clone().addScaledVector(h, 0.3), onPage(v(-0.5, -0.02, -0.1)), v(-0.7, -0.1, -0.7)),
      // (The writing arm goes low under the moustache and comes to the notebook from below.)
      armR: arm(ARM_R[0]!.clone().addScaledVector(h, 0.3), tip.clone().addScaledVector(axis, 0.36), v(0.25, -0.85, -0.75), [0, 0.8, 1, 0.75, 0]),
      look: tip, browL: -0.03, browR: -0.03, blink: 43,
      book: { at, rot }, pen: { at: tip, axis },
    };
  },
};

/** A point on the curve the five points of an arm make: a cubic B-spline that starts on the first and ends on the last. */
function onCurve(p: V[], u: number, out: V): V {
  const knots = [0, 0, 0, 0, 1, 2, 2, 2, 2];
  const t = Math.min(Math.max(u, 0), 1) * 2, span = t < 1 ? 3 : 4;
  const d = [0, 1, 2, 3].map((j) => p[j + span - 3]!.clone());
  for (let r = 1; r <= 3; r++) {
    for (let j = 3; j >= r; j--) {
      const lo = knots[j + span - 3]!, hi = knots[j + 1 + span - r]!;
      d[j]!.lerpVectors(d[j - 1]!, d[j]!, (t - lo) / (hi - lo));
    }
  }
  return out.copy(d[3]!);
}

/** An arm: a tube that is laid along its curve again every frame, thick at the shoulder and thin at the hand. */
function createArm(material: THREE.Material) {
  const ALONG = 22, ROUND = 8;
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array((ALONG + 1) * ROUND * 3), 3);
  const normal = new THREE.BufferAttribute(new Float32Array((ALONG + 1) * ROUND * 3), 3);
  const index: number[] = [];
  for (let i = 0; i < ALONG; i++) {
    for (let j = 0; j < ROUND; j++) {
      const a = i * ROUND + j, b = i * ROUND + ((j + 1) % ROUND), c = a + ROUND, d = b + ROUND;
      index.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(index);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const at = v(0, 0, 0), next = v(0, 0, 0), along = v(0, 0, 0), side = v(1, 0, 0), up = v(0, 0, 0), n = v(0, 0, 0);
  return {
    mesh,
    /** `thin` under 1: stretched, it is thinner in the middle. */
    lay(points: V[], thin = 1) {
      side.set(0, 1, 0);
      for (let i = 0; i <= ALONG; i++) {
        const u = i / ALONG;
        onCurve(points, u, at);
        onCurve(points, Math.min(u + 0.01, 1), next);
        if (u + 0.01 > 1) onCurve(points, u - 0.01, along).sub(at).negate(); else along.copy(next).sub(at);
        along.normalize();
        // The ring is carried along the curve: its side stays as it was, less what points along the curve now.
        side.addScaledVector(along, -side.dot(along));
        if (side.lengthSq() < 1e-6) side.set(1, 0, 0).addScaledVector(along, -along.x);
        side.normalize();
        up.crossVectors(along, side);
        const radius = 0.11 * (1.5 - 0.7 * u) * (1 - (1 - thin) * sin(Math.PI * u));
        for (let j = 0; j < ROUND; j++) {
          const a = (j / ROUND) * 2 * Math.PI;
          n.copy(side).multiplyScalar(cos(a)).addScaledVector(up, sin(a));
          normal.setXYZ(i * ROUND + j, n.x, n.y, n.z);
          position.setXYZ(i * ROUND + j, at.x + n.x * radius, at.y + n.y * radius, at.z + n.z * radius);
        }
      }
      position.needsUpdate = true;
      normal.needsUpdate = true;
    },
  };
}

const mixV = (a: V, b: V, k: number) => a.clone().lerp(b, k);
/** Between two poses, on the way from one to the other. What is held is the newer one's. */
function between(a: Pose, b: Pose, k: number): Pose {
  return {
    ...b,
    head: mixV(a.head, b.head, k), mouth: a.mouth + (b.mouth - a.mouth) * k,
    armL: a.armL.map((p, i) => mixV(p, b.armL[i]!, k)), armR: a.armR.map((p, i) => mixV(p, b.armR[i]!, k)),
    look: mixV(a.look, b.look, k), browL: a.browL + (b.browL - a.browL) * k, browR: a.browR + (b.browR - a.browR) * k,
    ...(a.mag && b.mag && { mag: { at: mixV(a.mag.at, b.mag.at, k), rot: b.mag.rot } }),
    thin: (a.thin ?? 1) + ((b.thin ?? 1) - (a.thin ?? 1)) * k,
  };
}

export async function createMascot(): Promise<Mascot> {
  const el = document.createElement('canvas');
  el.className = 'mascot';
  const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-3, 6, 8);
  scene.add(sun);

  // Seen from the front, in pixels: the top of its head just under the top of the hole.
  const top = HEAD_TOP + (CY - HEAD_UP) / PX;
  const camera = new THREE.OrthographicCamera(-CX / PX, (W - CX) / PX, top, top - H / PX, 0.1, 60);
  camera.position.set(0, 0, 30);

  // Blender's z is up here. Mirrored: the button is at the
  // right edge of the screen, and the arm with the glass is the one that reaches furthest.
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.scale.x = -1;
  scene.add(root);

  const file = await new GLTFLoader().loadAsync(model);
  root.add(file.scene);
  const part = <T extends THREE.Object3D = THREE.Object3D>(name: string) => {
    const found = file.scene.getObjectByName(`g_${name}`);
    if (!found) throw new Error(`the mascot has no ${name}`);
    return found as T;
  };

  // What is in the hole is drawn inside the circle only: the body goes down into it, and nothing of it shows outside.
  const ratio = renderer.getPixelRatio();
  const hole = { value: v(CX * ratio, (H - CY) * ratio, HOLE * ratio) };
  // What reaches out of the hole is drawn everywhere, except while the figure goes down in it: then that is inside
  // the circle only too.
  const out = { value: v(0, 0, 1e9) };
  const inHole = (material: THREE.Material, also?: (shader: THREE.WebGLProgramParametersWithUniforms) => void, by = hole) => {
    const made = material.clone();
    made.onBeforeCompile = (shader) => {
      shader.uniforms.uHole = by;
      shader.fragmentShader = `uniform vec3 uHole;\n${shader.fragmentShader}`.replace('void main() {', 'void main() {\n  if (distance(gl_FragCoord.xy, uHole.xy) > uHole.z) discard;');
      also?.(shader);
    };
    // (Told apart from the same material outside the hole, and from the body's, which moves as well.)
    made.customProgramCacheKey = () => (also ? 'hole-body' : by === hole ? 'hole' : 'hole-out');
    return made;
  };

  const body = part<THREE.Mesh>('Body');
  const fleece = body.material as THREE.MeshStandardMaterial;
  // The body goes with the head: under the neck it leans the way the head went, down in the hole it stays put.
  const moves = { uHead: { value: v(0, 0, 0) } };
  body.material = inHole(fleece, (shader) => {
    Object.assign(shader.uniforms, moves);
    shader.vertexShader = `uniform vec3 uHead;
${shader.vertexShader}`.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      transformed += uHead * smoothstep(0.7, 1.95, position.z);`);
  });
  // (Glass that bends what is behind it needs the scene drawn twice; a pane you can see through is enough here.)
  part<THREE.Mesh>('MagGlass').material = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.3, roughness: 0.1 });

  /** (An arm is inside the circle only while it reaches for the other hole, too: each has its own say in that.) */
  const outL = { value: v(0, 0, 1e9) }, outR = { value: v(0, 0, 1e9) };
  const armL = createArm(inHole(fleece, undefined, outL)), armR = createArm(inHole(fleece, undefined, outR)), armFar = createArm(fleece);
  armFar.mesh.visible = false;
  root.add(armL.mesh, armR.mesh, armFar.mesh);

  const head = part('Head'), jaw = part('Jaw'), handL = part('HandL'), mag = part('Magnifier'), book = part('Notebook'), pen = part('Pencil');
  const eyes = (['L', 'R'] as const).map((s) => {
    const eye = part<THREE.Mesh>(`Eye${s}`);
    eye.geometry.computeBoundingSphere();
    return { eye, pupil: part(`Pupil${s}`), brow: part(`Brow${s}`), at: eye.position.clone(), r: eye.geometry.boundingSphere!.radius };
  });
  const holed = new Map<THREE.Material, THREE.Material>();
  head.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const from = mesh.material as THREE.Material;
    if (!holed.has(from)) holed.set(from, inHole(from));
    mesh.material = holed.get(from)!;
  });
  const outside = new Map<THREE.Material, THREE.Material>();
  for (const o of [handL, mag, book, pen]) {
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      const from = mesh.material as THREE.Material;
      if (!outside.has(from)) outside.set(from, inHole(from, undefined, out));
      mesh.material = outside.get(from)!;
    });
  }
  const Z = v(0, 0, 1);

  // ---- reaching: while the button is dragged the canvas is the whole screen, and the glass is under the finger.
  /** Where the glass is wanted and where it is by now (it follows a little behind), in the model's units. */
  const wanted = v(0, 0, 0), aim = v(0, 0, 0), finger = { x: 0, y: 0 };
  /** How large it is now (1 in the button as it stands alone), and what follows from that; -1 when it is mirrored. */
  let scale = 0, px = PX, headUp = HEAD_UP, facing = -1;
  let wide = false, shrinking = 0;
  /** The hole it is in, and where the canvas is while it is the whole screen. */
  let home: HTMLElement | undefined;
  const overlay = document.getElementById('tandem') ?? document.body;
  /** The canvas over the whole screen or back around the button; the button's middle stays where it is in it. */
  function layOut(whole: boolean) {
    const fab = home;
    if (!fab) return;
    wide = whole;
    // Over the whole screen the canvas lies over the page itself, not in the hole: a hole in the chat is in a
    // box that cuts off what sticks out of it.
    const place = whole ? overlay : fab;
    if (el.parentElement !== place) place.append(el);
    // It is as large as the button is: in the bar of the tools the button is smaller, and so is the figure.
    const box = fab.getBoundingClientRect(), half = fab.clientWidth / 2;
    scale = half / HOLE;
    px = PX * scale;
    headUp = HEAD_UP * scale;
    // (Around a hole larger than the button the canvas is larger by as much: its arms reach as much further.)
    const more = Math.max(1, scale);
    const fx = whole ? box.left + box.width / 2 : CX * more, fy = whole ? box.top + box.height / 2 : CY * more;
    const cw = whole ? window.innerWidth : Math.round(W * more), ch = whole ? window.innerHeight : Math.round(H * more);
    if (el.width !== Math.floor(cw * ratio) || el.height !== Math.floor(ch * ratio)) renderer.setSize(cw, ch, false);
    Object.assign(el.style, whole
      ? { position: 'fixed', zIndex: '47', left: '0', top: '0', width: `${cw}px`, height: `${ch}px` }
      : { position: '', zIndex: '', left: `${half - fx}px`, top: `${half - fy}px`, width: `${cw}px`, height: `${ch}px` });
    camera.left = -fx / px;
    camera.right = (cw - fx) / px;
    camera.top = HEAD_TOP + (fy - headUp) / px;
    camera.bottom = camera.top - ch / px;
    camera.updateProjectionMatrix();
    hole.value.set(fx * ratio, (ch - fy) * ratio, half * ratio);
    centre.x = fx;
    centre.y = fy;
  }
  const centre = { x: CX, y: CY };
  /** A place on the screen, in the model's units at that depth. */
  const world = (x: number, y: number, depth: number) => v((facing * (x - centre.x)) / px, depth, HEAD_TOP - (y - (centre.y - headUp)) / px);
  /** Reaching: as when nothing happens, but the arm with the glass goes to where the finger is, and it looks there. */
  /** The other hole, when the arm with the glass comes out of that one. */
  let tunnel: HTMLElement | undefined;
  /** Where the arm comes out of the other hole, in the model's units. */
  const mouthOf = (other: HTMLElement) => { const b = other.getBoundingClientRect(); return world(b.left + b.width / 2, b.top + b.height / 2, -1.6); };
  /** The arm that comes out of the other hole, as it is now. */
  let through: { points: V[]; thin: number; own?: 'L' | 'R' } | undefined;
  function reaching(t: number): Pose {
    const pose = POSES.idle(t);
    through = undefined;
    if (tunnel) {
      const from = mouthOf(tunnel);
      wanted.copy(world(finger.x, finger.y, -2));
      aim.lerp(wanted, 0.35);
      const rot = euler(0, Math.atan2(aim.x - from.x, aim.z - from.z), 0);
      const palm = PALM.clone().applyEuler(rot).add(aim), long = palm.distanceTo(from);
      const sag = v(0, 0, -0.1 * Math.sqrt(long));
      through = { points: [from, from.clone().lerp(palm, 0.25).add(sag), from.clone().lerp(palm, 0.5).add(sag), from.clone().lerp(palm, 0.8), palm], thin: Math.min(1, Math.max(0.4, Math.sqrt(3 / Math.max(long, 0.1)))) };
      // Its own arm goes towards the other hole, in front of it, and is seen as far as the edge of its own. Always
      // the same arm: the other is the one that fetches what was pointed at, and has to be free for that.
      const right = true, shoulder = pose.armR[0]!;
      const to = v(from.x - shoulder.x, 0, from.z - shoulder.z).normalize();
      const own = [0, 0.6, 1.5, 2.6, 3.8].map((d, i) => (i ? v(shoulder.x + to.x * d, -1.15, shoulder.z + to.z * d) : shoulder));
      own[2]!.z -= 0.15;
      through.own = right ? 'R' : 'L';
      return {
        ...pose, mouth: 0.3, look: aim.clone(), browL: 0.06, browR: 0.1, handL: undefined,
        armR: right ? own : pose.armR.map(() => BEHIND_R.clone()),
        armL: right ? pose.armL.map(() => BEHIND_L.clone()) : own,
        mag: { at: aim.clone(), rot, small: Math.min(1, long / 1.2) },
      };
    }
    wanted.copy(world(finger.x, finger.y, -2));
    aim.lerp(wanted, 0.35);
    const shoulder = pose.armR[0]!;
    // The handle points back at the shoulder, wherever the glass is.
    const rot = euler(0, Math.atan2(aim.x - shoulder.x, aim.z - shoulder.z), 0);
    const palm = PALM.clone().applyEuler(rot).add(aim);
    const far = palm.distanceTo(shoulder);
    // The arm comes round its side to the front first and goes on from there: reaching across, it passes in front of
    // the body and not through it.
    const elbow = v(shoulder.x + 0.35, -1.45, shoulder.z - 0.15), sag = v(0, -0.1, -0.12 * Math.sqrt(far));
    const lean = v(aim.x, 0, aim.z - 2.4).normalize().multiplyScalar(0.12);
    return {
      ...pose, head: pose.head.clone().add(lean), mouth: 0.45, look: aim.clone(), browL: 0.06, browR: 0.1,
      armR: [shoulder, elbow, elbow.clone().lerp(palm, 0.4).add(sag), elbow.clone().lerp(palm, 0.75).add(sag), palm], mag: { at: aim.clone(), rot },
      thin: Math.min(1, Math.max(0.4, Math.sqrt(3 / Math.max(far, 0.1)))),
    };
  }

  // ---- fetching: the other arm goes out to something, takes hold of it, carries it somewhere and comes back.
  const OUT = 240, GRIP = 140, CARRY = 480, BACK = 300;
  let fetching: { from: { x: number; y: number }; to: () => { x: number; y: number }; card: HTMLElement; since: number; start: V; done: () => void; given: boolean } | undefined;
  /** Where the loose hand was last drawn. */
  const handAt = ARM_L[4]!.clone();
  const ease = (k: number) => { const c = Math.min(Math.max(k, 0), 1); return c * c * (3 - 2 * c); };
  /** The left arm of this pose goes to a place instead, round its side and in front of the body; `much` of the way from where the pose has it. */
  function stretch(pose: Pose, hand: V, much: number): { to: V; thin: number } {
    const shoulder = pose.armL[0]!, far = hand.distanceTo(shoulder);
    const elbow = v(shoulder.x - 0.35, -1.3, shoulder.z - 0.15), sag = v(0, -0.1, -0.12 * Math.sqrt(far));
    const out = [shoulder, elbow, elbow.clone().lerp(hand, 0.4).add(sag), elbow.clone().lerp(hand, 0.75).add(sag), hand];
    const own = pose.armL;
    pose.armL = own.map((p, i) => p.clone().lerp(out[i]!, much));
    const thin = Math.min(1, Math.max(0.4, Math.sqrt(3 / Math.max(far, 0.1))));
    return { to: pose.armL[4]!.clone().sub(pose.armL[3]!), thin: 1 - (1 - thin) * much };
  }
  /** The left arm of this pose, as the fetching has it at this moment; and the card with the hand. */
  function carried(pose: Pose, ms: number): { to: V; thin: number } | undefined {
    const f = fetching;
    if (!f) return;
    const at = ms - f.since, target = f.to(), from = world(f.from.x, f.from.y, -1.7), goal = world(target.x, target.y, -1.7);
    const carried = ease((at - OUT - GRIP) / CARRY), back = ease((at - OUT - GRIP - CARRY) / BACK);
    const hand = at < OUT ? f.start.clone().lerp(from, ease(at / OUT)) : from.lerp(goal, carried);
    const stretched = stretch(pose, hand, 1 - back);
    // The card is in the hand from when it takes hold until it is where it goes.
    const shows = at >= OUT && at < OUT + GRIP + CARRY;
    f.card.hidden = !shows;
    if (shows) {
      const size = Math.min(ease((at - OUT) / GRIP), 1 - ease((at - OUT - GRIP - CARRY + 90) / 90));
      Object.assign(f.card.style, { left: `${centre.x + facing * hand.x * px}px`, top: `${centre.y - headUp + (HEAD_TOP - hand.z) * px}px`, transform: `scale(${Math.max(size, 0.05)})` });
    }
    if (!f.given && at >= OUT + GRIP + CARRY) { f.given = true; f.done(); }
    if (back >= 1) fetching = undefined;
    return stretched;
  }

  // ---- holding: the loose hand on the edge of the tools while they slide open or shut beside the page.
  /** The hand is there before they move (the stylesheet waits as long), and stays until they are still. */
  const REACH = 180, SLIDE = 500;
  let holding: { edge: () => number; push: boolean; since: number; until: number; x: number; ms: number; lean: number } | undefined;
  function onEdge(pose: Pose, ms: number): { to: V; thin: number } | undefined {
    const g = holding;
    if (!g) return;
    const gone = ease((ms - g.until) / 260);
    if (gone >= 1) { holding = undefined; settle(); return; }
    // (Pulling, the fingers are over the edge; pushing, the hand is against it. Shut, the edge is the screen's.)
    const x = Math.min(g.edge() + (g.push ? -8 : 6), window.innerWidth - 6);
    const there = ease((ms - g.since) / REACH) * (1 - gone);
    // It puts its weight into it: towards the edge while it reaches, and with the edge as fast as that goes, so it
    // leans back pulling and forward pushing, most in the middle of the slide.
    const speed = ms > g.ms ? (x - g.x) / (ms - g.ms) : 0;
    g.x = x;
    g.ms = ms;
    g.lean += (Math.max(-1, Math.min(1, speed / 1.4)) - g.lean) * 0.3;
    const reach = Math.sin(Math.PI * Math.min((ms - g.since) / REACH, 1));
    // (Mirrored: to the right on the screen is -x here.)
    pose.head = pose.head.clone().add(v(-0.24 * g.lean - 0.09 * reach, 0, -0.05 * Math.abs(g.lean)));
    pose.browL = pose.browR = -0.07 * Math.abs(g.lean) * there;
    pose.mouth += 0.35 * Math.abs(g.lean) * there;
    const hand = world(x, centre.y + 14 * scale, -1.5);
    pose.look = pose.look.clone().lerp(hand, there);
    return stretch(pose, hand, there);
  }
  /** Back around the button once nothing reaches out of it any more. */
  function settle() {
    window.clearTimeout(shrinking);
    shrinking = window.setTimeout(() => { if (shown !== 'reach' && !fetching && !holding) { layOut(false); if (still) draw(0); } }, still ? 0 : 480);
  }

  type Shown = Mood | 'reach';
  const poseOf = (which: Shown, t: number) => (which === 'reach' ? reaching(t) : POSES[which](t));
  let mood: Mood = 'idle', shown: Shown = 'idle', was: Shown = 'idle', turned = -1e9;
  /** How much of each thing it holds is there: they grow into the hand and shrink out of it. */
  const held = { mag: 1, book: 0, pen: 0, handL: 1 };
  /** How much the mouth shows of what it is saying. */
  let talk = 0;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // ---- from hole to hole: down in the one it is in, up out of the next, and a word when it is there.
  /** How far down it is (1: out of sight), where it is going, whether the hole it is in is a small one in the chat, and how far its arms are out there. */
  let heardMouth: (() => number | undefined) | undefined, spokenMouth = 0;
  let tunnelled = 0, tunnelArm: 'L' | 'R' = 'R';
  let sink = 0, going: { to: HTMLElement; small: boolean; bare: boolean; says: number; up?: () => void } | undefined, small = false, bare = false, saying = 0, armsOut = 1;
  let arrived: ((hole: HTMLElement) => void) | undefined;
  function move(to: HTMLElement, inChat: boolean, armless: boolean) {
    going = undefined;
    small = inChat;
    bare = armless;
    // (Mirrored in the button, which is at the right of the screen; not beside a line, which is at the left.)
    facing = small ? 1 : -1;
    root.scale.x = facing;
    home = to;
    to.append(el);
    // (Laid out anew for the hole it is in now.)
    wide = false;
    scale = 0;
    arrived?.(to);
  }
  /** In another hole at once, down in it: it comes up out of that one without having gone down in the one it was in. */
  function jump(to: HTMLElement, how: { small?: boolean; bare?: boolean; says?: number; up?: () => void }) {
    if (how.says) { saying = performance.now() + how.says; how.up?.(); }
    move(to, !!how.small, !!how.bare);
    holding = undefined;
    sink = still ? 0 : 1;
    if (!still) armsOut = 0;
  }

  function draw(ms: number) {
    // Over the whole screen it is laid out from where the button is: when that moves (the tools open beside the page),
    // or the window is another size, it is laid out again.
    if (wide && home) {
      const box = home.getBoundingClientRect();
      if (box.left + box.width / 2 !== centre.x || box.top + box.height / 2 !== centre.y || el.clientWidth !== window.innerWidth || el.clientHeight !== window.innerHeight) layOut(true);
    } else if (home && home.clientWidth / 2 / HOLE !== scale) layOut(false);
    const t = still ? 0 : (ms / 1000) * 24;
    const k = still ? 1 : Math.min((ms - turned) / 450, 1);
    const now = poseOf(shown, t);
    const pose = k < 1 ? between(poseOf(was, t), now, k * k * (3 - 2 * k)) : now;
    // Beside a line of the chat its arms are out only while the agent is at work, and never while it talks: then it
    // has them behind its back, down in the hole, and looks at who it talks to. It puts them out from there, with
    // what they hold: arm and tool grow out from behind its side together.
    const leaving = !!going && shown !== 'reach' && !fetching && !holding;
    const reaches = !leaving && sink < 0.12 && (shown === 'reach' || !!fetching || (!bare && (!small || ((shown === 'working' || shown === 'coding') && ms >= saying))));
    armsOut = still ? Number(reaches) : Math.min(1, Math.max(0, armsOut + (reaches ? 0.07 : -0.09)));
    const outK = armsOut * armsOut * (3 - 2 * armsOut);
    if (outK < 1) {
      for (const [arm, behind] of [[pose.armL, BEHIND_L], [pose.armR, BEHIND_R]] as const) for (const p of arm) p.lerpVectors(behind, p, outK);
      pose.look = v(0, -8, 3.4).lerp(pose.look, outK);
      pose.mouth *= outK;
    }

    moves.uHead.value.copy(pose.head);
    // A puppet on a hand: the head tilts the way it goes, and when the mouth opens the head goes up more than the
    // jaw goes down. It talks when it has come up beside something the agent said.
    // Going elsewhere it waits until its arms are back, goes down, and is moved when it is out of sight.
    const reachingOut = shown === 'reach' || !!fetching || !!holding;
    if (going && !reachingOut && sink > 0.97) { if (going.says) { saying = ms + going.says; going.up?.(); } move(going.to, going.small, going.bare); layOut(false); }
    // (It draws its arms in before it goes down, and puts them out once it is up: they are never cut off by the hole.)
    sink = still ? 0 : sink + ((leaving && armsOut < 0.05 ? 1 : 0) - sink) * 0.22;
    root.position.y = -3.6 * sink * sink;
    out.value.copy(hole.value).setZ(sink > 0.02 ? hole.value.z : 1e9);
    // (And for a moment after the tunnel, while its arm comes back.)
    if (tunnel && through?.own) { tunnelled = ms + 450; tunnelArm = through.own; }
    const inTunnel = ms < tunnelled;
    outL.value.copy(hole.value).setZ(sink > 0.02 || (inTunnel && tunnelArm === 'L') ? hole.value.z : 1e9);
    outR.value.copy(hole.value).setZ(sink > 0.02 || (inTunnel && tunnelArm === 'R') ? hole.value.z : 1e9);
    // What is heard moves the mouth; where nothing is heard (yet: the voice may still be on its way) it flaps by itself
    // for as long as it was told the line takes.
    const heard = heardMouth?.();
    if (heard !== undefined) saying = Math.max(saying, ms + 120);
    talk += ((heard === undefined && ms < saying ? 1 : 0) - talk) * 0.2;
    spokenMouth += ((heard ?? 0) - spokenMouth) * 0.55;
    const mouth = Math.min(1, pose.mouth + talk * (0.12 + 0.5 * Math.abs(sin(t * 0.9)) * (0.6 + 0.4 * sin(t * 0.23))) + 0.85 * spokenMouth);
    head.position.copy(NECK).add(pose.head);
    head.rotation.set(-0.22 * mouth - 0.6 * pose.head.y, 1.6 * pose.head.x, 0, 'ZYX');
    jaw.rotation.x = 0.42 * mouth;
    const fetched = carried(pose, ms) ?? onEdge(pose, ms);
    armL.lay(pose.armL, fetched?.thin ?? 1);
    armR.lay(pose.armR, pose.thin ?? 1);
    armFar.mesh.visible = shown === 'reach' && !!through;
    if (through && armFar.mesh.visible) armFar.lay(through.points, through.thin);

    const handTo = fetched?.to ?? now.handL?.to;
    for (const [name, node, there] of [['mag', mag, !!now.mag], ['book', book, !!now.book], ['pen', pen, !!now.pen], ['handL', handL, !!handTo]] as const) {
      held[name] = still ? Number(there) : Math.min(Math.max(held[name] + (there ? 0.12 : -0.12), 0), 1);
      node.visible = held[name] > 0.01;
      node.scale.setScalar(held[name] * outK * (name === 'mag' ? pose.mag?.small ?? 1 : 1));
    }
    if (pose.mag) { mag.position.lerpVectors(BEHIND_R, pose.mag.at, outK); mag.rotation.copy(pose.mag.rot); }
    if (now.book) { book.position.lerpVectors(BEHIND_L, now.book.at, outK); book.rotation.copy(now.book.rot); }
    if (now.pen) { pen.position.lerpVectors(BEHIND_R, now.pen.at, outK); pen.quaternion.setFromUnitVectors(Z, now.pen.axis); }
    if (handTo) { handL.position.copy(pose.armL[4]!); handL.quaternion.setFromUnitVectors(Z, handTo.clone().normalize()); }
    handAt.copy(pose.armL[4]!);

    const frame = ((t % LOOP) + LOOP) % LOOP, shut = Math.max(0, 1 - Math.abs(frame - pose.blink) / 3);
    for (const [i, e] of eyes.entries()) {
      // A pupil looks at a point, but never turns so far that it goes into the face.
      const d = pose.look.clone().sub(NECK).sub(e.at).sub(pose.head).normalize();
      d.set(Math.min(Math.max(d.x, -0.42), 0.42), -Math.abs(d.y) - 0.3, Math.min(Math.max(d.z, -0.32), 0.4)).normalize();
      e.pupil.position.copy(e.at).addScaledVector(d, e.r * 0.8);
      e.eye.scale.z = e.pupil.scale.z = 1 - 0.94 * shut;
      e.brow.position.z = i === 0 ? pose.browL : pose.browR;
    }
    renderer.render(scene, camera);
  }

  let last = 0;
  const tick = (ms: number) => {
    requestAnimationFrame(tick);
    // The hole it is in went out of view while it was on its way to another (on a phone the button is gone once the
    // tools are open): nothing is drawn in a hole that is not seen, so it would never get down in it. It comes up
    // out of the other.
    if (going && home && !fetching && !home.getClientRects().length) jump(going.to, going);
    // Not when it is not seen, and not more often than the eye needs for something this small.
    // (Reaching, it is drawn every frame: it follows a finger.)
    if (document.hidden || !home || !home.getClientRects().length || (ms - last < 30 && !wide)) return;
    last = ms;
    draw(ms);
  };
  if (still) draw(0); else requestAnimationFrame(tick);

  let codingUntil = 0, timer = 0;
  const turn = (to: Shown) => {
    if (to === shown) return;
    was = shown;
    shown = to;
    turned = performance.now();
    if (still) draw(0);
  };
  return {
    el,
    agent(busy, doing) {
      if (busy && /^(edit|write|multiedit|notebookedit)$/i.test(doing)) codingUntil = Date.now() + CODING_STAYS;
      const coding = busy && Date.now() < codingUntil;
      mood = coding ? 'coding' : busy ? 'working' : 'idle';
      if (shown !== 'reach') turn(mood);
      window.clearTimeout(timer);
      if (coding) timer = window.setTimeout(() => { mood = 'working'; if (shown !== 'reach') turn(mood); }, codingUntil - Date.now());
    },
    reach(x, y, from) {
      window.clearTimeout(shrinking);
      if (!wide) layOut(true);
      finger.x = x;
      finger.y = y;
      if (shown !== 'reach') {
        tunnel = from && from !== home ? from : undefined;
        aim.copy(tunnel ? mouthOf(tunnel) : poseOf(shown, (performance.now() / 1000) * 24).mag?.at ?? MAG);
        turn('reach');
        // (Through the tunnel nothing comes over from where its hands were: the arm is in the other hole at once.)
        if (tunnel) { was = 'reach'; armsOut = 1; }
      }
      if (still) { reaching(0); aim.copy(wanted); draw(0); }
    },
    into(to, how = {}) {
      if (going?.to === to) return;
      if (!going && home === to) return;
      if (home === to) { going = undefined; return; }
      // (Not in a page any more, the hole it was in is gone: it comes up out of the new one. So it does when that
      // hole is not shown: on a phone the button is gone while the tools are open, and nothing is drawn in a hole
      // that is not seen, so it would never get down in it and out of it.)
      if (how.now || !home?.isConnected || !home.getClientRects().length || still) {
        jump(to, how);
        if (still) draw(0);
        return;
      }
      going = { to, small: !!how.small, bare: !!how.bare, says: how.says ?? 0, up: how.up };
    },
    say(ms) { saying = performance.now() + ms; },
    voice(mouth) { heardMouth = mouth; },
    moved(to) { arrived = to; },
    hold(edge, push) {
      if (still || !home) return;
      window.clearTimeout(shrinking);
      if (!wide) layOut(true);
      const now = performance.now();
      holding = { edge, push, since: now, until: now + REACH + SLIDE + 60, x: Math.min(edge(), window.innerWidth - 6), ms: now, lean: 0 };
    },
    bring(from, to, card) {
      if (still || !home) return Promise.resolve();
      window.clearTimeout(shrinking);
      if (!wide) layOut(true);
      return new Promise<void>((done) => {
        const mine = { from, to, card, since: performance.now(), start: handAt.clone(), done, given: false };
        fetching = mine;
        // (A page that is not drawn, in a tab that is not looked at, still gets what was pointed at.)
        window.setTimeout(() => { if (!mine.given) { mine.given = true; card.hidden = true; if (fetching === mine) fetching = undefined; done(); } }, OUT + GRIP + CARRY + 600);
      });
    },
    release() {
      if (shown !== 'reach') return;
      // Through the tunnel there is no way back to show: the arm and the glass are gone at once, as they came, and
      // it has its arms in again (it never reached from its own hole, so it does not come back from that either).
      if (tunnel) {
        tunnel = undefined;
        shown = was = mood;
        armsOut = 0;
        // (And from there they come out of the hole as they always do, not cut off by it.)
        tunnelled = 0;
        settle();
        if (still) draw(0);
        return;
      }
      turn(mood);
      // The canvas stays the whole screen until the arm is back.
      settle();
    },
  };
}
