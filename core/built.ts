// Tandem's page as a release has it: built beforehand (npm run build, in dist/), so that where tandem is installed
// nothing has to be built and Vite is not needed. This serves those files, and sends on what Vite's server would
// (vite.config.ts): /api/ to the core, /starting to what says the core is starting.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { within } from './paths.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

export function serveBuilt(o: { dir: string; port: number; core: number; status: number }): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const to = path.startsWith('/api/') ? o.core : path.startsWith('/starting') ? o.status : 0;
    if (to) {
      const out = request({ host: '127.0.0.1', port: to, method: req.method, path: req.url, headers: req.headers }, (from) => {
        res.writeHead(from.statusCode ?? 502, from.headers);
        from.pipe(res);
        // When the core goes away in the middle of an answer (the event stream, when it starts again), the answer
        // ends here too; otherwise the page goes on listening to nothing.
        from.on('close', () => { if (!from.complete && !res.writableEnded) res.destroy(); });
      });
      out.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
      res.on('close', () => out.destroy());
      req.pipe(out);
      return;
    }
    let file: string | undefined;
    try { file = resolve(o.dir, `.${decodeURIComponent(path)}`); } catch { /* not a path */ }
    // What is not a file of the page is the page itself.
    if (!file || !within(o.dir, file) || !existsSync(file) || !statSync(file).isFile()) file = join(o.dir, 'index.html');
    // (What is in assets/ has its hash in its name; index.html is asked for anew.)
    const fixed = within(o.dir, file)?.startsWith('assets/');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': fixed ? 'max-age=31536000, immutable' : 'no-cache' });
    createReadStream(file).pipe(res);
  });
  server.listen(o.port, '127.0.0.1');
  return server;
}
