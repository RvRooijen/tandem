// Heavy work in a process of its own: a playthrough, a picture of the project
// at some hour. A job loads the project's adapter from the folder it is run
// in, which is how the agent's working copy is played and looked at before it
// is accepted: the same job, run there. Reads one JSON spec from stdin and
// writes one JSON result to stdout.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GameModule } from './game.ts';
import { encodePng } from './png.ts';
import { runPacing } from '../playtest/pacing.ts';

/** `adapter` is the project's adapter module, relative to the folder the job runs in. */
export type JobSpec =
  | { adapter: string; do: 'pacing'; profile?: string; owners?: number }
  /** A new game, played by a bot up to a minute, and drawn. */
  | { adapter: string; do: 'lookAt'; minutes: number; profile?: string; out: string }
  /** A world as it is (its snapshot), drawn. */
  | { adapter: string; do: 'look'; snapshot: unknown; out: string };

// What goes wrong is said in one line, for whoever asked.
process.on('uncaughtException', (e) => { process.stdout.write('\n@@error ' + JSON.stringify(e instanceof Error ? e.message : String(e)) + '\n'); process.exit(1); });
process.on('unhandledRejection', (e) => { process.stdout.write('\n@@error ' + JSON.stringify(e instanceof Error ? e.message : String(e)) + '\n'); process.exit(1); });

const spec = JSON.parse(readFileSync(0, 'utf8')) as JobSpec;
const { game } = (await import(join(process.cwd(), spec.adapter))) as { game: GameModule };

let result: unknown;
if (spec.do === 'pacing') {
  result = runPacing(game, spec.profile, spec.owners);
} else {
  const world = spec.do === 'look' ? game.createWorld(spec.snapshot ?? undefined, { seed: 1 }) : game.createWorld(undefined, { seed: 1 });
  if (spec.do === 'look') world.step(0.05);
  else if (spec.minutes > 0) game.playthrough(world, spec.profile ?? 'eager', { owners: 99, untilSeconds: spec.minutes * 60, seed: 1 });
  const pic = game.render(world, { time: 3.3 });
  mkdirSync(dirname(spec.out), { recursive: true });
  writeFileSync(spec.out, encodePng(pic.px, pic.w, pic.h));
  result = { w: pic.w, h: pic.h, text: world.describe() };
}
process.stdout.write('\n@@result ' + JSON.stringify(result) + '\n');
