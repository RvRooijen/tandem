// Render the garden to a PNG at a few points in a played game.
// Usage: node tools/shot.ts <minutes,minutes,...> [--night] [--width=180] [--out=shots]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createGame } from '../src/sim/game.ts';
import { createScene } from '../src/render/scene.ts';
import { WORLD_H } from '../src/sim/world.ts';
import { encodePng } from './png.ts';
import { play } from './bot.ts';

const args = process.argv.slice(2);
const minutes = (args.find((a) => !a.startsWith('--')) ?? '1').split(',').map(Number);
const out = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'shots';
const width = Number(args.find((a) => a.startsWith('--width='))?.slice(8) ?? 288);
const wantNight = args.includes('--night');
const wantDay = args.includes('--day');
mkdirSync(out, { recursive: true });

const g = createGame(undefined, { seed: 7, quiet: true });
const scene = createScene(width, WORLD_H * 2);
let played = 0;
for (const m of minutes) {
  play(g, m * 60 - played);
  played = m * 60;
  // Step on to the part of the day that was asked for.
  for (let i = 0; i < 1200 && ((wantNight && g.dark < 0.99) || (wantDay && g.dark > 0.01)); i++) { g.step(0.1); g.events.length = 0; }
  for (let i = 0; i < 30; i++) { g.step(0.05); g.events.length = 0; }
  const dayt = args.find((x) => x.startsWith('--dayt='));
  if (dayt) { g.s.flags.awake = 1; g.s.dayT = Number(dayt.slice(7)); for (let i = 0; i < 4; i++) { g.step(0.02); g.events.length = 0; } }
  if (args.includes('--rain')) g.rain = 1;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) scene.render(g, played + 3.3 + i / 60);
  console.log(`  ${((performance.now() - t0) / 20).toFixed(1)} ms a frame`);
  const file = `${out}/t${String(m).padStart(3, '0')}${wantNight ? '-night' : ''}${dayt ? '-' + dayt.slice(7) : ''}.png`;
  writeFileSync(file, encodePng(scene.fb.px, scene.fb.w, scene.fb.h, 2));
  const s = g.s;
  console.log(`${file}  peace ${Math.round(s.peace)} dark ${g.dark.toFixed(2)} gnomes ${JSON.stringify(s.gnomes)} plots ${s.plots} seed ${s.seed} depth ${s.depth} runs ${s.runs}`);
}
