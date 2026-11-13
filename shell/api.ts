// The one way out of the page. Every button the shell has ends in run(): a
// command by name with an input, the same call the agent makes from its command
// line. Commands about the world being played (the game's own, the inspector's)
// are answered here in the page, where that world lives; everything else goes
// to the core server. Nothing else in the shell talks to the network.
import { CommandError, createRegistry, type CommandDef } from '../core/commands.ts';
import type { Event } from '../core/events.ts';

const local = createRegistry();

/** Commands that run in the page, on the world being played. */
export function addLocal(...defs: CommandDef[]) {
  local.add(...defs);
}

export const isLocal = (name: string) => !!local.get(name);

export async function run<T = any>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  // A room names a world on the host; without one it is the world in this page.
  if (local.get(name) && input.room === undefined) return await local.run(name, input, { by: 'me' }) as T;
  const res = await fetch(`/api/run/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const out = await res.json();
  if (!out.ok) throw new CommandError(out.code ?? 'error', out.error ?? 'it did not work');
  return out.result as T;
}

export interface Info { game: string; name: string; size: { w: number; h: number; zoom: number }; profiles: string[]; last: number }

export async function info(): Promise<Info> {
  return (await fetch('/api/info')).json();
}

/** Follow the event log: what is already in it from `since` on, then everything as it happens. */
export function follow(since: number, on: (ev: Event) => void, state?: (live: boolean) => void): () => void {
  let last = since, source: EventSource | undefined, closed = false;
  const open = () => {
    source = new EventSource(`/api/events?since=${last}`);
    source.onopen = () => state?.(true);
    source.onmessage = (m) => {
      const ev = JSON.parse(m.data) as Event;
      if (ev.n > 0) { if (ev.n <= last) return; last = ev.n; }
      on(ev);
    };
    source.onerror = () => {
      state?.(false);
      source?.close();
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();
  return () => { closed = true; source?.close(); };
}
