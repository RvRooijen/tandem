// What a drawing worker reports while it works (a round, its critique of a render, the phase it finished) goes
// to the tandem core as an art.note. Outside a worker's run, or without a core, it silently does nothing.
const PORT = process.env.TANDEM_PORT ?? 5201;

export async function sendEvent(ev) {
  const worker = process.env.PIXEL_WORKER;
  if (!worker) return;
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/run/art.note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tandem-by': `agent:${worker}` },
      body: JSON.stringify({ worker, type: String(ev.type ?? ''), name: String(ev.name ?? ''), message: String(ev.message ?? '') }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {}
}
