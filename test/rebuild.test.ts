// A project whose page is built (rebuild in its tandem.json): the copy's page is started again when the agent
// changed the copy since it was started, and only then.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.TANDEM_COPY_PORT = String(27000 + (process.pid % 2000));
const { fixture } = await import('./helpers.ts');
const { COPY_PORT } = await import('../core/preview.ts');

const { host, cleanup } = await fixture();
after(() => { host.preview?.stop(); cleanup(); });
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const said = async () => (await fetch(`http://127.0.0.1:${COPY_PORT}/`)).text();
const restarts = () => host.events.since(0).filter((e) => e.type === 'copy.restarted').length;
async function until(what: () => unknown, says: string, ms = 20000) {
  for (const t0 = Date.now(); !what(); await new Promise((r) => setTimeout(r, 100))) if (Date.now() - t0 > ms) throw new Error(`waited too long for ${says}`);
}

test('rebuild is kept in tandem.json, and taken away again', async () => {
  const page = `node -e "const t=String(process.hrtime.bigint());require('http').createServer((q,s)=>s.end(t)).listen({port},'127.0.0.1')"`;
  await me('project.configure', { page, rebuild: true });
  assert.equal(JSON.parse(readFileSync(host.project.configFile, 'utf8')).rebuild, true);
  await me('project.configure', { rebuild: false });
  assert.equal(JSON.parse(readFileSync(host.project.configFile, 'utf8')).rebuild, undefined);
  await me('project.configure', { rebuild: true });
});

test('the copy\'s page is started again when the agent changed the copy since it was started', async () => {
  const copy = host.code!.work;
  host.code!.sync();
  await me('code.play');
  const first = await said();
  // A round with nothing new for the page: it stays.
  host.proposeCode('agent:main', '');
  assert.equal(restarts(), 0);

  writeFileSync(join(copy, 'tide.js'), 'export const TIDE = 1;\n');
  host.proposeCode('agent:main', 'The tide.');
  await until(() => restarts() === 1, 'the copy\'s page to be started again');
  assert.notEqual(await said(), first);

  // Told again about the same copy, it is not started again.
  host.proposeCode('agent:main', 'The tide.');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(restarts(), 1);
  await me('proposals.decide', { accept: false });
});
