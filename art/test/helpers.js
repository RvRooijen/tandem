// Shared test helpers: small drawings, and a scratch project dir so tests never touch the real art/.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PALETTE = ['a = #ff0000', 'b = #00ff00', 'c = #0000ff'].join('\n');

// A drawing from palette + body lines
export const art = (...body) => `${PALETTE}\n\n${body.join('\n')}\n`;

// The five depth tones, as in CLAUDE.md
export const DEPTH_PALETTE = ['1 = #2b3048', '2 = #3f4a68', '3 = #5a6988', '4 = #7d90ab', '5 = #a6bccf'].join('\n');
export const depthArt = (...body) => `${DEPTH_PALETTE}\n\n${body.join('\n')}\n`;

// Final chars of a parsed frame as strings, one per row
export const rows = (frame) => frame.chars.map((r) => r.join(''));

// A temp dir with art/, depth/, work/ and the given files ({ 'art/x.txt': text }); call cleanup() when done
export function scratchProject(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pixeldraw-test-'));
  for (const d of ['art', 'depth', 'work']) mkdirSync(join(root, d));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
