// The page as the dev server really serves it: every module the browser would
// ask for has to come back as a module. jsdom never asks the server for one, so
// this is the only place a clash between a file and a proxied path shows up.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { startServer } from '../core/server.ts';
import { ROOT } from '../core/host.ts';
import { fixture } from './helpers.ts';

const { host, cleanup } = await fixture({ code: false });
const core = await startServer({ port: 0, host, agent: false });
process.env.TANDEM_PORT = String(core.port);
const vite = await createServer({ root: `${ROOT}shell`, configFile: `${ROOT}vite.config.ts`, server: { port: 0, strictPort: false, watch: null }, logLevel: 'silent' });
await vite.listen();
const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
after(async () => { await vite.close(); await core.close(); cleanup(); });

test('every module of the page is served as a module, and /api/ reaches the core', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<div id="tandem">/);
  const seen = new Set<string>(), queue = ['/main.ts'];
  while (queue.length) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const res = await fetch(base + u);
    const text = await res.text();
    assert.equal(res.status, 200, `${u} is served`);
    assert.match(res.headers.get('content-type') ?? '', /javascript/, `${u} comes back as a module, not as ${text.slice(0, 80)}`);
    for (const m of text.matchAll(/(?:from|import)\s*\(?["'](\/[^"']+)["']/g)) queue.push(m[1]);
  }
  for (const name of ['/api.ts', '/boot.ts', '/app.ts', '/panels/chat.ts', '/panels/art.ts', '/artview.ts'])
    assert.ok(seen.has(name), `${name} is part of the page`);
  assert.ok(seen.has('/stage.ts'), 'the frame for the project\'s page is part of it');
  assert.ok(![...seen].some((u) => /archetype-ecs|\/games\//.test(u)), 'and nothing of any project is: a project\'s page is its own, in the frame');
  assert.ok(seen.size > 10);

  const info = await (await fetch(`${base}/api/info`)).json() as { project: string };
  assert.equal(info.project, 'fixture');
  const run = await (await fetch(`${base}/api/run/art.get`, { method: 'POST', body: '{"name":"gnome"}' })).json() as { ok: boolean };
  assert.equal(run.ok, true);
});
