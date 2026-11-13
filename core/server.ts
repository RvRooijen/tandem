// The core server: the host with HTTP around it. Three things only:
//   GET  /api/commands          every command there is
//   POST /api/run/<name>        run one; the body is its input
//   GET  /api/events?since=n    the event log, then everything as it happens (SSE)
// and the pictures under /api/file/. Who is asking comes in the x-tandem-by
// header (the page sends nothing and is the person).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { CommandError } from './commands.ts';
import { createHost, type Host } from './host.ts';
import { createRunner } from './runner.ts';

export const PORT = Number(process.env.TANDEM_PORT ?? 5201);

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 8e6) { reject(new CommandError('input', 'too much')); req.destroy(); } });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new CommandError('input', 'the body is not JSON')); }
    });
    req.on('error', reject);
  });
}

export async function startServer(opts: { port?: number; host?: Host; agent?: boolean } = {}) {
  const host = opts.host ?? await createHost();
  const runner = opts.agent === false ? undefined : createRunner(host);
  if (runner) host.registry.add(...runner.commands);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/api/commands') return send(res, 200, host.registry.list());

      if (req.method === 'GET' && url.pathname === '/api/info')
        return send(res, 200, { game: host.game.id, name: host.game.name, size: host.game.size, profiles: host.game.profiles, last: host.events.last() });

      if (req.method === 'POST' && url.pathname.startsWith('/api/run/')) {
        const name = url.pathname.slice('/api/run/'.length);
        const by = String(req.headers['x-tandem-by'] ?? 'me');
        const round = req.headers['x-tandem-round'] ? String(req.headers['x-tandem-round']) : undefined;
        try {
          const input = await readBody(req);
          return send(res, 200, { ok: true, result: await host.run(name, input, by, round) ?? null });
        } catch (e) {
          if (e instanceof CommandError) return send(res, e.code === 'missing' || e.code === 'unknown' ? 404 : 400, { ok: false, code: e.code, error: e.message });
          throw e;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const write = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        for (const ev of host.events.since(Number(url.searchParams.get('since') ?? 0))) write(ev);
        if (runner) write({ n: 0, type: 'agent.status', ...runner.status() });
        const off = host.events.subscribe(write);
        const beat = setInterval(() => res.write(': still here\n\n'), 20_000);
        req.on('close', () => { off(); clearInterval(beat); });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/file/looks/')) {
        const file = normalize(join(host.dirs.looks, url.pathname.slice('/api/file/looks/'.length)));
        if (!file.startsWith(host.dirs.looks) || !existsSync(file)) return send(res, 404, { ok: false, error: 'no such picture' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000' });
        return void createReadStream(file).pipe(res);
      }

      send(res, 404, { ok: false, error: 'nothing here; see /api/commands' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { ok: false, code: 'crash', error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? PORT, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, host, runner, port, close: () => new Promise<void>((r) => { runner?.stop(); host.art.workers.stopAll(); server.closeAllConnections(); server.close(() => r()); }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer();
  console.log(`tandem core: ${s.host.game.name} on http://127.0.0.1:${s.port}/api  (${s.host.registry.list().length} commands)`);
}
