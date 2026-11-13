// The agent codes in a working copy of the project, and what it changed there
// is a proposal; accepted, it is the project. And when art is accepted, the
// engine tells the agent, whose work it is to bring it in. On the fixture
// project, with a stand-in for claude that works where it stands.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../core/server.ts';
import { fixture } from './helpers.ts';

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const { host, dir, cleanup } = await fixture();
const s = await startServer({ port: 0, host });
process.env.TANDEM_PORT = String(s.port);
after(async () => { await s.close(); cleanup(); });

const copy = host.code!.work;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const me = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'me') as Promise<any>;
async function until(what: () => unknown, says: string, ms = 60000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for ${says}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code); return true; });
}
const idle = () => until(() => !s.runner!.status().busy, 'the agent to be done');
const answers = () => host.events.since(0).filter((e) => e.type === 'message' && e.by === 'agent');

test('asked to code, the agent works in its copy, and what the copy changed is a proposal', async () => {
  assert.match(copy, /\.fixture-tandem-work$/, 'its copy is a folder right beside the project');
  await me('chat.send', { text: 'code: give it seasons' });
  await until(() => answers().length === 1, 'the answer');
  await idle();
  const said = String(answers()[0].text);
  assert.match(said, /Seasons added\. In the copy: true\. May edit: true;/, 'it stood in its working copy and could change the project\'s files');
  assert.match(said, /may run: Bash\(node --test:\*\) Bash\(node check\.mjs:\*\) Bash\(node build-art\.mjs:\*\)\./, 'it may run what the project says: its tests, its check, its build');
  assert.match(said, /Kept off: Edit\(\.tandem\/\*\*\) Edit\(art\/\*\*\) Edit\(depth\/\*\*\)\. Note: none\./, 'but not tandem\'s own folder or the drawings');
  assert.ok(existsSync(join(copy, 'src/seasons.js')));
  assert.ok(!existsSync(join(dir, 'src/seasons.js')), 'the project does not have it');

  const p = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.deepEqual([p.kind, p.round, p.by], ['code', 'code', 'agent:main']);
  assert.deepEqual(p.files, [{ path: 'src/seasons.js', added: 1, removed: 0, status: 'new' }]);
  assert.equal(p.note, '', 'its answer is in the chat, not said again on the card; the card says what the change is once the agent has said so');
  assert.deepEqual((await me('code.changes')).files, p.files);
  assert.match((await me('code.changes', { path: 'src/seasons.js' })).diff, /\+export const SEASONS = 4;/);
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1);
});

test('when the copy is the project again, the proposal is gone; rejected, the copy is put back; accepted, it is the project', async () => {
  await me('chat.send', { text: 'code: undo that' });
  await until(() => answers().length === 2, 'the answer');
  await idle();
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 0, 'nothing differs, so nothing is proposed');
  assert.equal(host.events.since(0).at(-1)!.type, 'proposal.decided');

  await me('chat.send', { text: 'code: seasons after all' });
  await until(() => answers().length === 3, 'the answer');
  await idle();
  await me('proposals.decide', { round: 'code', accept: false });
  assert.ok(!existsSync(join(copy, 'src/seasons.js')), 'rejected: its copy is the project again');
  assert.deepEqual((await me('code.changes')).files, []);

  await me('chat.send', { text: 'code: seasons, really' });
  await until(() => answers().length === 4, 'the answer');
  await idle();
  // What the change does, in the agent's plain words, is what the proposal says from then on, and the commit.
  await refused(me('code.describe', { text: ' ' }), 'input');
  const first = await host.run('code.describe', { text: 'Seasons.' }, 'agent:main') as any;
  assert.deepEqual([first.replaces, first.covers], [undefined, ['src/seasons.js']]);
  // Said again, it is told what it replaces and what the change set holds: the description is of all of it.
  const again = await host.run('code.describe', { text: 'The year has four seasons now.\nNothing uses them yet.' }, 'agent:main') as any;
  assert.deepEqual([again.replaces, again.covers], ['Seasons.', ['src/seasons.js']]);
  assert.match(again.says, /the whole change set \(1 file\)/);
  assert.equal(host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!.note, 'The year has four seasons now.\nNothing uses them yet.');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1, 'still the one proposal');
  await me('proposals.decide', { round: 'code', accept: true });
  assert.equal(readFileSync(join(dir, 'src/seasons.js'), 'utf8'), 'export const SEASONS = 4;\n', 'accepted: the project has it');
  assert.match(git('log', '--oneline', '-1'), /The year has four seasons now\.$/, 'as one commit that says what it is');
  assert.ok(!existsSync(join(host.dirs.data, 'code-about.txt')), 'what was said about it goes with it');
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.files, ['src/seasons.js']);
  assert.deepEqual((await me('code.changes')).files, []);
  assert.equal(git('status', '--porcelain'), '');
});

test('the engine tells the agent when art was accepted; the drawing reaches its copy, and is not built for it', async () => {
  const tiny = 'k = #1a1c2c\n\n@size 8 8\n@rect 1 1 6 6 k\n';
  await host.run('art.set', { name: 'garden-sign', text: tiny }, 'agent:main', 'r90');
  const before = answers().length;
  await me('proposals.decide', { round: 'r90', accept: true });
  assert.equal(readFileSync(join(dir, 'art/garden-sign.txt'), 'utf8'), tiny, 'the drawing is in the project\'s art files');
  const told = host.events.since(0).filter((e) => e.type === 'message' && e.by === 'engine').at(-1)!;
  assert.match(String(told.text), /Art was accepted into the project: garden-sign \(new; 8×8; looks: default; animations: main ×1\)\. .* Bring it in/);
  assert.deepEqual(told.refs, ['drawing:garden-sign']);
  assert.equal(host.events.since(0).filter((e) => e.type === 'art.changed').at(-1)!.built, false, 'accepting it did not build it');
  assert.ok(!existsSync(join(dir, 'built.json')));
  // And the agent is set to work by it, without the person saying anything.
  await until(() => answers().length === before + 1, 'the agent to answer the engine');
  await idle();
  assert.equal(readFileSync(join(copy, 'art/garden-sign.txt'), 'utf8'), tiny, 'by then its copy has the drawing');
  assert.match(git('log', '--oneline', '-1'), /What was changed and accepted in tandem/, 'because the engine committed what it had written in the project');
  await me('proposals.decide', { round: 'code', accept: false }).catch(() => {});
});
