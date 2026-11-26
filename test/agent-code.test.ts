// The agent codes in a working copy of the project, and what it changed there
// is a proposal; accepted, it is the project. And when art is accepted, the
// engine tells the agent, whose work it is to bring it in. On the fixture
// project, with a stand-in for claude that works where it stands.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(said, /may run: Bash\(ls:\*\) Bash\(grep:\*\) Bash\(cat:\*\) Bash\(head:\*\) Bash\(tail:\*\) Bash\(wc:\*\) Bash\(node --test:\*\) Bash\(node check\.mjs:\*\) Bash\(node build-art\.mjs:\*\) Bash\(npm install\) Bash\(npm ci\)\./, 'it may look around, run what the project says (its tests, its check, its build), and install what it depends on');
  assert.match(said, /Kept off: Edit\(\.tandem\/\*\*\) Edit\(art\/\*\*\) Edit\(depth\/\*\*\)\. Note: none\./, 'but not tandem\'s own folder or the drawings');
  assert.ok(existsSync(join(copy, 'src/seasons.js')));
  assert.ok(!existsSync(join(dir, 'src/seasons.js')), 'the project does not have it');

  const p = host.events.since(0).filter((e) => e.type === 'proposal').at(-1)!;
  assert.deepEqual([p.kind, p.round, p.by], ['code', 'open', 'agent:main']);
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
  await me('proposals.decide', { accept: false });
  assert.ok(!existsSync(join(copy, 'src/seasons.js')), 'rejected: its copy is the project again');
  assert.deepEqual((await me('code.changes')).files, []);

  await me('chat.send', { text: 'code: seasons, really' });
  await until(() => answers().length === 4, 'the answer');
  await idle();
  // What the change does, in the agent's plain words, is what the proposal says from then on, and the commit.
  await refused(me('code.describe', { text: ' ' }), 'input');
  // One sentence, from the agent: a list of everything in it is refused.
  await assert.rejects(host.run('code.describe', { text: Array.from({ length: 31 }, () => 'word').join(' ') }, 'agent:main'), /that is 31 words/);
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
  await me('proposals.decide', { accept: true });
  assert.equal(readFileSync(join(dir, 'src/seasons.js'), 'utf8'), 'export const SEASONS = 4;\n', 'accepted: the project has it');
  assert.ok(!existsSync(join(host.dirs.data, 'code-show.json')), 'and it goes with the change set');
  assert.match(git('log', '--oneline', '-1'), /The year has four seasons now\.$/, 'as one commit that says what it is');
  assert.ok(!existsSync(join(host.dirs.data, 'code-about.txt')), 'what was said about it goes with it');
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.files, ['src/seasons.js']);
  assert.deepEqual((await me('code.changes')).files, []);
  assert.equal(git('status', '--porcelain'), '');
});

