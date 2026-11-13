// What the engine needs from a game. A game is content, rules and commands;
// nothing of the loop is in it. The same module runs in the page (the person
// playing), on the server (the world the agent looks into) and in a job (a
// playtest, a picture), which is why everything here is plain data in and out.
import type { EntityManager } from 'archetype-ecs';
import type { CommandDef } from './commands.ts';

/** A running game: an ECS world and the rules that step it. */
export interface World {
  em: EntityManager;
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

/** How a page is to start a game. */
export interface MountOptions {
  /** Start from this world instead of the page's own save: the working copy is played where the person is. */
  saved?: unknown;
  /** Keep nothing of this session: it is a try-out, the person's own save is not to be touched. */
  scratch?: boolean;
}

/** A game running in a page, as the shell sees it. Every game has a page.ts whose mount(root, options) gives one. */
export interface GamePage {
  world: World;
  /** While set, a finger on the stage is handed here (in world units) instead of to the game. */
  intercept: ((x: number, y: number) => void) | null;
  /** Where a point of the world is on the screen, in CSS pixels. */
  toScreen(x: number, y: number): { x: number; y: number };
  /** The content was changed under the running game: work out again what follows from it. */
  contentChanged(): void;
  save(): void;
}
