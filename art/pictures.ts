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
  /** A workspace of its own holding the game's drawings, with this one as given. */
  function stage(name: string, value: Value) {
    const space = spaces.scratch(), root = spaces.dir(space);
    if (value.text !== undefined) writeFileSync(join(root, 'art', `${name}.txt`), value.text);
    if (value.depth !== undefined) writeFileSync(join(root, 'depth', `${name}.txt`), value.depth);
    return space;
  }
  const looksOf = (name: string, text: string | undefined) => {
    try { return text === undefined ? [] : describeDrawing(name, text).looks.filter((l) => l !== 'default'); } catch { return []; }
  };

  return {
    /** Throws when the proposed drawing does not render. */
    async of(name: string, before: Value | undefined, after: Value): Promise<Pictures> {
      const was = before?.text !== undefined;
      const now = looksOf(name, after.text), then = looksOf(name, before?.text);
      const looks = now.length > 1 || then.length > 1 ? [...new Set([...now, ...then])].slice(0, 12) : [];
      // The drawing as proposed and as it is are rendered side by side, each in a workspace of its own; within
      // one, a render at a time (they all write the same file).
      const side = async (value: Value, has: string[], must: boolean) => {
        const space = stage(name, value);
        try {
          const plain = must ? await shot(space, name) : await shot(space, name).catch(() => undefined);
          const per: Record<string, string | undefined> = {};
          for (const look of looks) if (has.includes(look)) per[look] = await shot(space, name, [`--recolor=${look}`]).catch(() => undefined);
          return { plain, per };
        } finally { spaces.remove(space); }
      };
      const [a, b] = await Promise.all([side(after, now, true), was ? side(before!, then, false) : undefined]);
      return {
        after: a.plain, before: b?.plain,
        ...(looks.length && { looks: looks.map((look) => ({ look, after: a.per[look], before: b?.per[look] })) }),
      };
    },
  };
}

export type PictureMaker = ReturnType<typeof createPictures>;
