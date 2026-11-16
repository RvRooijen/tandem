// A page that tandem started does not outlive tandem, however tandem ends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { startTree, stopTree } from '../core/project.ts';

const alive = (group: number) => { try { process.kill(-group, 0); return true; } catch { return false; } };
const gone = async (group: number) => { for (let i = 0; i < 40 && alive(group); i++) await new Promise((r) => setTimeout(r, 100)); return !alive(group); };

test('a started page is stopped as a group, with what it started', async () => {
  // (A shell line whose real work is a grandchild, as a page command's is.)
  const page = startTree('sh -c "sleep 30" & wait', { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(alive(page.pid!));
  stopTree(page);
  assert.ok(await gone(page.pid!), 'nothing of it is left');
});

test('a started page ends when the one that started it is killed, without a chance to stop it', async () => {
  // Another process starts the page and says which group it is; then it is killed outright.
  const project = new URL('../core/project.ts', import.meta.url).href;
  const starter = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { startTree } from ${JSON.stringify(project)}; const page = startTree('sh -c "sleep 30" & wait', { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] }); console.log(page.pid); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const group = Number(await new Promise<string>((said) => starter.stdout.once('data', (d) => said(String(d)))));
  assert.ok(group > 0 && alive(group), 'the page is up');
  starter.kill('SIGKILL');
  assert.ok(await gone(group), 'the page went with it');
});
