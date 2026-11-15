// The agent codes in a working copy of the project, and what it changed there
// is a proposal; accepted, it is the project. And when art is accepted, the
// engine tells the agent, whose work it is to bring it in. On the fixture
// project, with a stand-in for claude that works where it stands.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from '../core/runner.ts';
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
  assert.match(said, /may run: Bash\(ls:\*\) Bash\(grep:\*\) Bash\(cat:\*\) Bash\(head:\*\) Bash\(tail:\*\) Bash\(wc:\*\) Bash\(node --test:\*\) Bash\(node check\.mjs:\*\) Bash\(node build-art\.mjs:\*\)\./, 'it may look around, and run what the project says: its tests, its check, its build');
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
  // Where the change shows goes with the change set: the way there, and the thing itself.
  await refused(host.run('code.show', { steps: [{ press: 'Shop' }] }, 'agent:main'), 'input');
  await refused(host.run('code.show', { steps: [{ go: 'https://elsewhere.example/' }] }, 'agent:main'), 'input');
  await host.run('code.show', { steps: [{ tap: 'Calendar' }, { fill: 'Year', text: '2' }], at: 'Autumn', text: 'the new season' }, 'agent:main');
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!.show, { steps: [{ tap: 'Calendar' }, { fill: 'Year', text: '2' }], at: 'Autumn', text: 'the new season' });
  assert.ok(existsSync(join(host.dirs.data, 'code-show.json')));
  await me('proposals.decide', { round: 'code', accept: true });
  assert.equal(readFileSync(join(dir, 'src/seasons.js'), 'utf8'), 'export const SEASONS = 4;\n', 'accepted: the project has it');
  assert.ok(!existsSync(join(host.dirs.data, 'code-show.json')), 'and it goes with the change set');
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

test('an accepted change to what the project depends on is installed in the project too', async () => {
  // (npm itself is not run here: something that says where it was run, and with what.)
  const ran = join(host.dirs.data, 'npm-ran.txt');
  const npm = join(host.dirs.data, 'npm.sh');
  writeFileSync(npm, `#!/bin/sh\necho "$PWD: $*" > "${ran}"\n`, { mode: 0o755 });
  process.env.TANDEM_NPM = npm;
  try {
    writeFileSync(join(copy, 'package.json'), '{"name":"fixture","dependencies":{"left-pad":"1.3.0"}}\n');
    host.proposeCode('agent:main', 'It depends on left-pad now.');
    await me('proposals.decide', { round: 'code', accept: true });
    assert.equal(readFileSync(ran, 'utf8').trim(), `${dir}: install`, 'in the project, not in the copy');
    assert.equal(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.installed, true);
    // A change set that leaves package.json alone installs nothing; and when it fails, the accept stands and it is said.
    rmSync(ran);
    writeFileSync(npm, '#!/bin/sh\necho "npm ERR! no such package" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(copy, 'src/more.js'), 'export const MORE = 1;\n');
    host.proposeCode('agent:main', 'More.');
    await me('proposals.decide', { round: 'code', accept: true });
    assert.ok(!existsSync(ran));
    assert.equal(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.installed, undefined);
    writeFileSync(join(copy, 'package.json'), '{"name":"fixture","dependencies":{"nope":"9.9.9"}}\n');
    host.proposeCode('agent:main', 'It depends on nope now.');
    await me('proposals.decide', { round: 'code', accept: true });
    assert.equal(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.installed, 'npm ERR! no such package');
    assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /nope/, 'accepted all the same');
  } finally { delete process.env.TANDEM_NPM; }
});

test('a change set says which concepts it is for: on the card, in the commit, and with the concept from then on', async () => {
  await me('concepts.create', { name: 'The year turns', text: 'Seasons follow each other.' });
  await me('concepts.create', { name: 'Frost' });
  const of = async (id: string) => (await me('concepts.list')).find((c: any) => c.id === id);
  writeFileSync(join(copy, 'src/winter.js'), 'export const WINTER = true;\n');
  // Only a concept that is there, by its id: the agent does not make one up for a change.
  await refused(host.run('code.describe', { text: 'Winter comes.', concepts: ['no-such-thing'] }, 'agent:main'), 'missing');
  await refused(host.run('code.describe', { text: 'Winter comes.', concepts: 'the-year-turns' }, 'agent:main'), 'input');
  const said = await host.run('code.describe', { text: 'Winter comes.', concepts: ['the-year-turns'] }, 'agent:main') as any;
  assert.deepEqual(said.concepts, ['the-year-turns']);
  host.proposeCode('agent:main', '');
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!.touches, [{ id: 'the-year-turns', name: 'The year turns', stage: 'idea' }], 'the card names it');
  // While it waits, the concept says so; another concept does not.
  assert.deepEqual([(await of('the-year-turns')).waiting, (await of('frost')).waiting], [true, undefined]);
  assert.deepEqual(await me('concepts.history', { id: 'the-year-turns' }), { waiting: { says: 'Winter comes.', files: 1 }, changes: [] });
  // Described again without saying which, it is still for the same ones.
  assert.deepEqual((await host.run('code.describe', { text: 'Winter comes, and stays.' }, 'agent:main') as any).concepts, ['the-year-turns']);

  await me('proposals.decide', { round: 'code', accept: true });
  assert.equal(git('log', '-1', '--format=%B'), 'Winter comes, and stays.\n\nConcept: the-year-turns', 'the commit says which concept it is for');
  assert.ok(!existsSync(join(host.dirs.data, 'code-for.json')), 'and that goes with the change set');
  const made = await me('concepts.history', { id: 'the-year-turns' });
  assert.equal(made.waiting, undefined);
  assert.deepEqual(made.changes.map((m: any) => [m.says, m.hash.length]), [['Winter comes, and stays.', 10]]);
  assert.deepEqual([(await of('the-year-turns')).changes, (await of('frost')).changes], [1, undefined]);

  // The person's own commit can say it too, in the same words; it is the history that is read.
  writeFileSync(join(dir, 'src/frost.js'), 'export const FROST = 1;\n');
  git('add', 'src/frost.js');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Frost bites\n\nConcept: frost\nConcept: the-year-turns', '--', 'src/frost.js');
  assert.deepEqual((await me('concepts.history', { id: 'frost' })).changes.map((m: any) => m.says), ['Frost bites']);
  assert.deepEqual((await me('concepts.history', { id: 'the-year-turns' })).changes.map((m: any) => m.says), ['Frost bites', 'Winter comes, and stays.'], 'the newest first');

  // The next change set is for no concept until it is said to be; and one said to be for none has no line.
  host.code!.sync();
  writeFileSync(join(copy, 'src/tidy.js'), 'export const TIDY = 1;\n');
  await host.run('code.describe', { text: 'Tidied up.', concepts: [] }, 'agent:main');
  host.proposeCode('agent:main', '');
  assert.equal(host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!.touches, undefined);
  await me('proposals.decide', { round: 'code', accept: true });
  assert.equal(git('log', '-1', '--format=%B'), 'Tidied up.');
  await refused(me('concepts.history', { id: 'no-such-thing' }), 'missing');
});