test('values the agent exposes with its change set are the person\'s to turn: written in the copy at once, and the agent hears of it', async () => {
  const file = 'src/seasons.js';
  const agent = (name: string, input?: Record<string, unknown>) => host.run(name, input, 'agent:main') as Promise<any>;
  const card = () => host.events.since(0).filter((e) => e.type === 'proposal').at(-1)! as any;
  writeFileSync(join(copy, file), [
    'export const SEASONS = 4;', 'export const DAYS = 30; // in a season', 'export const NAME = \'Autumn\';', 'export const SNOW = false;',
    'export const YEAR = 4 * 30;', 'export const tint = { leaf: "#c84", bark: 2 };', 'export const other = { bark: 3 };', '',
  ].join('\n'));
  host.proposeCode('agent:main', 'Seasons have days.');
  // Only a value that is written out, once, in a file the agent may change.
  const one = (v: Record<string, unknown>) => agent('code.expose', { values: [{ label: 'It', file, ...v }] });
  await refused(one({ file: '../elsewhere.js', name: 'DAYS' }), 'input');
  await refused(one({ file: '.tandem/tandem.json', name: 'name' }), 'input');
  await refused(one({ file: 'src/none.js', name: 'DAYS' }), 'missing');
  await assert.rejects(one({ name: 'YEAR' }), /not given a value that is written out/, 'a sum is not a value to turn');
  await assert.rejects(one({ name: 'bark' }), /2 times/);
  await refused(one({ name: 'NAME', min: 0, max: 3 }), 'input');
  await assert.rejects(one({ name: 'DAYS', min: 40, max: 90 }), /is 30 now, and it goes no lower than 40/);
  assert.equal(card().tweaks, undefined);

  const got = await agent('code.expose', { values: [
    { label: 'Days in a season', file, name: 'DAYS', min: 10, max: 90 }, { label: 'The first season', file: `./${file}`, name: 'NAME' },
    { label: 'Snow', file, name: 'SNOW' }, { label: 'Leaves', file, name: 'leaf' },
  ] });
  assert.deepEqual(got.exposed.map((t: any) => [t.name, t.is, t.as]), [['DAYS', 30, 'a slider'], ['NAME', 'Autumn', 'a text to fill in'], ['SNOW', false, 'a switch'], ['leaf', '#c84', 'a colour to pick']]);
  // They are on the card, each as it stands in the copy.
  assert.deepEqual(card().tweaks[0], { label: 'Days in a season', file, name: 'DAYS', min: 10, max: 90, kind: 'number', value: 30, step: 1 });
  assert.deepEqual(card().tweaks.map((t: any) => t.kind), ['number', 'text', 'boolean', 'colour']);

  // Turning one is the person's, within what the value can be.
  await refused(agent('code.tweak', { file, name: 'DAYS', value: 45 }), 'permission');
  await refused(me('code.tweak', { file, name: 'DAYS', value: 95 }), 'input');
  await refused(me('code.tweak', { file, name: 'DAYS', value: '45' }), 'input');
  await refused(me('code.tweak', { file, name: 'leaf', value: 'green' }), 'input');
  await refused(me('code.tweak', { file, name: 'NAME', value: 'Win\'ter' }), 'input');
  await refused(me('code.tweak', { file, name: 'SEASONS', value: 5 }), 'missing');
  assert.deepEqual(await me('code.tweak', { file, name: 'DAYS', value: 45 }), { value: 45, changed: true });
  assert.deepEqual(await me('code.tweak', { file, name: 'DAYS', value: 45 }), { value: 45, changed: false });
  // It is written where it stood, and nothing around it is touched.
  assert.match(readFileSync(join(copy, file), 'utf8'), /^export const DAYS = 45; \/\/ in a season$/m);
  assert.deepEqual([card().tweaks[0].value, card().tweaks[0].was, card().tweaked], [45, 30, { file, name: 'DAYS' }]);
  await me('code.tweak', { file, name: 'NAME', value: 'Winter' });
  await me('code.tweak', { file, name: 'SNOW', value: true });
  await me('code.tweak', { file, name: 'leaf', value: '#ffffff' });
  assert.equal(readFileSync(join(copy, file), 'utf8').split('\n').slice(2, 6).join('|'), 'export const NAME = \'Winter\';|export const SNOW = true;|export const YEAR = 4 * 30;|export const tint = { leaf: "#ffffff", bark: 2 };');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1, 'still the one change set');
  assert.equal(card().note, '', 'and what it says is as it was');

  // The agent hears what was turned, once; turned back to what it knew, there is nothing to tell.
  const told = host.tweaked();
  assert.match(told, /the person turned values you exposed: Days in a season \(DAYS in src\/seasons\.js\) from 30 to 45; The first season \(NAME in src\/seasons\.js\) from "Autumn" to "Winter"; Snow .* from false to true; Leaves .* from "#c84" to "#ffffff"\./);
  assert.equal(host.tweaked(), '');
  await me('code.tweak', { file, name: 'DAYS', value: 60 });
  await me('code.tweak', { file, name: 'DAYS', value: 45 });
  assert.equal(host.tweaked(), '');
  // Exposed again, what the agent had set is still what the card says it was; a value the agent set anew is its own.
  await agent('code.expose', { values: [{ label: 'Days', file, name: 'DAYS', min: 10, max: 90, step: 5 }, { label: 'Snow', file, name: 'SNOW' }] });
  assert.deepEqual(card().tweaks, [{ label: 'Days', file, name: 'DAYS', min: 10, max: 90, step: 5, kind: 'number', value: 45, was: 30 }, { label: 'Snow', file, name: 'SNOW', kind: 'boolean', value: true, was: false }]);
  writeFileSync(join(copy, file), readFileSync(join(copy, file), 'utf8').replace('DAYS = 45', 'DAYS = 20'));
  await agent('code.expose', { values: [{ label: 'Days', file, name: 'DAYS', min: 10, max: 90 }] });
  assert.deepEqual(card().tweaks, [{ label: 'Days', file, name: 'DAYS', min: 10, max: 90, kind: 'number', value: 20, step: 1 }]);
  // A value that is no longer written out is no longer on the card.
  writeFileSync(join(copy, file), readFileSync(join(copy, file), 'utf8').replace('DAYS = 20', 'DAYS = 4 * 5'));
  host.proposeCode('agent:main', '');
  assert.equal(card().tweaks, undefined);
  await refused(me('code.tweak', { file, name: 'DAYS', value: 30 }), 'missing');
  writeFileSync(join(copy, file), readFileSync(join(copy, file), 'utf8').replace('DAYS = 4 * 5', 'DAYS = 20'));

  // Accepted, the project has what the person set, the agent still hears of it, and the values go with the set.
  await me('code.tweak', { file, name: 'DAYS', value: 25 });
  await me('proposals.decide', { accept: true });
  assert.match(readFileSync(join(dir, file), 'utf8'), /DAYS = 25;.*\n.*'Winter';\n.*SNOW = true;/);
  assert.equal(git('log', '-1', '--format=%B').trim(), 'Accepted from the working copy\n\nSet by the person before accepting:\n- Days: 25, where the agent had 20 (DAYS in src/seasons.js)', 'and the commit says what they set');
  assert.ok(!existsSync(join(host.dirs.data, 'code-tweaks.json')));
  assert.match(host.tweaked(), /turned a value you exposed: Days \(DAYS in src\/seasons\.js\) from 20 to 25\. Your working copy has it so\./);
  await refused(me('code.tweak', { file, name: 'DAYS', value: 30 }), 'missing');
  // Rejected, what was turned is gone with the rest, and there is nothing to hear.
  writeFileSync(join(copy, file), readFileSync(join(copy, file), 'utf8').replace('DAYS = 25', 'DAYS = 26'));
  host.proposeCode('agent:main', 'A day more.');
  await agent('code.expose', { values: [{ label: 'Days', file, name: 'DAYS' }] });
  await me('code.tweak', { file, name: 'DAYS', value: 28.5 });
  await me('proposals.decide', { accept: false });
  assert.match(readFileSync(join(copy, file), 'utf8'), /DAYS = 25;/);
  assert.equal(host.tweaked(), '');
  assert.ok(!existsSync(join(host.dirs.data, 'code-tweaks.json')));
  assert.equal(git('status', '--porcelain'), '');
});

