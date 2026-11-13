// The one way out of the page. Every button the shell has ends in run(): a
// command by name with an input, the same call the agent makes from its command
// line. Nothing else in the shell talks to the core.
import { CommandError } from '../core/commands.ts';
import type { Event } from '../core/events.ts';

export async function run<T = any>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/run/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const out = await res.json();
  if (!out.ok) throw new CommandError(out.code ?? 'error', out.error ?? 'it did not work');
  return out.result as T;
}

/** What the core says about the project it runs on. */
export interface Info {
  project: string;
  name: string;
  last: number;
  /** Where the project's own page is; null when it has none set up. */
  page: string | null;
  /** Whether the project lets the engine see inside it, and whether the agent has a working copy. */
  senses: boolean;
  copy: boolean;
}

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
