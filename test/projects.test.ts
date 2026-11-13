// Choosing a project: the folders that could be one, opening one, and the core
// with no project open at all.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError, createRegistry } from '../core/commands.ts';
import { execFileSync } from 'node:child_process';
import { createHost } from '../core/host.ts';
import { listProjects, projectCommands, readState, welcome } from '../core/projects.ts';
import { startLobby } from '../core/server.ts';
import { fixture } from './helpers.ts';

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
    ['notes', false, false, false, false, false],         // a folder, not a repository yet
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

test('a folder without a repository gets one when it is opened; a new project is a new folder with one', async () => {
  const registry = createRegistry();
  registry.add(...projectCommands({ current: join(root, 'website') }));
  const run = (name: string, input: Record<string, unknown>, by = 'me') => registry.run(name, input, { by }) as Promise<any>;
  const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  // A folder with things in it and no repository: opening it starts one, with what is there as its first commit.
  writeFileSync(join(root, 'notes/ideas.md'), 'a game about a lighthouse\n');
  mkdirSync(join(root, 'notes/node_modules/junk'), { recursive: true });
  writeFileSync(join(root, 'notes/node_modules/junk/index.js'), 'x');
  const opened = await run('projects.open', { dir: join(root, 'notes') });
  assert.match(opened.started, /a git repository/);
  assert.equal(git(join(root, 'notes'), 'log', '--format=%s'), 'The project as tandem found it');
  assert.deepEqual(git(join(root, 'notes'), 'ls-files').split('\n'), ['.gitignore', 'ideas.md'], 'what is never a project\'s own is kept out of it');
  assert.equal(git(join(root, 'notes'), 'status', '--porcelain'), '');
  // Opened again, nothing is started again.
  assert.equal((await run('projects.open', { dir: join(root, 'notes') })).started, undefined);

  // A new project: a folder named after it, in the folder the person chose, with a repository and nothing much
  // in it. Where it goes is never decided for them.
  await refused(run('projects.create', { name: 'The Lighthouse Keeper!' }), 'input');
  const made = await run('projects.create', { name: 'The Lighthouse Keeper!', in: root });
  const dir = join(root, 'the-lighthouse-keeper');
  assert.equal(made.opening, dir);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# The Lighthouse Keeper!\n');
  // What tandem knows of it is in tandem's own folder, not among the project's files.
  assert.equal(JSON.parse(readFileSync(join(dir, '.tandem/tandem.json'), 'utf8')).name, 'The Lighthouse Keeper!');
  assert.deepEqual(git(dir, 'ls-files').split('\n'), ['.gitignore', '.tandem/tandem.json', 'README.md']);
  assert.equal(readState().project, dir);
  assert.ok(listProjects().some((p) => p.dir === dir && p.name === 'The Lighthouse Keeper!' && p.git));
  await refused(run('projects.create', { name: 'the lighthouse keeper', in: root }), 'exists');
  await refused(run('projects.create', { name: '!!!', in: root }), 'input');
  await refused(run('projects.create', { name: 'x', in: join(root, 'nowhere') }), 'missing');
  await refused(run('projects.create', { name: 'Another', in: root }, 'agent:main'), 'permission');

  // Choosing where: the folders are walked. It starts where a project was last made.
  const here = await run('projects.browse', {});
  assert.equal(here.dir, root);
  assert.deepEqual(here.folders, ['garden', 'notes', 'the-lighthouse-keeper', 'website'], 'folders only, and not the hidden ones');
  assert.equal(here.parent, join(root, '..'));
  const inside = await run('projects.browse', { dir: join(root, 'garden') });
  assert.deepEqual([inside.dir, inside.parent, inside.folders], [join(root, 'garden'), root, []]);
  assert.equal((await run('projects.browse', { dir: '/' })).parent, null);
  // Home is the person's own: the one named, before the one of the system tandem runs in.
  process.env.TANDEM_HOME = join(root, 'notes');
  assert.equal(inside.home === join(root, 'notes'), false);
  assert.equal((await run('projects.browse', { dir: root })).home, join(root, 'notes'));
  delete process.env.TANDEM_HOME;
  await refused(run('projects.browse', { dir: join(root, 'nowhere') }), 'missing');
});

test('a project tandem has not been in before gets a first line in its chat, once', async () => {
  const { host, cleanup } = await fixture({ code: false });
  assert.equal(welcome(host), true);
  const ev = host.events.since(0)[0];
  assert.deepEqual([ev.type, ev.by, ev.existing, ev.name], ['welcome', 'engine', true, 'Fixture'], 'it has things in it: the offer is to read it');
  assert.equal(welcome(host), false, 'said once');
  cleanup();
  // A project with nothing in it yet is asked what it is going to be.
  const registry = createRegistry();
  registry.add(...projectCommands({}));
  const made = await registry.run('projects.create', { name: 'Blank', in: root }, { by: 'me' }) as { opening: string };
  const blank = await createHost({ project: made.opening, code: null });
  assert.equal(welcome(blank), true);
  assert.equal(blank.events.since(0)[0].existing, false);
  // And one that already has concepts written down is not new.
  await blank.run('chat.new', {}, 'me');
  const known = await fixture({ code: false });
  await known.host.run('concepts.create', { name: 'An idea' }, 'me');
  assert.equal(known.host.events.last(), 1);
  assert.equal(welcome(known.host), false);
  known.cleanup();
});

test('with no project open, the core has only what it takes to choose one', async () => {
  const lobby = await startLobby({ port: 0 });
  const base = `http://127.0.0.1:${lobby.port}/api`;
  const post = async (name: string, input: unknown = {}) => (await fetch(`${base}/run/${name}`, { method: 'POST', body: JSON.stringify(input) })).json() as Promise<any>;
  assert.deepEqual(await (await fetch(`${base}/info`)).json(), { project: null, name: 'tandem', last: 0, page: null, senses: false, copy: false });
  assert.deepEqual((await (await fetch(`${base}/commands`)).json() as { name: string }[]).map((c) => c.name), ['projects.list', 'projects.open', 'projects.create', 'projects.browse', 'projects.look']);
  const list = await post('projects.list');
  assert.equal(list.result.open, null);
  assert.ok(mine(list.result.projects).some((p: any) => p.name === 'Gnome Garden'));
  assert.equal((await post('chat.send', { text: 'hello' })).code, 'unknown');
  assert.equal((await post('projects.open', { dir: join(root, 'garden') })).result.restarting, false, 'nothing looks after this one, so it only remembers');
  await lobby.close();
});