test('a concept and a change set that wait are one set: decided as one, and a change set that is undone leaves the rest waiting', async () => {
  const file = 'src/seasons.js';
  const was = readFileSync(join(copy, file), 'utf8');
  const waits = async () => (await me('proposals.list', { status: 'pending' })).map((p: any) => `${p.kind}:${p.path}`).sort();
  await host.run('concepts.create', { name: 'Long winters', text: 'Winter lasts.' }, 'agent:main', 'r70');
  writeFileSync(join(copy, file), `${was}// winter\n`);
  host.proposeCode('agent:main', 'Winter lasts.');
  assert.deepEqual(await waits(), ['code:working copy', 'concept:long-winters']);

  // The agent puts its copy back: only the change set is gone.
  const before = host.events.last();
  writeFileSync(join(copy, file), was);
  host.proposeCode('agent:main', '');
  assert.deepEqual(await waits(), ['concept:long-winters']);
  const gone = host.events.since(before).at(-1)!;
  assert.deepEqual([gone.type, gone.status, gone.paths, gone.left], ['proposal.decided', 'rejected', ['code:working copy'], 1]);

  // Rejected as one: the copy is the project again, and the concept is not there.
  writeFileSync(join(copy, file), `${was}// winter\n`);
  host.proposeCode('agent:main', 'Winter lasts.');
  assert.deepEqual(await me('proposals.decide', { accept: false }), { decided: 2 });
  assert.equal(readFileSync(join(copy, file), 'utf8'), was);
  await refused(me('concepts.get', { id: 'long-winters' }), 'missing');

  // Accepted as one: the code is the project's, the concept is in the document, and nothing is left uncommitted.
  await host.run('concepts.create', { name: 'Long winters', text: 'Winter lasts.' }, 'agent:main', 'r71');
  writeFileSync(join(copy, file), `${was}// winter\n`);
  host.proposeCode('agent:main', 'Winter lasts.');
  assert.deepEqual(await me('proposals.decide', { accept: true }), { decided: 2 });
  const said = host.events.since(before).filter((e) => e.type === 'proposal.decided').at(-1)!;
  assert.deepEqual([said.status, [...(said.paths as string[])].sort(), said.left], ['accepted', ['code:working copy', 'concept:long-winters'], 0]);
  assert.match(readFileSync(join(dir, file), 'utf8'), /\/\/ winter\n$/);
  assert.equal((await me('concepts.get', { id: 'long-winters' })).text, 'Winter lasts.');
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(await waits(), []);
  await me('concepts.remove', { id: 'long-winters' });
});

test('the agent gives the person an example of its change set to play: a page made in its scratchpad, beside the copy itself', async () => {
  // Where the project has no page there is nowhere to show one.
  await refused(host.run('code.example', { path: '/.tandem-scratch/example.html' }, 'agent:main'), 'unsupported');
  const fx = await fixture({ page: true });
  try {
    const work = fx.host.code!.work;
    const agent = (name: string, input?: Record<string, unknown>) => fx.host.run(name, input, 'agent:main') as Promise<any>;
    const card = () => fx.host.events.since(0).filter((e) => e.type === 'proposal').at(-1)! as any;
    const page = join(work, '.tandem-scratch/example.html');
    fx.host.code!.sync();
    writeFileSync(join(work, 'src/rules.js'), `${readFileSync(join(work, 'src/rules.js'), 'utf8')}\nexport const LATE = 1;\n`);
    fx.host.proposeCode('agent:main', 'A rule for late in the year.');
    // A page of the copy's own, and one that is there.
    await refused(agent('code.example', { path: '//elsewhere.example/' }), 'input');
    await refused(agent('code.example', { path: '/.tandem-scratch/../../outside.html' }), 'input');
    await refused(agent('code.example', { path: '/.tandem-scratch/example.html' }), 'missing');
    mkdirSync(join(work, '.tandem-scratch'), { recursive: true });
    writeFileSync(page, '<script type="module">import { LATE } from "/src/rules.js"; document.body.append(String(LATE));</script>\n');
    const got = await agent('code.example', { path: '.tandem-scratch/example.html?case=late', text: ' the new rule, late in the year ' });
    assert.equal(got.path, '/.tandem-scratch/example.html?case=late', 'named as the file is, it is the page the copy serves');
    assert.deepEqual(card().example, { path: '/.tandem-scratch/example.html?case=late', text: 'the new rule, late in the year' });
    // It is not part of the change set: the scratchpad never is.
    assert.deepEqual(((await fx.host.run('code.changes', {}, 'me')) as any).files.map((f: any) => f.path), ['src/rules.js']);
    // A page that is gone is not offered; back, it is again. A path the project has for it is taken as it is.
    rmSync(page);
    fx.host.proposeCode('agent:main', '');
    assert.equal(card().example, undefined);
    writeFileSync(page, '<p>late</p>\n');
    fx.host.proposeCode('agent:main', '');
    assert.equal(card().example.path, '/.tandem-scratch/example.html?case=late');
    await agent('code.example', { path: '/?debug=late' });
    assert.deepEqual(card().example, { path: '/?debug=late' });
    // A turn that ends with values to turn and no example to judge them on: the agent is asked for one, once.
    await agent('code.example', {});
    const asked = () => fx.host.events.since(0).filter((e) => e.type === 'message' && e.by === 'engine' && e.kind === 'example');
    fx.host.turnOver();
    assert.equal(asked().length, 0, 'nothing to turn, nothing to ask');
    const exposed = await agent('code.expose', { values: [{ label: 'How late', file: 'src/rules.js', name: 'LATE', min: 0, max: 9 }] });
    assert.match(exposed.next, /before you answer, make the example/);
    await refused(agent('code.expose', { values: [{ label: 'x'.repeat(81), file: 'src/rules.js', name: 'LATE' }] }), 'input');
    fx.host.turnOver();
    assert.equal(asked().length, 1);
    assert.match(String(asked()[0].text), /gives the person a value to turn \(How late\), but no example to judge it on.*code\.example/s);
    fx.host.turnOver();
    assert.equal(asked().length, 1, 'once for a change set');
    assert.equal((await agent('code.expose', { values: [{ label: 'How late', file: 'src/rules.js', name: 'LATE' }] })).next !== undefined, true);
    await agent('code.example', { path: '/?debug=late' });
    assert.equal((await agent('code.expose', { values: [{ label: 'How late', file: 'src/rules.js', name: 'LATE' }] })).next, undefined, 'with an example there is nothing left to do');
    // Taken away, and gone with the change set.
    assert.deepEqual(await agent('code.example', {}), { example: false });
    assert.equal(card().example, undefined);
    await agent('code.example', { path: '/.tandem-scratch/example.html' });
    assert.ok(existsSync(join(fx.host.dirs.data, 'code-example.json')));
    await fx.host.run('proposals.decide', { accept: false }, 'me');
    assert.ok(!existsSync(join(fx.host.dirs.data, 'code-example.json')));
    assert.ok(!existsSync(join(fx.host.dirs.data, 'code-example-asked')), 'the next change set is asked about anew');
  } finally { for (const stop of fx.host.onStop) stop(); fx.cleanup(); }
});