test('the agent may run a script of its own from its scratchpad, and nothing typed straight into the command line', () => {
  const { allow, deny } = tools(host);
  assert.ok(!allow.some((r) => /^Bash\((gh|git push)/.test(r)), 'pushing and the remote are not the agent\'s: tandem pushes, to where the person said');
  for (const rule of ['Write(.tandem-scratch/**)', 'Edit(.tandem-scratch/**)', 'Bash(node .tandem-scratch/:*)', 'Bash(node --test .tandem-scratch/:*)', 'Bash(python3 .tandem-scratch/:*)'])
    assert.ok(allow.includes(rule), rule);
  // An interpreter by itself is not allowed: only with a file from the scratchpad after it.
  assert.ok(!allow.some((r) => /^Bash\((python3?|node|sh|bash)(:\*)?\)$/.test(r)));
  assert.ok(deny.includes('Write(.tandem/**)'), 'tandem\'s own folder stays out of reach');
});

test('the person says where the project is pushed, and from then on every accept is', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'tandem-remote-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const there = () => { try { return execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    assert.deepEqual(await me('project.remote'), { git: true, url: null });
    await assert.rejects(host.run('project.setRemote', { url: bare }, 'agent:main', 'r1'), /the person's to do/);
    await assert.rejects(me('project.setRemote', { url: '--upload-pack=x' }), /not the address of a repository/);

    // Set, it is the project's origin, and what is there goes at once.
    const before = host.events.last();
    assert.deepEqual(await me('project.setRemote', { url: bare }), { url: bare, pushed: true });
    assert.deepEqual(await me('project.remote'), { git: true, url: bare, remote: 'origin', branch: 'main' });
    assert.equal(git('remote', 'get-url', 'origin'), bare);
    assert.equal(there(), git('rev-parse', 'HEAD'));
    assert.deepEqual(host.events.since(before).map((e) => [e.type, e.url ?? e.ok]), [['remote.changed', bare], ['project.pushed', true]]);

    // An accepted concept is committed by the engine and pushed, without anybody asking.
    await host.run('concepts.create', { name: 'Pushed along', text: 'It goes to the remote.' }, 'agent:main', 'r95');
    await me('proposals.decide', { round: 'r95', accept: true });
    assert.equal(git('status', '--porcelain'), '', 'what the engine wrote for it is committed');
    assert.equal(there(), git('rev-parse', 'HEAD'), 'and the remote has it');
    const pushed = host.events.since(before).filter((e) => e.type === 'project.pushed').at(-1)!;
    assert.deepEqual([pushed.ok, pushed.remote, pushed.branch], [true, 'origin', 'main']);
    // Refusing something pushes nothing.
    const n = host.events.since(0).filter((e) => e.type === 'project.pushed').length;
    await host.run('concepts.create', { name: 'Not this one' }, 'agent:main', 'r96');
    await me('proposals.decide', { round: 'r96', accept: false });
    assert.equal(host.events.since(0).filter((e) => e.type === 'project.pushed').length, n);

    // A remote that is not there: the accept stands, and it is said that the push did not go.
    await me('project.setRemote', { url: join(bare, 'nowhere') });
    assert.equal(host.events.since(0).at(-1)!.ok, false);
    await idle();
    // Emptied, the project has no remote any more.
    assert.deepEqual(await me('project.setRemote', { url: '' }), { url: null });
    assert.deepEqual(await me('project.remote'), { git: true, url: null });
    await me('concepts.remove', { id: 'pushed-along' });
    await idle();
  } finally { rmSync(bare, { recursive: true, force: true }); }
});
