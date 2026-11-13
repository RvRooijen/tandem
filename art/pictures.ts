// Pictures of a proposed drawing: as it is and as it would be. A drawing with
// looks (colour variants: a cottage in four seasons) gets a pair per look,
// because the plain render shows only the first of them and the change may be
// in the others.
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDrawing } from './sprites.ts';
import type { Workspaces } from './workspace.ts';

export interface Pictures {
  before?: string;
  after?: string;
  /** Per look, when the drawing has more than one. */
  looks?: { look: string; before?: string; after?: string }[];
}

type Value = { text?: string; depth?: string };

export function createPictures(spaces: Workspaces, newLookFile: () => { file: string; url: string }) {
  async function shot(space: string, name: string, flags: string[] = []) {
    const look = newLookFile();
    copyFileSync(await spaces.render(space, `art/${name}.txt`, flags), look.file);
    return look.url;
  }
  /** A workspace holding the game's drawings, with this one as given. */
  function stage(space: string, name: string, value: Value) {
    const root = spaces.ensure(space, true);
    if (value.text !== undefined) writeFileSync(join(root, 'art', `${name}.txt`), value.text);
    if (value.depth !== undefined) writeFileSync(join(root, 'depth', `${name}.txt`), value.depth);
  }
  const looksOf = (name: string, text: string | undefined) => {
    try { return text === undefined ? [] : describeDrawing(name, text).looks.filter((l) => l !== 'default'); } catch { return []; }
  };

  return {
    /** Throws when the proposed drawing does not render. */
    async of(name: string, before: Value | undefined, after: Value): Promise<Pictures> {
      const out: Pictures = {};
      stage('_after', name, after);
      out.after = await shot('_after', name);
      const was = before?.text !== undefined;
      if (was) {
        stage('_before', name, before!);
        out.before = await shot('_before', name).catch(() => undefined);
      }
      const now = looksOf(name, after.text), then = looksOf(name, before?.text);
      if (now.length > 1 || then.length > 1) {
        out.looks = [];
        for (const look of [...new Set([...now, ...then])].slice(0, 12))
          out.looks.push({
            look,
            after: now.includes(look) ? await shot('_after', name, [`--recolor=${look}`]).catch(() => undefined) : undefined,
            before: then.includes(look) ? await shot('_before', name, [`--recolor=${look}`]).catch(() => undefined) : undefined,
          });
      }
      return out;
    },
  };
}

export type PictureMaker = ReturnType<typeof createPictures>;