test('the engine tells the agent when art was accepted; the drawing reaches its copy, and is not built for it', async () => {
  const tiny = 'k = #1a1c2c\n\n@size 8 8\n@rect 1 1 6 6 k\n';
  await host.run('art.set', { name: 'garden-sign', text: tiny }, 'agent:main', 'r90');
  const before = answers().length;
  await me('proposals.decide', { accept: true });
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
  await me('proposals.decide', { accept: false }).catch(() => {});
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
    await me('proposals.decide', { accept: true });
    assert.equal(readFileSync(ran, 'utf8').trim(), `${dir}: install`, 'in the project, not in the copy');
    assert.equal(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.installed, true);
    assert.equal(git('status', '--porcelain'), '');
    // Installing writes a lockfile in the project. That is the engine's own writing, so it commits it: left there
    // it would look like the person's work, and stand in the way of a change set that brings a lockfile of its own.
    writeFileSync(npm, `#!/bin/sh\necho '{ "lock": "of the project" }' > package-lock.json\n`, { mode: 0o755 });
    writeFileSync(join(copy, 'package.json'), '{"name":"fixture","dependencies":{"left-pad":"1.3.1"}}\n');
    host.proposeCode('agent:main', 'A newer left-pad.');
    await me('proposals.decide', { accept: true });
    assert.equal(git('status', '--porcelain'), '', 'the lockfile is not left lying there');
    assert.match(git('log', '--oneline', '-1'), /What installing what the project depends on wrote/);
    writeFileSync(join(copy, 'package.json'), '{"name":"fixture","dependencies":{"left-pad":"1.3.2"}}\n');
    writeFileSync(join(copy, 'package-lock.json'), '{ "lock": "of the copy" }\n');
    writeFileSync(npm, '#!/bin/sh\n', { mode: 0o755 });
    host.proposeCode('agent:main', 'A newer one still, installed in the copy.');
    await me('proposals.decide', { accept: true });
    assert.equal(readFileSync(join(dir, 'package-lock.json'), 'utf8'), '{ "lock": "of the copy" }\n', 'so the copy\'s lockfile goes in');
    // A lockfile the person is changing themselves is theirs: installing does not commit it for them.
    writeFileSync(join(dir, 'package-lock.json'), '{ "lock": "mine, by hand" }\n');
    writeFileSync(join(copy, 'package.json'), '{"name":"fixture","dependencies":{"left-pad":"1.3.0"}}\n');
    host.proposeCode('agent:main', 'Back to the first left-pad.');
    await me('proposals.decide', { accept: true });
    assert.equal(git('status', '--porcelain').trim(), 'M package-lock.json', 'theirs is left as it is');
    git('checkout', '--', 'package-lock.json');
    // A change set that leaves package.json alone installs nothing; and when it fails, the accept stands and it is said.
    rmSync(ran);
    writeFileSync(npm, '#!/bin/sh\necho "npm ERR! no such package" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(copy, 'src/more.js'), 'export const MORE = 1;\n');
    host.proposeCode('agent:main', 'More.');
    await me('proposals.decide', { accept: true });
    assert.ok(!existsSync(ran));
    assert.equal(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.installed, undefined);
    writeFileSync(join(copy, 'package.json'), '{"name":"fixture","dependencies":{"nope":"9.9.9"}}\n');
    host.proposeCode('agent:main', 'It depends on nope now.');
    await me('proposals.decide', { accept: true });
    assert.equal(host.events.since(0).filter((e) => e.type === 'code.changed').at(-1)!.installed, 'npm ERR! no such package');
    assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /nope/, 'accepted all the same');
  } finally { delete process.env.TANDEM_NPM; }
});

