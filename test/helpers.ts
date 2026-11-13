// A host on a scratch copy of nothing: the game's code is the real one, but
// its content, concepts and data go to a temporary folder, so a test can
// change records without touching the game.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../core/host.ts';

export async function scratchHost() {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-'));
  const host = await createHost({ game: 'gnome-garden', gameDir: join(dir, 'game'), dataDir: join(dir, 'data') });
  return { host, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const AGENT = 'agent:main';
