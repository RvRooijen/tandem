// Working files and project files: the working copy the agent codes in, what
// it differs from the project, and how it goes in or is thrown away. On a
// small repository made for the test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCode } from '../core/code.ts';

const root = mkdtempSync(join(tmpdir(), 'tandem-code-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' }).trim();
const put = (path: string, text: string, base = root) => { mkdirSync(join(base, path, '..'), { recursive: true }); writeFileSync(join(base, path), text); };
const read = (path: string, base = root) => readFileSync(join(base, path), 'utf8');

git('init', '-q', '-b', 'main');
put('games/g/src/rules.ts', 'export const speed = 1;\n');
put('.tandem/concepts/roses.md', 'Roses.\n');
put('core/engine.ts', 'export const engine = true;\n');
put('.gitignore', 'node_modules/\n');
mkdirSync(join(root, 'node_modules'));
git('add', '-A');
git('commit', '-q', '-m', 'start');

// What the engine itself writes in a project: tandem's own folder, and the drawings.
const code = createCode({ root, paths: ['.tandem/concepts', 'art'] });

test('the working copy is the project, somewhere else, with the project\'s dependencies', () => {
  assert.equal(code.usable(), true);
  assert.deepEqual(code.changes(), [], 'before there is one, nothing differs');
  assert.deepEqual(code.sync(), { conflicts: [] });
  assert.equal(read('games/g/src/rules.ts', code.work), 'export const speed = 1;\n');
  assert.ok(existsSync(join(code.work, 'node_modules')), 'it runs with the project\'s node_modules');
  assert.deepEqual(code.changes(), []);
});

test('what the copy changes is one change set; the project is untouched until it is accepted', () => {
  put('games/g/src/rules.ts', 'export const speed = 2;\nexport const seasons = 4;\n', code.work);
  put('games/g/src/seasons.ts', 'export const names = ["spring"];\n', code.work);
  assert.deepEqual(code.changes(), [
    { path: 'games/g/src/rules.ts', added: 2, removed: 1, status: 'changed' },
    { path: 'games/g/src/seasons.ts', added: 1, removed: 0, status: 'new' },
  ]);
  assert.match(code.diff('games/g/src/rules.ts'), /\+export const seasons = 4;/);
  assert.equal(read('games/g/src/rules.ts'), 'export const speed = 1;\n');
  assert.ok(!existsSync(join(root, 'games/g/src/seasons.ts')));

  // Meanwhile a concept changes in the project, through the engine, and the person is in the middle of something of
  // their own. The copy takes the concept in; the person's unfinished work is left exactly as it is.
  put('.tandem/concepts/roses.md', 'Roses, with thorns.\n');
  put('notes.txt', 'half a thought\n');
  assert.deepEqual(code.sync(), { conflicts: [] });
  assert.equal(read('.tandem/concepts/roses.md', code.work), 'Roses, with thorns.\n');
  assert.ok(!existsSync(join(code.work, 'notes.txt')), 'what the person has not committed is not the engine\'s to commit');
  assert.equal(git('status', '--porcelain').trim(), '?? notes.txt');
  assert.equal(code.changes().length, 2, 'what the project changed is not the copy\'s change');
  assert.match(git('log', '--oneline', '-1'), /What was changed and accepted in tandem/, 'and the engine\'s change is in the project\'s history');

  const taken = code.accept('Seasons: four of them');
  assert.equal(taken.length, 2);
  assert.equal(read('games/g/src/rules.ts'), 'export const speed = 2;\nexport const seasons = 4;\n');
  assert.equal(read('games/g/src/seasons.ts'), 'export const names = ["spring"];\n');
  assert.match(git('log', '--oneline', '-3'), /Seasons: four of them/);
  assert.deepEqual(code.changes(), [], 'accepted: the copy and the project are the same again');
  assert.equal(git('status', '--porcelain').trim(), '?? notes.txt');
  rmSync(join(root, 'notes.txt'));
});

test('a copy that has not caught up with the project did not undo what the project gained', () => {
  // The project moves on, by somebody else's hand; the copy has not been brought up to date yet.
  put('games/g/src/weather.ts', 'export const rain = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Weather');
  assert.deepEqual(code.changes(), [], 'the copy changed nothing');
  put('games/g/src/seasons.ts', 'export const names = ["spring", "winter"];\n', code.work);
  assert.deepEqual(code.changes().map((c) => c.path), ['games/g/src/seasons.ts'], 'only its own change is its change');
  assert.doesNotMatch(code.diff(), /weather/);
  // Brought up to date, it has the weather too, and its change is still only its own.
  assert.deepEqual(code.sync(), { conflicts: [] });
  assert.equal(read('games/g/src/weather.ts', code.work), 'export const rain = true;\n');
  assert.deepEqual(code.changes().map((c) => c.path), ['games/g/src/seasons.ts']);
  code.reject();
});