test('a change set is accepted only when the whole of the tests pass in the copy; when they fail, the agent is told', async () => {
  writeFileSync(join(copy, 'src/broken.test.js'), "import { test } from 'node:test';\ntest('frost', () => { throw new Error('frost is not cold'); });\n");
  host.proposeCode('agent:main', 'Frost, with a test that fails.');
  const before = answers().length;
  await refused(me('proposals.decide', { accept: true }), 'failed');
  assert.ok(!existsSync(join(dir, 'src/broken.test.js')), 'not accepted');
  assert.equal((await me('proposals.list', { status: 'pending' })).length, 1, 'it still waits');
  assert.deepEqual([host.events.since(0).filter((e) => e.type === 'code.tested').at(-1)!.ok, host.events.since(0).filter((e) => e.type === 'code.tested').at(-1)!.command], [false, 'node --test']);
  const told = host.events.since(0).filter((e) => e.type === 'message' && e.by === 'engine' && e.kind === 'tests').at(-1)!;
  assert.match(String(told.text), /`node --test` failed in your working copy, so it was not accepted[\s\S]*frost is not cold/);
  await until(() => answers().length === before + 1, 'the agent to answer the engine');
  await idle();

  writeFileSync(join(copy, 'src/broken.test.js'), "import { test } from 'node:test';\ntest('frost', () => {});\n");
  host.proposeCode('agent:main', 'Frost, with a test that passes.');
  await me('proposals.decide', { accept: true });
  assert.ok(existsSync(join(dir, 'src/broken.test.js')), 'accepted');
  assert.deepEqual(host.events.since(0).filter((e) => e.type === 'code.tested').at(-1)!.commands, ['node --test', 'node check.mjs']);
  assert.equal(s.runner!.status().testing, false);
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

  await me('proposals.decide', { accept: true });
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
  await me('proposals.decide', { accept: true });
  assert.equal(git('log', '-1', '--format=%B'), 'Tidied up.');
  await refused(me('concepts.history', { id: 'no-such-thing' }), 'missing');
});

test('the agent may run a script of its own from its scratchpad, and nothing typed straight into the command line', () => {
  const { allow, deny } = tools(host);
  assert.ok(!allow.some((r) => /^Bash\((gh|git push)/.test(r)), 'pushing and the remote are not the agent\'s: tandem pushes, to where the person said');
  for (const rule of ['Write(.tandem-scratch/**)', 'Edit(.tandem-scratch/**)', 'Bash(node .tandem-scratch/*)', 'Bash(node --test .tandem-scratch/*)', 'Bash(python3 .tandem-scratch/*)'])
    assert.ok(allow.includes(rule), rule);
  // An interpreter by itself is not allowed: only with a file from the scratchpad after it.
  assert.ok(!allow.some((r) => /^Bash\((python3?|node|sh|bash)(:\*)?\)$/.test(r)));
  assert.ok(deny.includes('Write(.tandem/**)'), 'tandem\'s own folder stays out of reach');
  // What a project depends on it may install, also in the turn in which it writes the package.json: exactly that, nothing after it.
  for (const rule of ['Bash(npm install)', 'Bash(npm ci)']) assert.ok(allow.includes(rule), rule);
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
    await me('proposals.decide', { accept: true });
    assert.equal(git('status', '--porcelain'), '', 'what the engine wrote for it is committed');
    assert.equal(there(), git('rev-parse', 'HEAD'), 'and the remote has it');
    const pushed = host.events.since(before).filter((e) => e.type === 'project.pushed').at(-1)!;
    assert.deepEqual([pushed.ok, pushed.remote, pushed.branch], [true, 'origin', 'main']);
    // Refusing something pushes nothing.
    const n = host.events.since(0).filter((e) => e.type === 'project.pushed').length;
    await host.run('concepts.create', { name: 'Not this one' }, 'agent:main', 'r96');
    await me('proposals.decide', { accept: false });
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

test('a project that is not committed for gets what is accepted in its files, uncommitted, and is not pushed', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'tandem-remote-'));
  const files = async () => (await me('code.changes')).files.map((f: any) => `${f.status} ${f.path}`);
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await me('project.setRemote', { url: bare });
    const head = git('rev-parse', 'HEAD');
    const pushes = () => host.events.since(0).filter((e) => e.type === 'project.pushed').length;
    const pushed = pushes();
    await assert.rejects(host.run('project.keep', { commit: false }, 'agent:main', 'r1'), /the person's to do/);
    assert.deepEqual(await me('project.keep', { commit: false }), { changed: true, commit: false, push: true });
    assert.deepEqual(await me('project.keep', { commit: false }), { changed: false, commit: false, push: true });
    assert.equal((await me('project.setup')).config.commit, false, 'kept with how the project is run');
    assert.match(readFileSync(host.project.configFile, 'utf8'), /"commit": false/);

    // The copy follows the project's files as they are: what the person has not committed is in it, and is not its change.
    writeFileSync(join(dir, 'notes.txt'), 'mine\n');
    host.code!.sync();
    assert.equal(readFileSync(join(copy, 'notes.txt'), 'utf8'), 'mine\n');
    assert.deepEqual(await files(), []);
    assert.equal(git('rev-parse', 'HEAD'), head, 'and nothing was committed for that');
    assert.equal(git('diff', '--cached', '--name-only'), '', 'nor put in the person\'s index');

    // Accepted, the change set is in the project's files and left there.
    writeFileSync(join(copy, 'src/weather.js'), 'export const RAIN = 1;\n');
    host.proposeCode('agent:main', 'Weather.');
    assert.deepEqual(await files(), ['new src/weather.js']);
    // (What was accepted before is told to the agent: an accept waits for its turn to be over.)
    await idle();
    await me('proposals.decide', { accept: true });
    assert.equal(readFileSync(join(dir, 'src/weather.js'), 'utf8'), 'export const RAIN = 1;\n');
    assert.equal(git('rev-parse', 'HEAD'), head, 'not committed');
    assert.match(git('status', '--porcelain', '-uall'), /^\?\? src\/weather\.js$/m, 'it is the person\'s to commit');
    assert.deepEqual(await files(), [], 'and the copy is the project again');
    assert.equal(pushes(), pushed, 'nothing is pushed');

    // The next one goes on top of what is still uncommitted, and on top of what the person changed since.
    writeFileSync(join(dir, 'notes.txt'), 'mine, more\n');
    writeFileSync(join(copy, 'src/weather.js'), 'export const RAIN = 2;\n');
    host.proposeCode('agent:main', 'More rain.');
    assert.deepEqual(await files(), ['changed src/weather.js']);
    await me('proposals.decide', { accept: true });
    assert.equal(readFileSync(join(dir, 'src/weather.js'), 'utf8'), 'export const RAIN = 2;\n');
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine, more\n', 'the person\'s own work is as they left it');
    assert.equal(readFileSync(join(copy, 'notes.txt'), 'utf8'), 'mine, more\n');

    // What the engine writes itself is not committed either.
    await host.run('concepts.create', { name: 'Left alone', text: 'Not committed.' }, 'agent:main', 'r97');
    await me('proposals.decide', { accept: true });
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(pushes(), pushed);

    // Rejected, the copy is the project as it is, uncommitted work and all.
    writeFileSync(join(copy, 'src/weather.js'), 'export const RAIN = 3;\n');
    host.proposeCode('agent:main', 'Too much rain.');
    await me('proposals.decide', { accept: false });
    assert.equal(readFileSync(join(copy, 'src/weather.js'), 'utf8'), 'export const RAIN = 2;\n');

    // The person commits when they want to, and the copy follows without a change set of its own.
    await me('concepts.remove', { id: 'left-alone' });
    git('add', '-A');
    git('-c', 'user.name=Me', '-c', 'user.email=me@example.com', 'commit', '-q', '-m', 'Weather, by hand');
    host.code!.sync();
    assert.deepEqual(await files(), []);
    assert.equal(git('log', '-1', '--format=%ae'), 'me@example.com');

    // Only not pushing: it is committed as before, and stays here.
    assert.deepEqual(await me('project.keep', { commit: true, push: false }), { changed: true, commit: true, push: false });
    writeFileSync(join(copy, 'src/weather.js'), 'export const RAIN = 4;\n');
    host.proposeCode('agent:main', 'A storm.');
    assert.deepEqual(await files(), ['changed src/weather.js']);
    await idle();
    await me('proposals.decide', { accept: true });
    assert.notEqual(git('rev-parse', 'HEAD'), head);
    assert.equal(git('status', '--porcelain'), '', 'committed');
    assert.equal(pushes(), pushed, 'not pushed');
    assert.deepEqual(await me('project.keep', { push: true }), { changed: true, commit: true, push: true });
    assert.doesNotMatch(readFileSync(host.project.configFile, 'utf8'), /commit|push/, 'only a no is written down');
  } finally {
    await me('project.keep', { commit: true, push: true });
    await me('project.setRemote', { url: '' });
    await idle();
    rmSync(bare, { recursive: true, force: true });
  }
});

