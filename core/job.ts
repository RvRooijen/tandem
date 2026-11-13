// Heavy work in a process of its own: a playthrough, a picture of the game at
// some hour. A job gets the records it should run on, which is how a proposal
// is played before it is accepted: the content lives in the module, so a
// different set of records needs a different process. Reads one JSON spec from
// stdin and writes one JSON result to stdout.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameModule, RecordSet } from './game.ts';
import { encodePng } from './png.ts';
import { runPacing } from '../playtest/pacing.ts';

export type JobSpec =
  | { game: string; records?: RecordSet; do: 'pacing'; profile?: string; owners?: number }
  | { game: string; records?: RecordSet; do: 'lookAt'; minutes: number; profile?: string; out: string };

const spec = JSON.parse(readFileSync(0, 'utf8')) as JobSpec;
const { game } = (await import(`../games/${spec.game}/module.ts`)) as { game: GameModule };
if (spec.records) game.applyRecords(spec.records);

let result: unknown;
if (spec.do === 'pacing') {
  result = runPacing(game, spec.profile, spec.owners);
} else {
  const world = game.createWorld(undefined, { seed: 1 });
  if (spec.minutes > 0) game.playthrough(world, spec.profile ?? 'eager', { owners: 99, untilSeconds: spec.minutes * 60, seed: 1 });
  const pic = game.render(world, { time: 3.3 });
  mkdirSync(dirname(spec.out), { recursive: true });
  writeFileSync(spec.out, encodePng(pic.px, pic.w, pic.h));
  result = { w: pic.w, h: pic.h, text: world.describe() };
}
process.stdout.write('\n@@result ' + JSON.stringify(result) + '\n');
