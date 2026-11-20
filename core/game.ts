// What a project's adapter gives the engine so it can see inside the project:
// make a world, step it, draw it, let a bot play it. The adapter runs in the
// core (the world the agent looks into) and in a job (a playtest, a picture),
// never in the page, which is why everything here is plain data in and out.
import type { CommandDef } from './commands.ts';

/** What the inspector asks of a world's entities: the project's own ECS (archetype-ecs's EntityManager). */
export interface Entities {
  isAlive(id: number): boolean;
  getAllEntities(): number[];
  hasComponent(id: number, def: unknown): boolean;
  getComponent(id: number, def: unknown): unknown;
  replaceComponent(id: number, def: unknown, row: unknown): void;
}

/**
 * What the inspector asks of the ECS the project runs on, which only the project has: archetype-ecs's
 * componentSchemas, profiler and queryDiagnostics, as the adapter imports them.
 */
export interface EcsModule {
  componentSchemas: { get(key: symbol): Record<string, unknown> | undefined };
  profiler: { readonly enabled: boolean; setEnabled(on: boolean): void; getData(): Map<string, { avg: number; rows?: number }> };
  queryDiagnostics: {
    reports: { query: string; mode: string; kernelOps: number; wasm: boolean; demoted: boolean; statements: { source: string; compiled: boolean; hint?: string }[] }[];
  };
}

/** A running game: an ECS world and the rules that step it. */
export interface World {
  em: Entities;
  step(dt: number): void;
  /** Everything needed to start this world again somewhere else. Plain JSON. */
  snapshot(): unknown;
  /** The state in a few lines of words and numbers: what the agent reads instead of looking at the screen. */
  describe(): string;
  /** The game's own object, for its own commands. */
  game: unknown;
  /** The systems of the pipeline, in the order they run. */
  systems: string[];
}

/** A picture as the engine keeps it: 0xAABBGGRR per pixel. */
export interface Picture { w: number; h: number; px: Uint32Array }

/** When things happened in a played game, in seconds after the start. */
export interface RunLog {
  profile: string;
  owners: { at: Record<string, number>; length?: number; hats?: number; jobs?: number }[];
  seconds: number;
}

export interface GameModule {
  id: string;
  name: string;
  /** Every component by name, so the inspector can say what an entity is made of. */
  components: Record<string, unknown>;
  /** The ECS it runs on, for the fields of the components and how the systems compiled and what they cost. */
  ecs?: EcsModule;
  /** Which component says where an entity is, so a point on the stage can be turned into the entities near it. */
  position?: { component: string; x: string; y: string };
  /** The size of the world in its own units, and how many picture pixels one unit is. */
  size: { w: number; h: number; zoom: number };
  createWorld(saved?: unknown, opts?: { seed?: number }): World;
  /** Draw a world. `time` is the animation clock in seconds. */
  render(world: World, opts?: { w?: number; h?: number; time?: number }): Picture;
  /** The milestones a playthrough can report, with a few words each. */
  milestones(): { id: string; about: string }[];
  /** Let a rule-driven player play. profile is one of `profiles`. */
  playthrough(world: World, profile: string, opts: { owners?: number; maxHours?: number; seed?: number; untilSeconds?: number }): RunLog;
  profiles: string[];
  /** The game's own commands: what a player can do, and whatever else it wants to offer. */
  commands(world: (room?: string) => World): CommandDef[];
}
