// Set what each metre of the hole costs so that it takes the time it is meant to.
// Plays the game as an eager player, times every metre, scales that metre's cost by
// (time wanted / time taken), and repeats until it settles. Then writes the table into economy.ts.
// Usage: node tools/calibrate.ts [rounds=5]
import { readFileSync, writeFileSync } from 'node:fs';
import { createGame } from '../src/sim/game.ts';
import { digTable, metreSeconds, setDigTable } from '../src/sim/economy.ts';
import { PROFILES, playthrough } from './bot.ts';
import { fmtTime } from '../src/util.ts';

const rounds = Number(process.argv[2] ?? 5);
let table = digTable().slice();

for (let round = 1; round <= rounds; round++) {
  setDigTable(table);
  const g = createGame(undefined, { seed: 1, quiet: true });
  const reached: number[] = [];      // seconds played when each depth was reached
  let last = 0;
  // Play in half-minute pieces and note the depth after each.
  for (let i = 0; i < 2 * 60 * 40 && !g.s.runs && g.s.depth < 100; i++) {
    playthrough(g, PROFILES.eager, { owners: 99, maxHours: 0.5 / 60, seed: i + 1, dt: 0.2 });
    for (let d = last + 1; d <= g.s.depth; d++) reached[d] = g.s.stats.played;
    last = Math.max(last, g.s.depth);
  }
  const start = reached[1] !== undefined ? reached[1] - metreSeconds(0) : 0;
  let worst = 0;
  const next = table.slice();
  for (let d = 0; d < 100; d++) {
    const from = d === 0 ? start : reached[d], to = reached[d + 1];
    if (from === undefined || to === undefined) { if (d > 0) next[d] = next[d - 1] + (table[d] - table[d - 1]); continue; }
    const took = Math.max(15, to - from);
    const ratio = Math.min(4, Math.max(0.25, metreSeconds(d) / took));
    worst = Math.max(worst, Math.abs(Math.log(ratio)));
    next[d] = table[d] + Math.log(ratio) * 0.8;
  }
  // Smooth: no metre should be far out of line with its neighbours.
  table = next.map((_, d) => {
    const a = next[Math.max(0, d - 1)], b = next[d], c = next[Math.min(99, d + 1)];
    return Math.round(((a + 2 * b + c) / 4) * 100) / 100;
  });
  const at = (d: number) => (reached[d] === undefined ? 'never' : fmtTime(reached[d]));
  console.log(`round ${round}: depth ${last} after ${fmtTime(g.s.stats.played)}; 4 m ${at(4)}, 12 m ${at(12)}, 32 m ${at(32)}, 60 m ${at(60)}, 100 m ${at(100)}; worst metre off by x${Math.exp(worst).toFixed(2)}`);
}

const file = new URL('../src/sim/economy.ts', import.meta.url);
const src = readFileSync(file, 'utf8');
const out = src.replace(/(\/\/ calibrated:begin\n)[\s\S]*?(\/\/ calibrated:end)/, `$1let DIG: number[] = [${table.join(', ')}];\n$2`);
writeFileSync(file, out);
console.log('wrote the table into src/sim/economy.ts');