test('version control from the page: what is not committed is read and committed as the person, and pushed when they say', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'tandem-remote-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git('config', 'user.name', 'Me');
    git('config', 'user.email', 'me@example.com');
    await me('project.keep', { commit: false });
    await me('project.setRemote', { url: bare });
    // (That nothing is committed for it is written in tandem's own file, and that is then the person's to commit too.)
    assert.deepEqual((await me('git.status')).files.map((f: any) => f.path), ['.tandem/tandem.json']);
    git('commit', '-q', '-am', 'How tandem keeps it');
    const clean = await me('git.status');
    assert.deepEqual([clean.git, clean.branch, clean.files, clean.commit, clean.push], [true, 'main', [], false, true]);
    assert.deepEqual(clean.remote, { name: 'origin', url: bare });
    assert.deepEqual(clean.who, { name: 'Me', email: 'me@example.com' });
    assert.equal(clean.ahead, undefined, 'what the remote has is not known: nothing was pushed there');

    // What is not committed: a file that is new, one that changed, one with a name git would put in quotes.
    writeFileSync(join(dir, 'src/tide.js'), 'export const TIDE = 1;\nexport const EBB = 0;\n');
    writeFileSync(join(dir, 'src/seasons.js'), readFileSync(join(dir, 'src/seasons.js'), 'utf8') + 'export const FIFTH = 1;\n');
    writeFileSync(join(dir, 'a note.txt'), 'kept apart\n');
    const now = await me('git.status');
    assert.deepEqual(now.files, [
      { path: 'a note.txt', added: 1, removed: 0, status: 'new' },
      { path: 'src/seasons.js', added: 1, removed: 0, status: 'changed' },
      { path: 'src/tide.js', added: 2, removed: 0, status: 'new' },
    ]);
    assert.match((await me('git.diff', { path: 'src/seasons.js' })).diff, /^\+export const FIFTH = 1;$/m);
    assert.match((await me('git.diff', { path: 'src/tide.js' })).diff, /\+export const TIDE = 1;/, 'also of a file git does not follow yet');
    await refused(me('git.diff', { path: '../elsewhere' }), 'input');
    await refused(me('git.diff', { path: '--output=x' }), 'input');

    // Committing is the person's: under their own name, the files they say, and the rest stays as it is.
    await assert.rejects(host.run('git.commit', { message: 'Mine now' }, 'agent:main', 'r1'), /the person's to do/);
    await assert.rejects(host.run('git.push', {}, 'agent:main', 'r1'), /the person's to do/);
    await refused(me('git.commit', { message: '  ' }), 'input');
    const made = await me('git.commit', { message: 'Tides and a fifth season', paths: ['src/tide.js', 'src/seasons.js'] });
    assert.deepEqual([made.subject, made.files], ['Tides and a fifth season', 2]);
    assert.equal(git('log', '-1', '--format=%an <%ae> %s'), 'Me <me@example.com> Tides and a fifth season');
    assert.equal(git('status', '--porcelain'), '?? "a note.txt"');
    assert.deepEqual(host.events.since(0).at(-1), { ...host.events.since(0).at(-1), type: 'project.committed', by: 'me', subject: 'Tides and a fifth season', files: 2 });
    const after = await me('git.status');
    assert.deepEqual(after.files.map((f: any) => f.path), ['a note.txt']);
    assert.deepEqual([after.commits[0].subject, after.commits[0].by, after.commits[0].pushed], ['Tides and a fifth season', 'Me', false]);

    // Pushed when they say so, and then the remote has it.
    assert.deepEqual(await me('git.push'), { pushed: true, remote: 'origin', branch: 'main' });
    assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'));
    const pushed = await me('git.status');
    assert.deepEqual([pushed.ahead, pushed.commits[0].pushed], [0, true]);
    assert.deepEqual(await me('git.push'), { pushed: false, says: 'the remote has everything already' });

    // A change is thrown away per file: what changed is as it was committed, what was new is gone, what was taken away is back.
    await assert.rejects(host.run('git.discard', { path: 'a note.txt' }, 'agent:main', 'r1'), /the person's to do/);
    writeFileSync(join(dir, 'src/tide.js'), 'export const TIDE = 9;\n');
    writeFileSync(join(dir, 'src/scrap.js'), 'export const SCRAP = 1;\n');
    rmSync(join(dir, 'src/seasons.js'));
    assert.deepEqual((await me('git.status')).files.map((f: any) => `${f.status} ${f.path}`), ['new a note.txt', 'new src/scrap.js', 'gone src/seasons.js', 'changed src/tide.js']);
    assert.deepEqual(await me('git.discard', { path: 'src/tide.js' }), { path: 'src/tide.js', was: 'changed' });
    assert.equal(readFileSync(join(dir, 'src/tide.js'), 'utf8'), 'export const TIDE = 1;\nexport const EBB = 0;\n');
    await me('git.discard', { path: 'src/scrap.js' });
    assert.ok(!existsSync(join(dir, 'src/scrap.js')));
    await me('git.discard', { path: 'src/seasons.js' });
    assert.match(readFileSync(join(dir, 'src/seasons.js'), 'utf8'), /FIFTH/);
    assert.equal(git('status', '--porcelain'), '?? "a note.txt"', 'the rest is as it was');
    assert.equal(host.events.since(0).at(-1)!.type, 'project.discarded');
    await refused(me('git.discard', { path: 'src/tide.js' }), 'input');
    await refused(me('git.discard', { path: '../elsewhere' }), 'input');
    // Very many files git does not follow, in one folder: the folder is one line, and is thrown away as one.
    mkdirSync(join(dir, 'heap/deep'), { recursive: true });
    for (let n = 0; n < 320; n++) writeFileSync(join(dir, 'heap', n % 2 ? 'deep' : '.', `f${n}.txt`), 'x\n');
    assert.deepEqual((await me('git.status')).files.map((f: any) => `${f.status} ${f.path}`), ['new a note.txt', 'new heap/']);
    assert.equal((await me('git.diff', { path: 'heap/' })).diff, '');
    assert.deepEqual(await me('git.discard', { path: 'heap/' }), { path: 'heap/', was: 'new' });
    assert.ok(!existsSync(join(dir, 'heap')));
    // Several at once; one that cannot be, and nothing is thrown away.
    writeFileSync(join(dir, 'src/tide.js'), 'export const TIDE = 9;\n');
    writeFileSync(join(dir, 'src/scrap.js'), 'export const SCRAP = 1;\n');
    await refused(me('git.discard', { paths: ['src/tide.js', 'src/nothing.js'] }), 'input');
    await refused(me('git.discard', {}), 'input');
    assert.ok(existsSync(join(dir, 'src/scrap.js')) && /TIDE = 9/.test(readFileSync(join(dir, 'src/tide.js'), 'utf8')));
    assert.deepEqual(await me('git.discard', { paths: ['src/tide.js', 'src/scrap.js'] }), { discarded: ['src/tide.js', 'src/scrap.js'] });
    assert.equal(git('status', '--porcelain'), '?? "a note.txt"');
    assert.equal(host.events.since(0).at(-1)!.count, 2);

    // The branches of the repository, the one it is on first; the agent's own is not one of them.
    git('branch', 'side', 'HEAD~1');
    const tree = await me('git.status');
    assert.deepEqual(tree.branches.map((b: any) => [b.name, b.current]), [['main', true], ['side', false]]);
    assert.deepEqual([tree.branches[0].follows, tree.branches[0].subject], ['origin/main', 'Tides and a fifth season']);
    assert.equal(tree.behind, 0);
    // Switching branch: not with something uncommitted, not to the agent's own branch, and the copy goes along.
    await assert.rejects(host.run('git.switch', { branch: 'side' }, 'agent:main', 'r1'), /the person's to do/);
    await assert.rejects(me('git.switch', { branch: 'side' }), /1 file is not committed/);
    await refused(me('git.switch', { branch: 'tandem-agent' }), 'failed');
    await refused(me('git.switch', { branch: 'no-such' }), 'failed');
    git('stash', '-u', '-q');
    await assert.rejects(me('git.switch', { branch: 'main' }), /on main already/);
    assert.deepEqual(await me('git.switch', { branch: 'side' }), { from: 'main', branch: 'side' });
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'side');
    assert.ok(!existsSync(join(dir, 'src/tide.js')) && !existsSync(join(copy, 'src/tide.js')), 'the project and the copy are that branch');
    assert.deepEqual((await me('code.changes')).files, []);
    assert.deepEqual([host.events.since(0).at(-1)!.type, host.events.since(0).at(-1)!.branch], ['project.switched', 'side']);
    // With a change set of the agent's waiting, it stays where it is.
    writeFileSync(join(copy, 'src/side.js'), 'export const SIDE = 1;\n');
    host.proposeCode('agent:main', 'On the side.');
    await refused(me('git.switch', { branch: 'main' }), 'busy');
    await me('proposals.decide', { accept: false });
    await me('git.switch', { branch: 'main' });
    assert.ok(existsSync(join(copy, 'src/tide.js')));
    git('stash', 'pop', '-q');
    git('branch', '-D', 'side');

    // Pulling takes in what the remote has more, forward only; the agent does not do it.
    await assert.rejects(host.run('git.pull', {}, 'agent:main', 'r1'), /the person's to do/);
    assert.deepEqual(await me('git.pull'), { pulled: true, remote: 'origin', branch: 'main', commits: 0 });
    const other = mkdtempSync(join(tmpdir(), 'tandem-other-'));
    const there = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', ...args], { cwd: other, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['clone', '-q', bare, other]);
    writeFileSync(join(other, 'from-elsewhere.txt'), 'hello\n');
    there('add', '-A'); there('commit', '-q', '-m', 'From elsewhere'); there('push', '-q');
    assert.deepEqual(await me('git.pull'), { pulled: true, remote: 'origin', branch: 'main', commits: 1 });
    assert.equal(readFileSync(join(dir, 'from-elsewhere.txt'), 'utf8'), 'hello\n');
    assert.equal(git('status', '--porcelain'), '?? "a note.txt"', 'what was not committed is as it was');
    assert.deepEqual([host.events.since(0).at(-1)!.type, host.events.since(0).at(-1)!.commits], ['project.pulled', 1]);
    // Both went their own way: nothing is merged here, and it says so.
    writeFileSync(join(other, 'from-elsewhere.txt'), 'hello again\n');
    there('commit', '-q', '-am', 'More from elsewhere'); there('push', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'Mine meanwhile');
    const apart = await me('git.pull');
    assert.deepEqual([apart.pulled, apart.commits], [false, 0]);
    assert.match(apart.says, /main has commits here that origin does not have, and origin has others/);
    assert.equal(git('log', '-1', '--format=%s'), 'Mine meanwhile', 'the project is as it was');
    git('reset', '-q', '--hard', 'HEAD~1');
    // Fetching only asks: the project is as it was, and how far behind it is, is known.
    await assert.rejects(host.run('git.fetch', {}, 'agent:main', 'r1'), /the person's to do/);
    const at = git('rev-parse', 'HEAD');
    assert.deepEqual(await me('git.fetch'), { fetched: true, remote: 'origin', ahead: 0, behind: 1 });
    assert.equal(git('rev-parse', 'HEAD'), at);
    assert.equal((await me('git.status')).behind, 1);
    assert.equal((await me('git.pull')).commits, 1);
    // A branch that is only on the remote is listed once it was fetched, and switching to it makes it a branch here.
    there('switch', '-q', '-c', 'feature/elsewhere');
    writeFileSync(join(other, 'only-there.txt'), 'x\n');
    there('add', '-A'); there('commit', '-q', '-m', 'Only there'); there('push', '-q', '-u', 'origin', 'feature/elsewhere');
    assert.ok(!(await me('git.status')).branches.some((b: any) => b.name === 'feature/elsewhere'), 'not known before it is fetched');
    await me('git.fetch');
    const far = (await me('git.status')).branches.find((b: any) => b.name === 'feature/elsewhere');
    assert.deepEqual([far.remote, far.current, far.subject], ['origin', false, 'Only there']);
    assert.ok(!(await me('git.status')).branches.some((b: any) => b.name === 'main' && b.remote), 'a branch that is here is not listed twice');
    git('stash', '-u', '-q');
    assert.deepEqual(await me('git.switch', { branch: 'feature/elsewhere' }), { from: 'main', branch: 'feature/elsewhere' });
    assert.equal(readFileSync(join(dir, 'only-there.txt'), 'utf8'), 'x\n');
    const mine = (await me('git.status')).branches.find((b: any) => b.name === 'feature/elsewhere');
    assert.deepEqual([mine.current, mine.follows, mine.remote], [true, 'origin/feature/elsewhere', undefined]);
    await me('git.switch', { branch: 'main' });
    git('stash', 'pop', '-q');
    git('branch', '-D', 'feature/elsewhere');
    rmSync(other, { recursive: true, force: true });

    // Everything that is left, without naming it.
    assert.equal((await me('git.commit', { message: 'The note' })).files, 1);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal((await me('git.status')).ahead, 1);
    await refused(me('git.commit', { message: 'Nothing' }), 'failed');
    // The copy follows: what the person committed is not a change set of the agent's.
    host.code!.sync();
    assert.deepEqual((await me('code.changes')).files, []);
    assert.equal(readFileSync(join(copy, 'src/tide.js'), 'utf8'), 'export const TIDE = 1;\nexport const EBB = 0;\n');
  } finally {
    await me('project.setRemote', { url: '' });
    await me('project.keep', { commit: true, push: true });
    await idle();
    rmSync(bare, { recursive: true, force: true });
  }
});

test('a project that has no page yet is played from the copy, once its change set brings one', async () => {
  const card = () => host.events.since(0).filter((e) => e.type === 'proposal').at(-1)! as any;
  writeFileSync(join(copy, 'index.html'), '<h1>Fixture</h1>\n');
  host.proposeCode('agent:main', 'A page.');
  assert.equal(card().plays, undefined, 'nothing starts a page yet');
  await refused(me('code.play'), 'unsupported');
  await refused(me('code.restart'), 'unsupported');
  // The change set brings what tandem starts by itself: its copy has a page, the project still has none.
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0' } }));
  host.proposeCode('agent:main', 'A page.');
  assert.equal(card().plays, true);
  assert.equal(host.project.pageCommand(5000), undefined);
  assert.equal(host.project.at(copy).pageCommand(5000), 'npm run dev -- --port 5000 --strictPort --host 127.0.0.1');
  await me('proposals.decide', { accept: false });
  assert.ok(!existsSync(join(copy, 'index.html')), 'rejected, the copy is the project again');
});