test('rejected, the copy is the project again', () => {
  put('games/g/src/rules.ts', 'export const speed = 99;\n', code.work);
  put('games/g/src/junk.ts', 'x\n', code.work);
  assert.equal(code.changes().length, 2);
  code.reject();
  assert.deepEqual(code.changes(), []);
  assert.ok(!existsSync(join(code.work, 'games/g/src/junk.ts')));
  assert.equal(read('games/g/src/rules.ts', code.work), 'export const speed = 2;\nexport const seasons = 4;\n');
  assert.ok(existsSync(join(code.work, 'node_modules')), 'its dependencies are not thrown out with it');
});

test('when the project and the copy changed the same lines, it says so and breaks nothing', () => {
  put('games/g/src/rules.ts', 'export const speed = 3;\nexport const seasons = 4;\n', code.work);
  put('games/g/src/rules.ts', 'export const speed = 7;\nexport const seasons = 4;\n');
  git('commit', '-q', '-am', 'Faster, by hand');
  assert.deepEqual(code.sync(), { conflicts: ['games/g/src/rules.ts'] });
  assert.equal(read('games/g/src/rules.ts', code.work), 'export const speed = 3;\nexport const seasons = 4;\n', 'the copy still has its own work');
  assert.throws(() => code.accept('Faster'), /does not go into the project cleanly: the project changed games\/g\/src\/rules\.ts too/);
  assert.equal(read('games/g/src/rules.ts'), 'export const speed = 7;\nexport const seasons = 4;\n', 'and the project is as it was');
  assert.equal(git('status', '--porcelain'), '');
  code.reject();
  assert.deepEqual(code.changes(), []);
});

test('the person\'s own unfinished work in a file is never overwritten, reset or committed for them', () => {
  code.sync();
  put('games/g/src/rules.ts', 'export const speed = 8;\nexport const seasons = 4;\n', code.work);
  // The person is in the middle of changing the same file, and has not committed it.
  put('games/g/src/rules.ts', 'export const speed = 7;\nexport const seasons = 4;\n// thinking about winter\n');
  assert.deepEqual(code.sync(), { conflicts: [] }, 'what is not committed is not the project yet, so there is nothing to take in');
  assert.throws(() => code.accept('Faster still'), /you have changes of your own in games\/g\/src\/rules\.ts that are not committed/);
  assert.equal(read('games/g/src/rules.ts'), 'export const speed = 7;\nexport const seasons = 4;\n// thinking about winter\n', 'their work is exactly as they left it');
  assert.equal(git('status', '--porcelain').trim(), 'M games/g/src/rules.ts');
  assert.equal(code.changes().length, 1, 'and the copy still has its change, to accept later');
  // Once they have committed it, the copy has to catch up with them first.
  git('commit', '-q', '-am', 'Winter thoughts');
  code.reject();
});

test('files of the engine that are being worked on in the project do not stop a change to the game going in', () => {
  put('core/engine.ts', 'export const engine = "being changed by hand";\n');
  code.sync();
  put('games/g/src/seasons.ts', 'export const names = ["spring", "summer"];\n', code.work);
  assert.equal(code.accept('Summer').length, 1);
  assert.equal(read('games/g/src/seasons.ts'), 'export const names = ["spring", "summer"];\n');
  assert.equal(read('core/engine.ts'), 'export const engine = "being changed by hand";\n');
  assert.equal(git('status', '--porcelain').trim(), 'M core/engine.ts');
});

test('a project that ignores tandem\'s folder keeps tandem out of its history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-ignored-'));
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  try {
    g('init', '-q', '-b', 'main');
    put('src/app.js', 'export const app = 1;\n', dir);
    put('.gitignore', '.tandem/\n', dir);
    g('add', '-A');
    g('commit', '-q', '-m', 'start');
    // Tandem's own things are there, and the engine is asked to keep them as it always is.
    put('.tandem/concepts/roses.md', 'Roses.\n', dir);
    put('.tandem/tandem.json', '{"name":"Ignored"}\n', dir);
    const mine = createCode({ root: dir, paths: ['.tandem/concepts', '.tandem/tandem.json', 'art'] });
    assert.deepEqual(mine.sync(), { conflicts: [] });
    assert.equal(g('rev-list', '--count', 'HEAD'), '1', 'nothing of tandem was committed');
    assert.equal(g('status', '--porcelain'), '');
    assert.ok(!existsSync(join(mine.work, '.tandem')), 'and the copy holds only the project');
    // A change still goes in, as the project's own.
    put('src/app.js', 'export const app = 2;\n', mine.work);
    mine.accept('The app is two now');
    assert.equal(read('src/app.js', dir), 'export const app = 2;\n');
    assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n'), ['src/app.js']);
    rmSync(mine.work, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
