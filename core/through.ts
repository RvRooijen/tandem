// A project's page, through tandem. The page is started on an inner port and
// shown from here, on the port it is known at. Everything passes as it is,
// except that a page of HTML gets one line more: tandem's own few lines
// (bridge/scene.js and bridge/page.js), so that things on any page, and in a
// scene three.js draws on it, can be pointed at without the project knowing of
// tandem. A page that says it may not be shown in another
// page's frame (X-Frame-Options, frame-ancestors) loses that on the way: a
// frame is where tandem shows it. A page that is not up yet does not answer
// here either: whoever waits for it keeps waiting.
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = '/__tandem/page.js';
const TAG = `<script src="${SCRIPT}"></script>`;
// (The lines for a scene of three.js go first: they have to be there before the page's own code makes its renderer.)
const script = () => Buffer.concat(['scene.js', 'page.js'].map((name) => readFileSync(fileURLToPath(new URL(`../bridge/${name}`, import.meta.url)))));

/**
 * The inner port a page is started on, for the port it is shown at. The project's page and the working copy's are
 * a hundred ports apart: a page that needs more than one port (a server beside it, a database) counts up from its
 * own, and the two must never meet.
 */
export const innerPort = (port: number, copy = false) => port + 2000 + (copy ? 99 : 0);

/** The headers of an answer, without what forbids showing it in a frame; the rest of its content security policy stays. */
export function framable<T extends Record<string, string | string[] | undefined>>(headers: T): T {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  delete out['x-frame-options'];
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    const policies = ([] as string[]).concat(out[name] ?? [])
      .map((policy) => policy.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d)).join('; '))
      .filter(Boolean);
    if (policies.length) out[name] = policies; else delete out[name];
  }
  return out as T;
}

/** One line more in a page of HTML: before the end of its head, or of its body, or after everything. */
export function withTandem(html: string): string {
  if (html.includes(SCRIPT)) return html;
  for (const end of ['</head>', '</body>']) {
    const at = html.toLowerCase().lastIndexOf(end);
    if (at >= 0) return html.slice(0, at) + TAG + html.slice(at);
  }
  return html + TAG;
}

/** Whether what a page opens beside its requests is how it hears that its files changed (Vite's, or one of the others that load a page anew). */
export const liveReload = (url: string | undefined, protocol: string | string[] | undefined) =>
  /^vite/.test(String(protocol ?? '')) || /hmr|live-?reload|browser-sync|sockjs-node|webpack/i.test(url ?? '');

/**
 * `live` is called when the page turns out to follow its own files: it loads itself anew when one changes. With
 * `fresh` nothing of the page is kept by the browser: the working copy's code changes under a server that may still
 * hand out what it had when it started (an ETag from its build), and the browser would keep the old file for that.
 */
export function startThrough(opts: { port: number; to: number; host?: string; live?: () => void; fresh?: boolean }): Promise<Server> {
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    if (req.url === SCRIPT) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(script());
    }
    // Asked for as it is, so that a page of HTML can be read here and given its line.
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    if (opts.fresh) for (const name of ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range']) delete headers[name];
    const fresh = <T extends Record<string, string | string[] | undefined>>(out: T): T => {
      if (!opts.fresh) return out;
      const copy: Record<string, string | string[] | undefined> = { ...out, 'cache-control': 'no-store' };
      delete copy.etag;
      delete copy['last-modified'];
      delete copy.expires;
      return copy as T;
    };
    const inner = request({ host, port: opts.to, method: req.method, path: req.url, headers }, (got) => {
      const html = /text\/html/.test(String(got.headers['content-type'] ?? '')) && req.method === 'GET';
      if (!html) {
        res.writeHead(got.statusCode ?? 502, fresh(framable(got.headers)));
        return void got.pipe(res);
      }
      const parts: Buffer[] = [];
      got.on('data', (d: Buffer) => parts.push(d));
      got.on('end', () => {
        const body = Buffer.from(withTandem(Buffer.concat(parts).toString('utf8')));
        const out = { ...fresh(framable(got.headers)), 'content-length': String(body.length) };
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
    if (liveReload(req.url, req.headers['sec-websocket-protocol'])) opts.live?.();
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
