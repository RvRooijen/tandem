// A page that tandem started does not outlive tandem, however tandem ends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';
import { startTree, stopTree } from '../core/project.ts';

// A page is up while something answers on its port: that is what is in the way when it is left running.
const freePort = () => new Promise<number>((got) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => got(port)); }); });
const answers = (port: number) => new Promise<boolean>((said) => { const c = connect(port, '127.0.0.1', () => { c.destroy(); said(true); }); c.on('error', () => said(false)); });
const until = async (port: number, up: boolean) => { for (let i = 0; i < 50 && (await answers(port)) !== up; i++) await new Promise((r) => setTimeout(r, 100)); return (await answers(port)) === up; };
// (A shell line whose real work is a child of the shell, as a page command's is.)
const page = (port: number) => `node -e "require('http').createServer((q, s) => s.end()).listen(${port}, '127.0.0.1')" & wait`;

test('a started page is stopped with what it started', async () => {
  const port = await freePort();
  const proc = startTree(page(port), { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] });
  assert.ok(await until(port, true), 'the page is up');
  stopTree(proc);
  assert.ok(await until(port, false), 'nothing of it is left');
});

test('a started page ends when the one that started it is killed, without a chance to stop it', async () => {
  // Another process starts the page; then it is killed outright.
  const port = await freePort();
  const project = new URL('../core/project.ts', import.meta.url).href;
  const starter = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { startTree } from ${JSON.stringify(project)}; startTree(${JSON.stringify(page(port))}, { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] }); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  assert.ok(await until(port, true), 'the page is up');
  starter.kill('SIGKILL');
  assert.ok(await until(port, false), 'the page went with it');
});
