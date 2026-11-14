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
  /** The project that is open; null when none is, and the page is there to choose one. */
  project: string | null;
  /** Its folder. */
  root?: string;
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

/** What is being started while the core cannot answer: which project, and what is being done for it. */
export interface Starting { name: string; root: string; doing: string; seconds: number }

/** What tandem is doing while the core is away; null when nobody says (tandem itself is not running). */
export async function starting(): Promise<Starting | null> {
  try {
    const res = await fetch('/starting', { cache: 'no-store' });
    return res.ok ? await res.json() as Starting : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the core to answer (on `root`, when another project is being opened), however long that takes: a
 * project on a slow disk can take a minute. What is being done meanwhile is told to `says`, in words.
 */
export async function coreUp(says: (text: string, running: boolean) => void, root?: string, every = 600): Promise<Info> {
  for (;;) {
    try {
      const got = await info();
      if (root === undefined || got.root === root) return got;
    } catch { /* not there yet */ }
    const now = await starting();
    const took = now && now.seconds >= 5 ? ` (${now.seconds} s)` : '';
    says(now?.doing ? `${now.name ? `Opening ${now.name}: ` : ''}${now.doing}${took}` : now ? `Almost there${took}` : '', now !== null);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** Does a page at another address answer yet? (A project's own page takes a moment to start.) */
export async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
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
