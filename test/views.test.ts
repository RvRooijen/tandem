// The views: what there is to see of a project besides its page. Said in its tandem.json, served in a sandbox,
// and fed only by commands: what the page says, a SQLite file, the project's own commands. The agent's views and
// commands come as a proposal and can be tried while it waits; what does something is the person's to accept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../core/server.ts';
import { fixture } from './helpers.ts';

const { host, dir, cleanup } = await fixture();
const s = await startServer({ port: 0, host, agent: false });
after(async () => { await s.close(); cleanup(); });
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
const agent = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'agent:main', 'r1') as Promise<any>;
async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; });
}
const last = (type: string) => host.events.since(0).filter((e) => e.type === type).at(-1) as any;

// A database of the project's, and the project's own commands: one that reads it, one that does something.
const db = new DatabaseSync(join(dir, 'notes.db'));
db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT, size REAL); INSERT INTO notes (text, size) VALUES ('first', 1.5), ('second', NULL)");
db.close();
const module = `export const commands = [
  { name: 'count', about: 'How many notes there are.', kind: 'read', run: (_i, t) => t.query('notes.db', 'SELECT count(*) AS n FROM notes').rows[0][0] },
  { name: 'mark', about: 'Leave a mark in the folder.', kind: 'write', input: { word: 'string' }, async run(i, t) { return (await t.sh('printf %s ' + i.word + ' > mark.txt && cat mark.txt')).out; } },
];
`;
writeFileSync(join(dir, 'commands.ts'), module);
writeFileSync(join(dir, 'board.html'), '<!doctype html><html><head><title>Board</title></head><body><h1>The board</h1></body></html>');

test('the person says the views: in tandem.json and tandem\'s folder, without starting the page again', async () => {
  await refused(me('project.configure', { views: [{ name: 'Logs' }] }), 'input');
  await refused(me('project.configure', { views: [{ name: 'Data', kind: 'data' }] }), 'input');
  await refused(me('project.configure', { files: { 'elsewhere.txt': 'board.html' } }), 'input');
  await refused(me('project.configure', { files: { 'views/board.html': '../outside.html' } }), 'missing');
  const views = [
    { name: 'Logs', kind: 'logs' },
    { name: 'API', kind: 'api', endpoints: [{ method: 'GET', path: '/api/status', about: 'Whether it is up' }] },
    { name: 'Notes', kind: 'data', file: 'notes.db' },
    { name: 'Board', view: 'board.html' },
  ];
  assert.deepEqual(await me('project.configure', { views, files: { 'views/board.html': 'board.html', 'commands.ts': 'commands.ts' } }), { changed: true });
  assert.deepEqual(JSON.parse(readFileSync(host.project.configFile, 'utf8')).views, views);
  assert.match(readFileSync(join(host.project.viewsDir, 'board.html'), 'utf8'), /The board/);
  assert.ok(existsSync(host.project.commandsModule));
  assert.equal(last('setup.changed').restarting, false, 'views are read as they are: nothing is started again for them');
  assert.deepEqual((await me('views.list')).map((v: any) => [v.name, v.kind, v.url]), [
    ['Logs', 'logs', '/api/view/Logs'], ['API', 'api', '/api/view/API'], ['Notes', 'data', '/api/view/Notes'], ['Board', 'view', '/api/view/Board'],
  ]);
  assert.deepEqual(await me('api.endpoints'), views[1].endpoints);
});

