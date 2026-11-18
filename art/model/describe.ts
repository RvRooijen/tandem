// What a model is, without drawing it: the box it stands in, how many shapes
// and triangles, its bones and its animations. (art.list, and what the agent is
// told when one is taken into the project.)
import { bonesOf, shapesOf } from './format.ts';
import { readModel } from './run.ts';
import { boxOf, buildModel } from './shapes.ts';

export interface ModelDescribed {
  name: string; w: number; h: number; d: number; looks: string[];
  /** Its animations, with how many seconds each takes. */
  anims: Record<string, number>;
  model: true; shapes: number; triangles: number; bones: string[];
}

export function describeModel(name: string, text: string): ModelDescribed {
  const { model } = readModel(text);
  const built = buildModel(model);
  const { min, max } = boxOf(built);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    name, w: r(max[0] - min[0]), h: r(max[1] - min[1]), d: r(max[2] - min[2]), looks: ['default'],
    anims: Object.fromEntries(Object.entries(model.anims).map(([a, v]) => [a, v.seconds])),
    model: true, shapes: shapesOf(model.parts), triangles: built.triangles, bones: bonesOf(model.parts),
  };
}
