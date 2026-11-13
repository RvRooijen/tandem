// The few lines that let a page talk to tandem when it is shown inside it.
// Copy this file into a project and call the two functions from its page; it
// has no imports. A page opened on its own (not in tandem's frame) is not
// touched by it. A project that does not use it still shows in tandem; with
// it, tandem's agent can read the world being played, the person can try the
// agent's working copy from where they are, and things can be pointed at.

export interface TandemPage {
  /** The world as data, enough to start it again somewhere else. */
  snapshot?(): unknown;
  /** Where a point of the world is on this page, in CSS pixels. */
  toScreen?(x: number, y: number): { x: number; y: number };
}

const KEY = 'tandem-load';
const inside = typeof window !== 'undefined' && window.parent !== window;

/**
 * Call before the page starts its world. When tandem asked this page to start from a world (the working copy is
 * played where the person is), that world is `saved`, and `scratch` says nothing of this session is to be kept:
 * the page should not write over its own save.
 */
export function tandemStart(): { saved?: unknown; scratch: boolean } {
  if (!inside) return { scratch: false };
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw !== null) return { saved: JSON.parse(raw), scratch: true };
  } catch { /* no storage: start as usual */ }
  return { scratch: false };
}

/** Call once the page is running. */
export function tandemConnect(page: TandemPage) {
  if (!inside) return;
  const say = (msg: Record<string, unknown>) => window.parent.postMessage({ tandem: 1, ...msg }, '*');
  window.addEventListener('message', (ev) => {
    const m = ev.data as { tandem?: number; type?: string; id?: number; x?: number; y?: number; snapshot?: unknown } | null;
    if (!m || m.tandem !== 1 || ev.source !== window.parent) return;
    if (m.type === 'where' && page.toScreen) say({ type: 'screen', id: m.id, ...page.toScreen(Number(m.x), Number(m.y)) });
    else if (m.type === 'snapshot?' && page.snapshot) say({ type: 'snapshot', snapshot: page.snapshot() });
    else if (m.type === 'load') { sessionStorage.setItem(KEY, JSON.stringify(m.snapshot ?? null)); location.reload(); }
    else if (m.type === 'unload') { sessionStorage.removeItem(KEY); location.reload(); }
  });
  let loaded = false;
  try { loaded = sessionStorage.getItem(KEY) !== null; } catch { /* no storage */ }
  say({ type: 'hello', loaded, can: { snapshot: !!page.snapshot, point: !!page.toScreen } });
  if (page.snapshot) {
    const share = () => say({ type: 'snapshot', snapshot: page.snapshot!() });
    share();
    setInterval(share, 5000);
  }
}
