// Working files and project files: the working copy the agent codes in, what
// it differs from the project, and how it goes in or is thrown away. On a
// small repository made for the test, never the real one.
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
put('games/g/content/flowers/rose.json', '{"value": 5}\n');
put('core/engine.ts', 'export const engine = true;\n');
put('.gitignore', '.work/\nnode_modules/\n');
mkdirSync(join(root, 'node_modules'));
git('add', '-A');
git('commit', '-q', '-m', 'start');

const code = createCode({ root, gamePath: 'games/g' });

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

  // Meanwhile the person changes content in the project, through the engine. The copy takes that in; its own work stays.
  put('games/g/content/flowers/rose.json', '{"value": 9}\n');
  assert.deepEqual(code.sync(), { conflicts: [] });
  assert.equal(read('games/g/content/flowers/rose.json', code.work), '{"value": 9}\n');
  assert.equal(code.changes().length, 2, 'what the project changed is not the copy\'s change');
  assert.match(git('log', '--oneline', '-1'), /The game as it is now/, 'and the project\'s change is in its history');

  const taken = code.accept('Seasons: four of them');
  assert.equal(taken.length, 2);
  assert.equal(read('games/g/src/rules.ts'), 'export const speed = 2;\nexport const seasons = 4;\n');
  assert.equal(read('games/g/src/seasons.ts'), 'export const names = ["spring"];\n');
  assert.match(git('log', '--oneline', '-3'), /Seasons: four of them/);
  assert.deepEqual(code.changes(), [], 'accepted: the copy and the project are the same again');
  assert.equal(git('status', '--porcelain'), '');
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
  assert.deepEqual(code.sync(), { conflicts: ['games/g/src/rules.ts'] });
  assert.equal(read('games/g/src/rules.ts', code.work), 'export const speed = 3;\nexport const seasons = 4;\n', 'the copy still has its own work');
  assert.throws(() => code.accept('Faster'), /does not go into the project cleanly/);
  assert.equal(read('games/g/src/rules.ts'), 'export const speed = 7;\nexport const seasons = 4;\n', 'and the project is as it was');
  assert.equal(git('status', '--porcelain'), '');
  code.reject();
  assert.deepEqual(code.changes(), []);
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
