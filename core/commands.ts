// The command registry: the only door. Everything that can be done is a named
// command with typed input, and the page, the agent, the bot and the tests all
// call the same ones. What differs is who is asking, never what can be asked.

/** read returns data; look returns a picture and a text form of the same thing; write changes something. */
export type Kind = 'read' | 'look' | 'write';

/** Who is asking: 'me' (the person), 'agent:<worker>', 'bot' or 'test'. */
export type By = string;

export interface Ctx {
  by: By;
  /** The round of agent work this call belongs to: the turn in which the agent answers one message. */
  round?: string;
  /** Whatever the host of the registry provides: stores, worlds, the event log. */
  [service: string]: unknown;
}

export interface CommandDef<I = any, O = any> {
  name: string;
  /** One line, in plain words: this is what the agent reads to know what the command is for. */
  about: string;
  kind: Kind;
  /** Field name -> type: string, number, boolean or json; a trailing ? makes it optional. */
  input?: Record<string, string>;
  /**
   * What an agent's write does. Unset: refused (only the person may). 'free': it just runs, because it cannot
   * touch the real project (playing in a sandbox, starting a playtest; the one exception is art.accept, a drawing
   * worker's drawing, which is the agent's to judge). 'proposes': the command itself turns an agent's call into a proposal.
   */
  agent?: 'free' | 'proposes';
  run(ctx: Ctx, input: I): O | Promise<O>;
}

export class CommandError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export const isAgent = (by: By) => by.startsWith('agent');

function check(def: CommandDef, input: Record<string, unknown>) {
  const spec = def.input ?? {};
  for (const key in spec) {
    const optional = spec[key].endsWith('?');
    const type = spec[key].replace('?', '');
    const v = input[key];
    if (v === undefined || v === null) {
      if (!optional) throw new CommandError('input', `${def.name} needs ${key} (${type})`);
      continue;
    }
    if (type !== 'json' && typeof v !== type) throw new CommandError('input', `${def.name}: ${key} must be a ${type}, got ${typeof v}`);
  }
  for (const key in input) if (!(key in spec)) throw new CommandError('input', `${def.name} has no input called ${key}; it takes: ${Object.keys(spec).join(', ') || 'nothing'}`);
}

export interface Registry {
  add(...defs: CommandDef[]): void;
  get(name: string): CommandDef | undefined;
  /** Every command, for the list the UI is built from and the agent is told about. */
  list(): { name: string; about: string; kind: Kind; input: Record<string, string>; agent: string }[];
  run(name: string, input: Record<string, unknown> | undefined, ctx: Ctx): Promise<unknown>;
  /** Resolves when no command is running: at once when none is. For what must not happen in the middle of one. */
  idle(): Promise<void>;
  /** How many commands are running now. */
  running(): number;
  /** Called after every run, for the event log. */
  onRun?: (name: string, input: Record<string, unknown>, ctx: Ctx, ok: boolean) => void;
}

export function createRegistry(): Registry {
  const defs = new Map<string, CommandDef>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const reg: Registry = {
    add(...list) {
      for (const def of list) {
        if (defs.has(def.name)) throw new Error(`command ${def.name} is registered twice`);
        if (!/^[a-z]+(\.[a-zA-Z]+)+$/.test(def.name)) throw new Error(`a command is named part.verb, not "${def.name}"`);
        if (!def.about) throw new Error(`command ${def.name} has no about line`);
        defs.set(def.name, def);
      }
    },
    get: (name) => defs.get(name),
    running: () => running,
    idle: () => (running ? new Promise((done) => { waiting.push(done); }) : Promise.resolve()),
    list: () => [...defs.values()].map((d) => ({
      name: d.name, about: d.about, kind: d.kind, input: d.input ?? {},
      agent: d.kind !== 'write' ? 'yes' : d.agent === 'free' ? 'yes' : d.agent === 'proposes' ? 'as a proposal' : 'no',
    })),
    async run(name, input = {}, ctx) {
      const def = defs.get(name);
      if (!def) throw new CommandError('unknown', `there is no command called ${name}`);
      check(def, input);
      if (def.kind === 'write' && isAgent(ctx.by) && !def.agent)
        throw new CommandError('permission', `${name} is the person's to do, not the agent's`);
      let ok = false;
      running++;
      try {
        const out = await def.run(ctx, input);
        ok = true;
        return out;
      } finally {
        if (!--running) for (const done of waiting.splice(0)) done();
        reg.onRun?.(name, input, ctx, ok);
      }
    },
  };
  return reg;
}
