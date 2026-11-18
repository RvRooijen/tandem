// The page of the working copy: started when it is asked for, and started
// again when the agent asks, for a page that only takes in its code on a start.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../core/project.ts';

process.env.TANDEM_COPY_PORT = String(25000 + (process.pid % 2000));
const { createPreview, COPY_PORT } = await import('../core/preview.ts');

const dir = mkdtempSync(join(tmpdir(), 'tandem-preview-'));
// A page that says when it was started: started again, it says another time.
const page = (port: number) => `node -e "const t=String(process.hrtime.bigint());require('http').createServer((q,s)=>s.end(t)).listen(${port},'127.0.0.1')"`;
const preview = createPreview(() => ({ root: dir, pageCommand: page } as unknown as Project), join(dir, 'page.log'));
after(() => { preview.stop(); rmSync(dir, { recursive: true, force: true }); });

const said = async () => (await fetch(`http://127.0.0.1:${COPY_PORT}/`)).text();

test('the copy\'s page is started again when asked: a new start, at the same address', async () => {
  const url = await preview.url();
  const first = await said();
  assert.equal(await preview.url(), url, 'asked again, it is the page that runs');
  assert.equal(await said(), first);
  assert.equal(await preview.restart(), url);
  assert.notEqual(await said(), first, 'it was started again');
});
