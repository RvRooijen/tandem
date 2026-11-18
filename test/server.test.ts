// The server: the same commands over HTTP, the event log as a stream, and the
// agent answering a message through nothing but the command line.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../core/server.ts';
import { fixture } from './helpers.ts';

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const { host, dir, cleanup } = await fixture({ code: false });
const s = await startServer({ port: 0, host });
process.env.TANDEM_PORT = String(s.port);
const base = `http://127.0.0.1:${s.port}/api`;
after(async () => { await s.close(); cleanup(); });

const post = async (name: string, input: unknown = {}, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/run/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  return { status: res.status, ...(await res.json() as { ok: boolean; result?: any; code?: string; error?: string }) };
};

async function until(what: () => boolean, ms = 30000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('commands over HTTP: the list, a run, who is asking, what goes wrong', async () => {
  const list = await (await fetch(`${base}/commands`)).json() as { name: string }[];
  assert.ok(list.some((c) => c.name === 'agent.status'), 'the agent\'s own commands are in the list');
  // What the page is built from: which project this is, and what it offers.
  const info = await (await fetch(`${base}/info`)).json() as Record<string, unknown>;
  assert.deepEqual({ ...info, last: 0 }, { project: 'fixture', name: 'Fixture', last: 0, root: dir, page: null, senses: false, copy: false });

  const gnome = await post('art.get', { name: 'gnome' });
  assert.equal(gnome.status, 200);
  assert.equal(gnome.result.name, 'gnome');

  assert.deepEqual(await post('concepts.get', { id: 'orchids' }), { status: 404, ok: false, code: 'missing', error: 'there is no concept orchids; see concepts.list' });
  assert.equal((await post('nope.nothing')).status, 404);
  assert.equal((await post('concepts.get', {})).code, 'input');
  const denied = await post('proposals.decide', { accept: true }, { 'x-tandem-by': 'agent:main' });
  assert.equal(denied.status, 400);
  assert.equal(denied.code, 'permission');
  const bad = await fetch(`${base}/run/concepts.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
});

test('a look can be fetched as a picture', async () => {
  const look = await post('art.look', { name: 'gnome' });
  const res = await fetch(`http://127.0.0.1:${s.port}${look.result.url}`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok((await res.arrayBuffer()).byteLength > 5000);
  assert.equal((await fetch(`${base}/file/looks/..%2F..%2Fevents.jsonl`)).status, 404);
});

test('the event log is a stream: what was, then what happens', async () => {
  await post('chat.send', { text: 'fail: before anyone listens' });
  await until(() => !s.runner!.status().busy && host.events.since(0).some((e) => e.by === 'agent'));
  const n = host.events.last();
  const res = await fetch(`${base}/events?since=${n - 1}`);
  const reader = res.body!.getReader();
  let text = '';
  const read = async (want: RegExp) => {
    const t0 = Date.now();
    while (!want.test(text)) {
      if (Date.now() - t0 > 5000) throw new Error(`never saw ${want} in ${text}`);
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
  };
  await read(/out of patience/);                                  // history
  await read(/agent\.status/);                                    // and how the agent is right now
  await post('stage.point', { x: 10, y: 20, text: 'look here' }, { 'x-tandem-by': 'agent:main' });
  await read(/"type":"stage.point".*look here/);                  // live
  await reader.cancel();
});

test('a message from the person is answered by the agent, whose only hands are commands', async () => {
  const before = host.events.last();
  const sent = await post('chat.send', { text: 'make the tulips worth a bit more', refs: ['drawing:garden-flowers'] });
  const round = `r${sent.result.n}`;
  await until(() => host.events.since(before).some((e) => e.type === 'message' && e.by === 'agent'));
  await until(() => !s.runner!.status().busy);
  const evs = host.events.since(before);
  const proposal = evs.find((e) => e.type === 'proposal')!;
  assert.equal(proposal.by, 'agent:main');
  assert.deepEqual([proposal.kind, proposal.path, (proposal.after as { text: string }).text], ['concept', `tulips-${round}`, 'Tulips are worth a bit more.']);
  const reply = evs.find((e) => e.type === 'message' && e.by === 'agent')!;
  assert.match(String(reply.text), /I proposed it \(ok\)/);
  assert.match(String(reply.text), /Allowed: Bash\(tandem run:\*\)/, 'it is given the command line and little else');
  assert.match(String(reply.text), /About: refs/, 'what the message points at is written out for it');
  assert.equal(reply.round, round);
  assert.equal(evs.filter((e) => e.type === 'message' && e.by === 'agent').length, 1, 'said once');
  assert.equal((await post('concepts.get', { id: `tulips-${round}` })).status, 404, 'and nothing is changed until the person says so');

  assert.equal(JSON.parse(readFileSync(join(dir, '.tandem/data/agent.json'), 'utf8')).session, 'sess-1');
  // How big the conversation is: everything the last request carried, in tokens.
  // (An earlier message in this file already opened the conversation, so this one resumed it.)
  assert.deepEqual([s.runner!.status().context, s.runner!.status().limit], [64_100, 800_000]);
  assert.equal(JSON.parse(readFileSync(join(dir, '.tandem/data/agent.json'), 'utf8')).context, 64_100, 'and it is kept, for after a restart');
  assert.ok(existsSync(join(dir, '.tandem/data/events.jsonl')));

  // What the person shares with a message, the agent is told where to find.
  const kept = (await post('chat.attach', { name: 'sketch.png', data: 'iVBORw0KGgo=' })).result;
  const pic = await fetch(`http://127.0.0.1:${s.port}${kept.url}`);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  const nShared = host.events.last();
  await post('chat.send', { text: 'like this', files: [kept] });
  await until(() => host.events.since(nShared).some((e) => e.type === 'message' && e.by === 'agent'));
  assert.match(String(host.events.since(nShared).find((e) => e.by === 'agent')!.text), /Shared: sketch\.png is a picture, there: true\./);
  await until(() => !s.runner!.status().busy);

  // The next message carries on the same conversation.
  const n2 = host.events.last();
  await post('chat.send', { text: 'and again' });
  await until(() => host.events.since(n2).some((e) => e.type === 'message' && e.by === 'agent'));
  assert.match(String(host.events.since(n2).find((e) => e.by === 'agent')!.text), /^Again: /);
  await until(() => !s.runner!.status().busy);
  assert.equal(s.runner!.status().context, 64_100);

  // A conversation that goes on after tandem gained a command is told so, once: it does not read its list again.
  assert.doesNotMatch(String(host.events.since(n2).find((e) => e.by === 'agent')!.text), /New:/);
  assert.ok(JSON.parse(readFileSync(join(dir, '.tandem/data/agent.json'), 'utf8')).commands.includes('concepts.create'), 'what it was told of is kept, for after a restart');
  host.registry.add({ name: 'page.wave', kind: 'write', agent: 'free', about: 'Wave at the person. From their own screen.', run: () => ({ waved: true }) });
  host.registry.add({ name: 'page.secret', kind: 'write', about: 'Only the person does this.', run: () => ({}) });
  const g1 = host.events.last();
  await post('chat.send', { text: 'now you can' });
  await until(() => host.events.since(g1).some((e) => e.type === 'message' && e.by === 'agent'));
  assert.match(String(host.events.since(g1).find((e) => e.by === 'agent')!.text), /New: page\.wave \(Wave at the person\.\)\.$/, 'what it may now do itself, in a line');
  await until(() => !s.runner!.status().busy);
  const g2 = host.events.last();
  await post('chat.send', { text: 'and once more' });
  await until(() => host.events.since(g2).some((e) => e.type === 'message' && e.by === 'agent'));
  assert.doesNotMatch(String(host.events.since(g2).find((e) => e.by === 'agent')!.text), /New:/);
  await until(() => !s.runner!.status().busy);

  // A new conversation: the agent does not carry the old one on.
  await post('chat.new');
  assert.equal((await post('agent.status')).result.session, false);
  assert.equal((await post('agent.status')).result.context, 0, 'a new conversation starts empty');
  const n4 = host.events.last();
  await post('chat.send', { text: 'who are you again' });
  await until(() => host.events.since(n4).some((e) => e.type === 'message' && e.by === 'agent'));
  assert.doesNotMatch(String(host.events.since(n4).find((e) => e.by === 'agent')!.text), /^Again: /);
  await until(() => !s.runner!.status().busy);
  assert.equal((await post('chat.history')).result.length, 2);

  // A failure is said, not swallowed. (It first tries once more without the old conversation.)
  const n3 = host.events.last();
  await post('chat.send', { text: 'fail please' });
  await until(() => host.events.since(n3).some((e) => e.by === 'agent' && e.error));
  assert.match(String(host.events.since(n3).find((e) => e.by === 'agent')!.text), /did not work: out of patience/);
  await until(() => !s.runner!.status().busy);
  assert.equal((await post('agent.status')).result.busy, false);
  assert.equal((await post('agent.reset')).result.reset, true);
  assert.equal((await post('agent.stop', {}, { 'x-tandem-by': 'agent:main' })).code, 'permission');
});

test('a turn that was cut off because tandem was started again is taken up again', async () => {
  // A project whose agent was in the middle of answering when the core went away: that is kept with its conversation.
  const other = await fixture({ code: false });
  writeFileSync(join(other.dir, '.tandem/data/agent.json'), JSON.stringify({ session: 'sess-7', context: 1000, running: 3 }));
  const was = process.env.TANDEM_PORT;
  const s2 = await startServer({ port: 0, host: other.host });
  process.env.TANDEM_PORT = String(s2.port);
  try {
    await until(() => other.host.events.since(0).some((e) => e.type === 'message' && e.by === 'agent'));
    await until(() => !s2.runner!.status().busy);
    const told = other.host.events.since(0).find((e) => e.type === 'message' && e.by === 'engine')!;
    assert.deepEqual([told.kind, /carry on from where you were/.test(String(told.text))], ['resume', true]);
    assert.match(String(other.host.events.since(0).find((e) => e.by === 'agent')!.text), /^Again: /, 'in the conversation it was in');
    assert.equal(JSON.parse(readFileSync(join(other.dir, '.tandem/data/agent.json'), 'utf8')).running, undefined, 'and when the turn is over there is nothing left to take up');
  } finally {
    process.env.TANDEM_PORT = was;
    await s2.close();
    other.cleanup();
  }
});
