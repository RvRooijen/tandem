// Tandem's page as a release has it: the built files, and what goes on to the core.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveBuilt } from '../core/built.ts';

const base = mkdtempSync(join(tmpdir(), 'tandem-built-'));
const dir = join(base, 'dist');
mkdirSync(join(dir, 'assets'), { recursive: true });
writeFileSync(join(dir, 'index.html'), '<p>tandem</p>');
writeFileSync(join(dir, 'assets', 'index-abc.js'), 'export {}');
writeFileSync(join(base, 'secret.txt'), 'not the page\'s');

const listen = (s: Server) => new Promise<number>((up) => s.listen(0, '127.0.0.1', () => up((s.address() as { port: number }).port)));
const core = createServer((req, res) => res.end(`core: ${req.method} ${req.url}`));
const status = createServer((_req, res) => res.end('{"doing":"starting"}'));
const corePort = await listen(core), statusPort = await listen(status);
const page = serveBuilt({ dir, port: 0, core: corePort, status: statusPort });
await new Promise((up) => page.once('listening', up));
const at = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
after(() => { page.close(); core.close(); status.close(); rmSync(base, { recursive: true, force: true }); });

test('the built page is served, and whatever is not one of its files is the page itself', async () => {
  const index = await fetch(`${at}/`);
  assert.equal(await index.text(), '<p>tandem</p>');
  assert.match(index.headers.get('content-type')!, /text\/html/);
  const js = await fetch(`${at}/assets/index-abc.js`);
  assert.equal(await js.text(), 'export {}');
  assert.match(js.headers.get('cache-control')!, /immutable/);
  assert.equal(await (await fetch(`${at}/somewhere/else`)).text(), '<p>tandem</p>');
  assert.equal(await (await fetch(`${at}/..%2Fsecret.txt`)).text(), '<p>tandem</p>', 'nothing outside it');
});

test('/api/ goes to the core and /starting to what says it is starting, as Vite\'s server sends them', async () => {
  assert.equal(await (await fetch(`${at}/api/run?x=1`, { method: 'POST', body: '{}' })).text(), 'core: POST /api/run?x=1');
  assert.equal(await (await fetch(`${at}/starting`)).text(), '{"doing":"starting"}');
});
