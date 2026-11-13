// A host on a scratch copy of nothing: the game's code is the real one, but
// its content, concepts and data go to a temporary folder, so a test can
// change records without touching the game.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, createHost } from '../core/host.ts';

const DRAWINGS = ['gnome', 'garden-flowers', 'garden-visitor', 'garden-props', 'garden-critters', 'garden-icons', 'garden-cottage'];

export async function scratchHost() {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-'));
  // The drawings come along as a copy: a test may change one. Always the same seven, whatever the game has
  // gained since, so that a test's counts do not move with it.
  for (const d of ['art', 'depth']) {
    mkdirSync(join(dir, 'game', d), { recursive: true });
    for (const n of DRAWINGS) if (existsSync(join(ROOT, 'games/gnome-garden', d, `${n}.txt`))) cpSync(join(ROOT, 'games/gnome-garden', d, `${n}.txt`), join(dir, 'game', d, `${n}.txt`));
  }
  const host = await createHost({ game: 'gnome-garden', gameDir: join(dir, 'game'), dataDir: join(dir, 'data') });
  return { host, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const AGENT = 'agent:main';
