// What a drawing worker reports while it works (a round, its critique of a render, the phase it finished) goes
// to the tandem core as an art.note. Outside a worker's run it does nothing; while the core starts (again) it waits
// for it a while, and without one it gives up silently.
const PORT = process.env.TANDEM_PORT ?? 5201;

export async function sendEvent(ev) {
  const worker = process.env.PIXEL_WORKER;
  if (!worker) return;
  // (The core may be starting again, while the worker goes on: what it reports then waits for it, a while.)
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/run/art.note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tandem-by': `agent:${worker}` },
        body: JSON.stringify({ worker, type: String(ev.type ?? ''), name: String(ev.name ?? ''), message: String(ev.message ?? '') }),
        signal: AbortSignal.timeout(1000),
      });
      return;
    } catch (e) {
      if (e?.cause?.code !== 'ECONNREFUSED' || Date.now() > until) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
