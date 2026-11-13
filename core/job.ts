// Heavy work in a process of its own: a playthrough, a picture of the game at
// some hour. A job gets the records it should run on, which is how a proposal
// is played before it is accepted: the content lives in the module, so a
// different set of records needs a different process. Reads one JSON spec from
// stdin and writes one JSON result to stdout.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameModule, Picture, RecordSet } from './game.ts';
import { encodePng } from './png.ts';
import { runPacing } from '../playtest/pacing.ts';

export type JobSpec =
  | { game: string; records?: RecordSet; do: 'pacing'; profile?: string; owners?: number }
  | { game: string; records?: RecordSet; do: 'lookAt'; minutes: number; profile?: string; out: string }
  /** The drawings as they are on disk right now (a job always reads them fresh), and a sheet of one of them. */
  | { game: string; records?: RecordSet; do: 'art'; name?: string; look?: string; anim?: string; out?: string };

const spec = JSON.parse(readFileSync(0, 'utf8')) as JobSpec;
const { game } = (await import(`../games/${spec.game}/module.ts`)) as { game: GameModule };
if (spec.records) game.applyRecords(spec.records);

/** Frames side by side on a dark check, each pixel `scale` across, so that what is see-through shows. */
function sheet(frames: Picture[], perRow = 6): Picture & { scale: number } {
  const fw = Math.max(...frames.map((f) => f.w)), fh = Math.max(...frames.map((f) => f.h));
  const cols = Math.min(perRow, frames.length), rows = Math.ceil(frames.length / cols);
  const scale = Math.max(1, Math.min(6, Math.floor(720 / (cols * (fw + 2)))));
  const w = cols * (fw + 2) * scale, h = rows * (fh + 2) * scale;
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = ((x >> 3) + (y >> 3)) & 1 ? 0xff3c3232 : 0xff332a2a;
  frames.forEach((f, n) => {
    const ox = ((n % cols) * (fw + 2) + 1 + ((fw - f.w) >> 1)) * scale, oy = (Math.floor(n / cols) * (fh + 2) + 1 + (fh - f.h)) * scale;
    for (let y = 0; y < f.h * scale; y++)
      for (let x = 0; x < f.w * scale; x++) {
        const c = f.px[Math.floor(y / scale) * f.w + Math.floor(x / scale)];
        if (c) px[(oy + y) * w + ox + x] = c;
      }
  });
  return { w, h, px, scale };
}

// What goes wrong is said in one line, for whoever asked.
process.on('uncaughtException', (e) => { process.stdout.write('\n@@error ' + JSON.stringify(e instanceof Error ? e.message : String(e)) + '\n'); process.exit(1); });

let result: unknown;
if (spec.do === 'pacing') {
  result = runPacing(game, spec.profile, spec.owners);
} else if (spec.do === 'art') {
  if (!game.art) throw new Error(`${game.name} does not say what its drawings are`);
  const drawings = game.art.list();
  if (spec.name && spec.out) {
    const frames = game.art.frames(spec.name, spec.look, spec.anim);
    const pic = sheet(frames.map((f) => f.pic));
    mkdirSync(dirname(spec.out), { recursive: true });
    writeFileSync(spec.out, encodePng(pic.px, pic.w, pic.h));
    result = { drawings, frames: frames.map((f) => f.label), scale: pic.scale };
  } else result = { drawings };
} else {
  const world = game.createWorld(undefined, { seed: 1 });
  if (spec.minutes > 0) game.playthrough(world, spec.profile ?? 'eager', { owners: 99, untilSeconds: spec.minutes * 60, seed: 1 });
  const pic = game.render(world, { time: 3.3 });
  mkdirSync(dirname(spec.out), { recursive: true });
  writeFileSync(spec.out, encodePng(pic.px, pic.w, pic.h));
  result = { w: pic.w, h: pic.h, text: world.describe() };
}
process.stdout.write('\n@@result ' + JSON.stringify(result) + '\n');
