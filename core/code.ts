// Working files and project files. The project as it is in its folder is what
// is played. The agent never writes there: it codes in a working copy of
// the whole repository (a git worktree, on a branch of its own), where it can
// build and run the tests. What its copy differs from the project is one change
// set, shown to the person as a proposal: they play the copy, and accepting it
// merges it into the project. Rejecting throws the copy's changes away.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export interface FileChange { path: string; added: number; removed: number; status: 'new' | 'changed' | 'gone' }

export interface CodeOptions {
  /** The repository: the project files. */
  root: string;
  /**
   * Where the working copy goes. By default a hidden folder right next to the project (.<project>-tandem-work):
   * outside it, so nothing of the project (a dev server, a test run) trips over a second copy of itself, and at
   * the same depth, so whatever the project reaches for beside itself (../a-library) the copy finds too.
   */
  work?: string;
  /** What the engine itself writes in the project (concepts, locks, accepted drawings): committed by it, so the copy can take it in. Nothing else of the project is committed for the person. */
  paths: string[];
  branch?: string;
}

export function createCode(o: CodeOptions) {
  const work = o.work ?? join(o.root, '..', `.${basename(o.root)}-tandem-work`);
  // No slash in it: a project may well have a branch called tandem already.
  const branch = o.branch ?? 'tandem-agent';
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=tandem', '-c', 'user.email=tandem@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch (e) { return null; } };
  const main = () => git(o.root, 'rev-parse', '--abbrev-ref', 'HEAD');

  /** Is there a repository to work with at all? */
  const usable = () => tryGit(o.root, 'rev-parse', '--is-inside-work-tree') === 'true';

  /** What the copy runs with is the project's: it has the code, not a second set of dependencies. And that link is never part of a change. */
  function deps() {
    const common = git(o.root, 'rev-parse', '--git-common-dir');
    const exclude = join(isAbsolute(common) ? common : join(o.root, common), 'info', 'exclude');
    mkdirSync(join(exclude, '..'), { recursive: true });
    if (!existsSync(exclude) || !/^\/node_modules$/m.test(readFileSync(exclude, 'utf8'))) appendFileSync(exclude, '\n/node_modules\n');
    if (existsSync(join(o.root, 'node_modules')) && !existsSync(join(work, 'node_modules'))) symlinkSync(join(o.root, 'node_modules'), join(work, 'node_modules'));
  }

  /** What the person and the engine changed in the project's game is committed, so it is part of the project's history. */
  function commitProject(message: string) {
    const paths = o.paths.filter((p) => existsSync(join(o.root, p)));
    if (!paths.length) return false;
    // The files themselves, one by one: a folder with nothing in it yet is not something git can be asked about.
    const changed = git(o.root, 'status', '--porcelain', '-uall', '--', ...paths).split('\n').filter(Boolean)
      // A line is two status letters (either may be a space) and the path.
      .map((l) => l.replace(/^\s*\S+\s+/, '').split(' -> ').at(-1)!.replace(/^"|"$/g, ''));
    if (!changed.length) return false;
    git(o.root, 'add', '-A', '--', ...changed);
    git(o.root, 'commit', '-q', '-m', message, '--', ...changed);
    return true;
  }

  /** The working copy exists and has everything the project has. Says which files clash if it cannot take the project's changes in. */
  function sync(): { conflicts: string[] } {
    commitProject('What was changed and accepted in tandem');
    if (!existsSync(join(work, '.git'))) {
      mkdirSync(join(work, '..'), { recursive: true });
      tryGit(o.root, 'worktree', 'prune');
      git(o.root, 'worktree', 'add', '-q', '-B', branch, work, 'HEAD');
    }
    deps();
    if (git(work, 'status', '--porcelain')) {
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', 'Work in progress');
    }
    const ahead = Number(git(work, 'rev-list', '--count', `${main()}..HEAD`));
    if (!ahead) { git(work, 'reset', '-q', '--hard', main()); return { conflicts: [] }; }
    if (tryGit(work, 'merge', '-q', '--no-edit', main()) !== null) return { conflicts: [] };
    const conflicts = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
    tryGit(work, 'merge', '--abort');
    return { conflicts };
  }

  /**
   * Where the copy last had everything the project had. What the copy changed is measured from there, not from
   * the project as it is now: a copy that has not caught up yet did not undo what the project gained since.
   */
  const base = () => git(work, 'merge-base', main(), 'HEAD');

  /** What the working copy changes. */
  function changes(): FileChange[] {
    if (!existsSync(join(work, '.git'))) return [];
    git(work, 'add', '-A', '-N');                                   // so that new files count
    const from = base();
    const out = git(work, 'diff', '--numstat', from);
    const names = new Map(git(work, 'diff', '--name-status', from).split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split('\t'); return [p.at(-1)!, s] as const; }));
    return out.split('\n').filter(Boolean).map((l) => {
      const [a, r, ...p] = l.split('\t');
      const path = p.at(-1)!;
      const s = names.get(path) ?? 'M';
      return { path, added: Number(a) || 0, removed: Number(r) || 0, status: s.startsWith('A') ? 'new' : s.startsWith('D') ? 'gone' : 'changed' } as FileChange;
    });
  }

  /** The change itself, to read: a diff of one file, or of everything. */
  const diff = (path?: string) => (existsSync(join(work, '.git')) ? git(work, 'diff', base(), ...(path ? ['--', path] : [])).slice(0, 60_000) : '');

  /** Take the working copy into the project, as one commit that says what it is. Throws, with the project as it was, when it does not go in cleanly. */
  function accept(message: string): FileChange[] {
    // First the copy takes in whatever the project gained; if that clashes, nothing is touched.
    const { conflicts } = sync();
    if (conflicts.length) throw new Error(`the working copy does not go into the project cleanly: the project changed ${conflicts.join(', ')} too. The agent has to bring its copy up to date first`);
    const what = changes();
    if (!what.length) return [];
    // Git refuses, and touches nothing, when the person has work of their own in a file the copy changed. Nothing
    // is forced or reset here: what the person has in their project is theirs.
    try {
      git(o.root, 'merge', '-q', '--squash', branch);
    } catch (e) {
      const said = e instanceof Error ? String((e as { stderr?: string }).stderr || e.message) : String(e);
      const theirs = [...said.matchAll(/^\t(.+)$/gm)].map((m) => m[1]);
      throw new Error(theirs.length
        ? `the working copy does not go into the project yet: you have changes of your own in ${theirs.join(', ')} that are not committed. Commit them or put them aside, then accept again`
        : `the working copy does not go into the project cleanly: ${said.trim().split('\n').slice(0, 3).join(' ')}`);
    }
    git(o.root, 'commit', '-q', '-m', message);
    git(work, 'reset', '-q', '--hard', main());
    return what;
  }

  /** Throw the working copy's changes away: it is the project again. */
  function reject() {
    if (!existsSync(join(work, '.git'))) return;
    git(work, 'reset', '-q', '--hard', main());
    git(work, 'clean', '-q', '-fd');
    deps();
  }

  return { work, usable, sync, changes, diff, accept, reject, commitProject };
}

export type Code = ReturnType<typeof createCode>;
