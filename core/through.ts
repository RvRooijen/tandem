// A project's page, through tandem. The page is started on an inner port and
// shown from here, on the port it is known at. Everything passes as it is,
// except that a page of HTML gets one line more: tandem's own few lines
// (bridge/page.js), so that things on any page can be pointed at without the
// project knowing of tandem. A page that is not up yet does not answer here
// either: whoever waits for it keeps waiting.
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = '/__tandem/page.js';
const TAG = `<script src="${SCRIPT}"></script>`;
const script = () => readFileSync(fileURLToPath(new URL('../bridge/page.js', import.meta.url)));

/** The inner port a page is started on, for the port it is shown at. */
export const innerPort = (port: number) => port + 2000;

/** One line more in a page of HTML: before the end of its head, or of its body, or after everything. */
export function withTandem(html: string): string {
  if (html.includes(SCRIPT)) return html;
  for (const end of ['</head>', '</body>']) {
    const at = html.toLowerCase().lastIndexOf(end);
    if (at >= 0) return html.slice(0, at) + TAG + html.slice(at);
  }
  return html + TAG;
}

export function startThrough(opts: { port: number; to: number; host?: string }): Promise<Server> {
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    if (req.url === SCRIPT) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(script());
    }
    // Asked for as it is, so that a page of HTML can be read here and given its line.
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    const inner = request({ host, port: opts.to, method: req.method, path: req.url, headers }, (got) => {
      const html = /text\/html/.test(String(got.headers['content-type'] ?? '')) && req.method === 'GET';
      if (!html) {
        res.writeHead(got.statusCode ?? 502, got.headers);
        return void got.pipe(res);
      }
      const parts: Buffer[] = [];
      got.on('data', (d: Buffer) => parts.push(d));
      got.on('end', () => {
        const body = Buffer.from(withTandem(Buffer.concat(parts).toString('utf8')));
        const out = { ...got.headers, 'content-length': String(body.length) };
        delete out['transfer-encoding'];
        delete out['content-encoding'];
        // What the page looked like is not kept by the browser as proof that it has not changed: its length did.
        delete out.etag;
        res.writeHead(got.statusCode ?? 200, out);
        res.end(body);
      });
      got.on('error', () => res.destroy());
    });
    // The page is not up (yet): no answer, like the port itself would give.
    inner.on('error', () => res.destroy());
    req.pipe(inner);
  });

  // What is not a request and an answer (a page's live reload) is passed on as it comes.
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const inner = connect(opts.to, host, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      inner.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) inner.write(head);
      inner.pipe(socket);
      socket.pipe(inner);
    });
    inner.on('error', () => socket.destroy());
    socket.on('error', () => inner.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}
