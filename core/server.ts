// The core server: the host with HTTP around it. Three things only:
//   GET  /api/commands          every command there is
//   POST /api/run/<name>        run one; the body is its input
//   GET  /api/events?since=n    the event log, then everything as it happens (SSE)
// and the pictures under /api/file/, and the views under /api/view/. Who is
// asking comes in the x-tandem-by header (the page sends nothing and is the
// person). A command is only run when it is said to be JSON: a page in a frame
// (a view the agent made, the project's own) cannot send that to another
// address without the browser asking here first, and nothing here says yes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { CommandError } from './commands.ts';
import { within } from './paths.ts';
import { createHost, type Host } from './host.ts';
import { depCommands } from './deps.ts';
import { modelCommands } from './models.ts';
import { SWITCH, projectCommands, readState, welcome } from './projects.ts';
import { createRegistry } from './commands.ts';
import { createRunner } from './runner.ts';

export const PORT = Number(process.env.TANDEM_PORT ?? 5201);
/** Where the project's own page runs (started by start.ts). */
export const PAGE_PORT = Number(process.env.TANDEM_PAGE_PORT ?? 5210);

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    // Room for a photo from a phone, sent along as text.
    req.on('data', (d) => { raw += d; if (raw.length > 60e6) { reject(new CommandError('input', 'that is too much at once (about 40 MB is the most a file can be)')); req.destroy(); } });
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
  // Whoever stops the core stops what it started: the agent and the workers are its children.
  host.onStop.push(() => runner?.stop(), () => host.art.workers.stopAll());
  host.busy.why = () => (runner?.status().busy ? 'the agent is in the middle of something here; stop it or let it finish first' : host.art.workers.list().some((w) => w.state === 'running') ? 'a worker is drawing here; stop it or let it finish first' : undefined);
  // Another project is opened from the page: the core ends, and whoever looks after it starts it on that one.
  host.registry.add(...modelCommands(), ...depCommands(), ...projectCommands({
    current: host.project.root,
    busy: () => host.busy.why?.(),
    restart: process.env.TANDEM_SUPERVISED ? () => { for (const stop of host.onStop) stop(); process.exit(SWITCH); } : undefined,
  }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/api/commands') return send(res, 200, host.registry.list());

      if (req.method === 'GET' && url.pathname === '/api/info')
        return send(res, 200, {
          project: host.project.id, name: host.project.name, last: host.events.last(),
          // Where the project's own page is, and what the project offers: the shell is built from this.
          root: host.project.root,
          page: host.project.pageCommand(0) ? `http://localhost:${PAGE_PORT}/` : null,
          senses: !!host.game, copy: !!host.code,
        });

      if (req.method === 'POST' && url.pathname.startsWith('/api/run/')) {
        if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, { ok: false, code: 'input', error: 'a command is sent as JSON (content-type: application/json)' });
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
        // Said as an event, so the page hears it: a stream that goes silent is opened again there.
        const beat = setInterval(() => write({ n: 0, type: 'beat' }), 4000);
        req.on('close', () => { off(); clearInterval(beat); });
        return;
      }

      // A view's page, for its frame on the stage: in a sandbox of its own, whoever made it.
      if (req.method === 'GET' && url.pathname.startsWith('/api/view/')) {
        const html = host.views.page(decodeURIComponent(url.pathname.slice('/api/view/'.length)), url.searchParams.get('copy') === '1');
        if (html === undefined) return send(res, 404, { ok: false, error: 'there is no such view' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups' });
        return void res.end(html);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/file/looks/')) {
        const file = normalize(join(host.dirs.looks, url.pathname.slice('/api/file/looks/'.length)));
        if (!within(host.dirs.looks, file) || !existsSync(file)) return send(res, 404, { ok: false, error: 'no such picture' });
        const kind = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[file.split('.').pop()!.toLowerCase()] ?? 'image/png';
        res.writeHead(200, { 'content-type': kind, 'cache-control': 'max-age=31536000' });
        return void createReadStream(file).pipe(res);
      }

      // What was shared in the chat: shown in the page as it is.
      if (req.method === 'GET' && url.pathname.startsWith('/api/file/files/')) {
        const file = normalize(join(host.dirs.files, decodeURIComponent(url.pathname.slice('/api/file/files/'.length))));
        if (!within(host.dirs.files, file) || !existsSync(file)) return send(res, 404, { ok: false, error: 'no such file' });
        const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
        const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'text/plain', txt: 'text/plain', md: 'text/plain', json: 'application/json', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=31536000', 'x-content-type-options': 'nosniff' });
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
  return { server, host, runner, port, close: () => new Promise<void>((r) => { runner?.stop(); host.art.workers.stopAll(); for (const stop of host.onStop) stop(); server.closeAllConnections(); server.close(() => r()); }) };
}

/**
 * The core with no project open: only what it takes to choose one. The page shows the list; opening one starts
 * the core again, on it.
 */
export async function startLobby(opts: { port?: number } = {}) {
  const registry = createRegistry();
  registry.add(...modelCommands(), ...depCommands(), ...projectCommands({ restart: process.env.TANDEM_SUPERVISED ? () => process.exit(SWITCH) : undefined }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/api/commands') return send(res, 200, registry.list());
      if (req.method === 'GET' && url.pathname === '/api/info') return send(res, 200, { project: null, name: 'tandem', last: 0, page: null, senses: false, copy: false });
      if (req.method === 'POST' && url.pathname.startsWith('/api/run/')) {
        if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, { ok: false, code: 'input', error: 'a command is sent as JSON (content-type: application/json)' });
        try {
          return send(res, 200, { ok: true, result: await registry.run(url.pathname.slice('/api/run/'.length), await readBody(req), { by: String(req.headers['x-tandem-by'] ?? 'me') }) ?? null });
        } catch (e) {
          if (e instanceof CommandError) return send(res, e.code === 'missing' || e.code === 'unknown' ? 404 : 400, { ok: false, code: e.code, error: e.message });
          throw e;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const beat = setInterval(() => res.write('data: {"n":0,"type":"beat"}\n\n'), 4000);
        req.on('close', () => clearInterval(beat));
        return void res.write(': no project is open\n\n');
      }
      send(res, 404, { ok: false, error: 'no project is open; see projects.list' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { ok: false, code: 'crash', error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? PORT, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  // Started by start.ts, the core tells it what it is doing until it answers itself: the page shows that meanwhile.
  const tell = (m: { doing: string } | { up: true }) => { if (process.connected) process.send?.(m); };
  // The project is the one named when starting, or the one that was open last; without either, the page chooses.
  const dir = process.env.TANDEM_PROJECT || readState().project;
  if (!dir || !existsSync(dir)) {
    const lobby = await startLobby();
    tell({ up: true });
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
    console.log(`tandem core: no project open; choose one in the page (http://127.0.0.1:${lobby.port}/api)`);
    await new Promise(() => {});
  }
  const host = await createHost({ project: dir, doing: (doing) => tell({ doing }) });
  tell({ doing: 'starting the agent' });
  const s = await startServer({ host });
  tell({ up: true });
  // A project tandem has not been in before: its chat opens with a first line.
  welcome(s.host);
  // Stopped from outside: what the core started stops with it.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void s.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
  console.log(`tandem core: ${s.host.project.name} (${s.host.project.root}) on http://127.0.0.1:${s.port}/api  (${s.host.registry.list().length} commands${s.host.game ? ', with an adapter' : ''}${s.host.code ? ', working copy' : ''})`);
}
