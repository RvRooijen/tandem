// Choosing a project: the folders that could be one, opening one, and the core
// with no project open at all.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError, createRegistry } from '../core/commands.ts';
import { listProjects, projectCommands, readState } from '../core/projects.ts';
import { startLobby } from '../core/server.ts';
import './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'tandem-pj-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.TANDEM_PROJECTS = root;
mkdirSync(join(root, 'garden/.git'), { recursive: true });
mkdirSync(join(root, 'garden/.tandem'));
writeFileSync(join(root, 'garden/tandem.json'), JSON.stringify({ name: 'Gnome Garden', page: 'vite --port {port}', adapter: 'tandem.adapter.ts' }));
mkdirSync(join(root, 'website/.git'), { recursive: true });
writeFileSync(join(root, 'website/package.json'), JSON.stringify({ devDependencies: { vite: '^6' } }));
mkdirSync(join(root, 'notes'));
mkdirSync(join(root, '.hidden/.git'), { recursive: true });
writeFileSync(join(root, 'a-file.txt'), 'x');
const mine = <T extends { dir: string }>(list: T[]) => list.filter((p) => p.dir.startsWith(root));

test('the folders that could be a project: what tandem knows first, then repositories, then the rest', () => {
  const list = mine(listProjects(join(root, 'website')));
  assert.deepEqual(list.map((p) => [p.name, p.open, p.git, p.known, p.page, p.adapter]), [
    ['website', true, true, false, true, false],          // open; a Vite project has a page without saying so
    ['Gnome Garden', false, true, true, true, true],      // tandem has been here; named by its tandem.json
    ['notes', false, false, false, false, false],         // a folder, not a repository
  ], 'hidden folders and files are not projects');
});

test('opening a project: a repository, when nothing is in the way; then the core is started again on it', async () => {
  let restarted = 0, busy: string | undefined;
  const registry = createRegistry();
  registry.add(...projectCommands({ current: join(root, 'website'), busy: () => busy, restart: () => { restarted++; } }));
  const run = (name: string, input: Record<string, unknown>, by = 'me') => registry.run(name, input, { by }) as Promise<any>;
  const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);

  assert.equal((await run('projects.list', {})).open, join(root, 'website'));
  await refused(run('projects.open', { dir: join(root, 'nowhere') }), 'missing');
  await refused(run('projects.open', { dir: join(root, 'notes') }), 'input');
  await refused(run('projects.open', { dir: join(root, 'garden') }, 'agent:main'), 'permission');
  busy = 'the agent is in the middle of something here';
  await refused(run('projects.open', { dir: join(root, 'garden') }), 'busy');
  assert.equal(readState().project, undefined, 'nothing was chosen yet');
  busy = undefined;
  assert.deepEqual(await run('projects.open', { dir: join(root, 'garden') }), { opening: join(root, 'garden'), restarting: true });
  assert.equal(readState().project, join(root, 'garden'), 'it is remembered, for the next start too');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarted, 1);

  // Looking somewhere else too.
  const elsewhere = mkdtempSync(join(tmpdir(), 'tandem-pj2-'));
  mkdirSync(join(elsewhere, 'far-away/.git'), { recursive: true });
  await run('projects.look', { dir: elsewhere });
  assert.ok(listProjects().some((p) => p.dir === join(elsewhere, 'far-away')));
  assert.deepEqual(JSON.parse(readFileSync(process.env.TANDEM_STATE!, 'utf8')).roots, [elsewhere]);
  rmSync(elsewhere, { recursive: true, force: true });
});

test('with no project open, the core has only what it takes to choose one', async () => {
  const lobby = await startLobby({ port: 0 });
  const base = `http://127.0.0.1:${lobby.port}/api`;
  const post = async (name: string, input: unknown = {}) => (await fetch(`${base}/run/${name}`, { method: 'POST', body: JSON.stringify(input) })).json() as Promise<any>;
  assert.deepEqual(await (await fetch(`${base}/info`)).json(), { project: null, name: 'tandem', last: 0, page: null, senses: false, copy: false });
  assert.deepEqual((await (await fetch(`${base}/commands`)).json() as { name: string }[]).map((c) => c.name), ['projects.list', 'projects.open', 'projects.look']);
  const list = await post('projects.list');
  assert.equal(list.result.open, null);
  assert.ok(mine(list.result.projects).some((p: any) => p.name === 'Gnome Garden'));
  assert.equal((await post('chat.send', { text: 'hello' })).code, 'unknown');
  assert.equal((await post('projects.open', { dir: join(root, 'garden') })).result.restarting, false, 'nothing looks after this one, so it only remembers');
  await lobby.close();
});