test('a view is served in a sandbox, with tandem\'s lines and what it is', async () => {
  const res = await fetch(`http://127.0.0.1:${s.port}/api/view/Board?copy=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/);
  const html = await res.text();
  assert.match(html, /window\.tandemView=\{"name":"Board","view":"board.html","copy":true\}/);
  assert.match(html, /window\.tandem = \{/, 'how it asks');
  assert.match(html, /__tandemPage/, 'what is on it can be pointed at');
  assert.ok(html.indexOf('tandemView') < html.indexOf('<h1>'), 'before its own lines');
  assert.match(await (await fetch(`http://127.0.0.1:${s.port}/api/view/Logs`)).text(), /logs\.read/);
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/view/Nothing`)).status, 404);
});

test('what the page says: the last part, what came after, and only what has a word in it', async () => {
  assert.equal((await me('logs.read')).text, '');
  mkdirSync(join(dir, '.tandem', 'data'), { recursive: true });
  writeFileSync(host.project.pageLog, 'info: started\n\x1b[33mwarn: slow\x1b[0m\n');
  const first = await me('logs.read');
  assert.equal(first.text, 'info: started\nwarn: slow\n');
  appendFileSync(host.project.pageLog, 'fail: broke\n');
  assert.deepEqual(await me('logs.read', { after: first.next }), { text: 'fail: broke\n', next: first.next + 12 });
  assert.equal((await me('logs.read', { find: 'SLOW' })).text, 'warn: slow');
  // Started again, the page has a log of its own: read from the start.
  writeFileSync(host.project.pageLog, 'info: again\n');
  assert.deepEqual(await me('logs.read', { after: 999 }), { text: 'info: again\n', next: 12, reset: true });
});

test('a SQLite file, read-only: its tables and a question', async () => {
  const [notes] = await me('data.tables', { file: 'notes.db' });
  assert.deepEqual(notes, { name: 'notes', type: 'table', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'text', type: 'TEXT' }, { name: 'size', type: 'REAL' }], rows: 2 });
  assert.deepEqual(await me('data.query', { file: 'notes.db', sql: 'SELECT text, size FROM notes WHERE id > ? ORDER BY id', params: [0], limit: 1 }), { columns: ['text', 'size'], rows: [['first', 1.5]], more: true });
  await refused(me('data.query', { file: 'notes.db', sql: 'DELETE FROM notes' }), 'failed');
  assert.equal((await me('data.query', { file: 'notes.db', sql: 'SELECT count(*) AS n FROM notes' })).rows[0][0], 2, 'nothing was changed');
  await refused(me('data.query', { file: '../notes.db', sql: 'SELECT 1' }), 'input');
  await refused(me('data.query', { file: 'none.db', sql: 'SELECT 1' }), 'missing');
});

test('the project\'s own commands: one that reads answers, one that does something is the person\'s to accept', async () => {
  assert.deepEqual(await agent('project.commands'), [
    { name: 'count', about: 'How many notes there are.', kind: 'read', input: {} },
    { name: 'mark', about: 'Leave a mark in the folder.', kind: 'write', input: { word: 'string' } },
  ]);
  assert.equal(await agent('project.run', { name: 'count' }), 2);
  await refused(me('project.run', { name: 'mark' }), 'input');
  await refused(me('project.run', { name: 'nothing' }), 'missing');

  assert.equal(await me('project.run', { name: 'mark', input: { word: 'mine' } }), 'mine');
  assert.equal(readFileSync(join(dir, 'mark.txt'), 'utf8'), 'mine');
  assert.equal(last('project.ran').by, 'me');

  const asked = await agent('project.run', { name: 'mark', input: { word: 'agents' } });
  assert.ok(asked.proposed, 'the agent\'s is a proposal');
  assert.equal(readFileSync(join(dir, 'mark.txt'), 'utf8'), 'mine', 'and nothing is done yet');
  assert.equal(last('proposal').kind, 'run');
  await me('proposals.decide', { accept: true });
  for (let t = 0; !last('project.ran')?.proposal && t < 200; t++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(last('project.ran').result, '"agents"');
  assert.equal(readFileSync(join(dir, 'mark.txt'), 'utf8'), 'agents');
});

test('the agent\'s views come as a proposal, there to try while it waits', async () => {
  const copy = host.code!.work;
  host.code!.sync();
  mkdirSync(join(copy, '.tandem-scratch'), { recursive: true });
  writeFileSync(join(copy, '.tandem-scratch', 'chart.html'), '<!doctype html><html><head></head><body><h1>The chart</h1></body></html>');
  writeFileSync(join(copy, '.tandem-scratch', 'commands.ts'), module.replace("name: 'count'", "name: 'total'"));
  const views = [...host.project.config.views!, { name: 'Chart', view: 'chart.html' }];
  const got = await agent('project.configure', { views, files: { 'views/chart.html': '.tandem-scratch/chart.html', 'commands.ts': '.tandem-scratch/commands.ts' } });
  assert.ok(got.proposed);
  assert.match(got.says, /views are as it makes them/);
  assert.doesNotMatch(got.says, /started again/, 'views alone do not start the page again');
  assert.ok(!existsSync(join(host.project.viewsDir, 'chart.html')), 'nothing is written yet');

  const list = await agent('views.list');
  assert.deepEqual(list.at(-1), { name: 'Chart', kind: 'view', url: '/api/view/Chart', proposed: true });
  assert.ok(!list[0].proposed);
  assert.match(host.views.page('Chart', false)!, /The chart/);
  assert.deepEqual((await agent('project.commands')).map((c: any) => c.name), ['total', 'mark'], 'the commands it brings are there to try');
  assert.equal(await agent('project.run', { name: 'total' }), 2);

  await me('proposals.decide', { accept: false });
  assert.equal((await agent('views.list')).length, 4);
  assert.deepEqual((await agent('project.commands')).map((c: any) => c.name), ['count', 'mark']);
  assert.equal(host.views.page('Chart', false), undefined);
});

test('an answer that comes in a piece at a time is read as it comes', async () => {
  // The project's server, here: it writes one event, waits until it is told to go on, and writes the last.
  let goOn!: () => void;
  const going = new Promise<void>((r) => { goOn = r; });
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await going;
    res.end('data: last\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const was = process.env.TANDEM_PAGE_PORT;
  process.env.TANDEM_PAGE_PORT = String((server.address() as AddressInfo).port - 2000);
  const page = host.project.config.page;
  host.project.config.page = 'serve {port}';
  try {
    const head = await me('page.request', { path: '/answer', body: { question: 'why' }, stream: true });
    assert.deepEqual([head.status, head.type, typeof head.stream], [200, 'text/event-stream', 'string']);
    let got: any;
    for (let t = 0; !(got = await me('page.read', { stream: head.stream }))?.text && t < 100; t++) await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual([got.text, got.done], ['data: first\n\n', false], 'the first piece is there before the answer has ended');
    goOn();
    let rest: any;
    for (let t = 0; !(rest = await me('page.read', { stream: head.stream, after: got.next })).done && t < 100; t++) await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual([rest.text, rest.done, rest.error], ['data: last\n\n', true, undefined]);
    await refused(me('page.read', { stream: 'nothing' }), 'missing');
  } finally {
    host.project.config.page = page;
    if (was === undefined) delete process.env.TANDEM_PAGE_PORT; else process.env.TANDEM_PAGE_PORT = was;
    server.closeAllConnections();
    server.close();
  }
});

test('the agent looks at a view only when there is one', async () => {
  await refused(agent('page.look', { view: 'Nothing' }), 'missing');
});
