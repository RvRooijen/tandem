// Working files and project files. The project as it is in its folder is what
// is played. The agent never writes there: it codes in a working copy of
// the whole repository (a git worktree, on a branch of its own), where it can
// build and run the tests. What its copy differs from the project is one change
// set, shown to the person as a proposal: they play the copy, and accepting it
// merges it into the project. Rejecting throws the copy's changes away.
//
// A project can say that nothing is committed for it (tandem.json: commit false):
// the person commits themselves. An accepted change set is then written in the
// project's files and left there, and so is what the engine writes. The copy can
// no longer follow the project's branch, because what was accepted is not on it:
// it follows the project's files as they are, which the engine keeps as commits
// of its own under refs/tandem/project, off every branch and never pushed.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export interface FileChange { path: string; added: number; removed: number; status: 'new' | 'changed' | 'gone' }

/** A commit of the project, as the person reads it; `pushed` is not said when the project has nowhere to push to. */
export interface Commit { hash: string; ts: number; by: string; subject: string; pushed?: boolean }
/** A branch of the project's repository; what it follows and how far apart they are is what git knows of it here. */
export interface Branch {
  name: string; current: boolean; ts: number; subject: string; follows?: string; ahead?: number; behind?: number; gone?: boolean;
  /** A branch that is only on the remote (as far as was last fetched): the remote it is on. Switched to, it becomes a branch here that follows it. */
  remote?: string;
}
/** How the project stands in its repository: what is not committed, what is not pushed, and the last commits. */
export interface Standing {
  branch: string;
  remote?: { name: string; url: string };
  /** Commits the remote does not have, and commits it has that the project does not, as far as is known here (nothing is fetched); not said when it is not known what the remote has. */
  ahead?: number;
  behind?: number;
  branches: Branch[];
  files: FileChange[];
  commits: Commit[];
  /** Whose name a commit made here carries: the person's own, as git knows them. */
  who?: { name: string; email: string };
}

/**
 * The agent's scratchpad: a folder in its working copy that is never part of a change set. What it writes there it
 * may run (runner.ts): a script that makes a change in many places at once, or tries something out.
 */
export const SCRATCH = '.tandem-scratch';

/** A commit that says which concepts it is for. */
export interface ConceptCommit { hash: string; ts: number; subject: string; concepts: string[] }

/**
 * A commit says which concepts it is for in its own message: a line `Concept: <id>` under it, one for each. So it
 * is the history that knows, whoever made the commit (the person can write the line too) and whatever was done to
 * the history since; nothing about it is kept beside the repository.
 */
export const forConcepts = (message: string, concepts: string[]) =>
  concepts.length ? `${message.trimEnd()}\n\n${concepts.map((id) => `Concept: ${id}`).join('\n')}` : message;

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
  /** Whether the engine commits in the project (asked each time: it is a setting of the project's). When not, nothing is committed on the project's branch. */
  commits?: () => boolean;
}

export function createCode(o: CodeOptions) {
  const work = o.work ?? join(o.root, '..', `.${basename(o.root)}-tandem-work`);
  // No slash in it: a project may well have a branch called tandem already.
  const branch = o.branch ?? 'tandem-agent';
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=tandem', '-c', 'user.email=tandem@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch (e) { return null; } };
  const main = () => git(o.root, 'rev-parse', '--abbrev-ref', 'HEAD');
  const commits = () => o.commits?.() !== false;

  /** The project's files as they are, when nothing is committed for it: where the engine keeps them as commits of its own. */
  const AS_IT_IS = 'refs/tandem/project';
  /**
   * Keep the project's files as they are now, committed or not (what git ignores stays out), without touching
   * the project's branch, its index or a file of it: an index of the engine's own, and a commit that only that
   * name points at.
   */
  function snapshot(): string {
    const index = join(git(o.root, 'rev-parse', '--absolute-git-dir'), 'tandem-index');
    // (Started from the project's own index, so only what changed since is read again.)
    const own = join(index, '..', 'index');
    if (existsSync(own)) copyFileSync(own, index);
    const mine = (...args: string[]) => execFileSync('git', ['-c', 'user.name=tandem', '-c', 'user.email=tandem@localhost', ...args], { cwd: o.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
    mine('add', '-A');
    const tree = mine('write-tree');
    const was = tryGit(o.root, 'rev-parse', '-q', '--verify', AS_IT_IS);
    if (was && git(o.root, 'rev-parse', `${was}^{tree}`) === tree) return was;
    const now = mine('commit-tree', tree, '-p', was ?? git(o.root, 'rev-parse', 'HEAD'), '-m', 'The project as it is');
    git(o.root, 'update-ref', AS_IT_IS, now);
    return now;
  }
  /** What the copy follows: the project's branch, or its files as they are when nothing is committed for it (looked at anew when `fresh`). */
  const project = (fresh = false) => (commits() ? main() : (!fresh && tryGit(o.root, 'rev-parse', '-q', '--verify', AS_IT_IS)) || snapshot());

  /** Is there a repository to work with at all? */
  const usable = () => tryGit(o.root, 'rev-parse', '--is-inside-work-tree') === 'true';

  /** What the copy runs with is the project's: it has the code, not a second set of dependencies. And that link is never part of a change. */
  function deps() {
    const common = git(o.root, 'rev-parse', '--git-common-dir');
    const exclude = join(isAbsolute(common) ? common : join(o.root, common), 'info', 'exclude');
    mkdirSync(join(exclude, '..'), { recursive: true });
    // (Nor is its scratchpad.)
    for (const line of ['/node_modules', `/${SCRATCH}`])
      if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes(line)) appendFileSync(exclude, `\n${line}\n`);
    if (existsSync(join(o.root, 'node_modules')) && !existsSync(join(work, 'node_modules'))) symlinkSync(join(o.root, 'node_modules'), join(work, 'node_modules'));
  }

  /** What the person and the engine changed in the project's game is committed, so it is part of the project's history. */
  function commitProject(message: string, written = o.paths) {
    if (!commits()) return false;
    const paths = written.filter((p) => existsSync(join(o.root, p)));
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

  /** Is this file of the project as its history has it: not there, or committed and not changed since? Then nothing of the person's is in it. */
  const settled = (path: string) => tryGit(o.root, 'status', '--porcelain', '--', path) === '';

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
    // A project that is committed for again: the copy followed its files, and goes back to its branch with
    // what it had changed itself (as far as that still fits; what does not is said as a clash below).
    const followed = commits() ? tryGit(o.root, 'rev-parse', '-q', '--verify', AS_IT_IS) : null;
    if (followed) {
      if (tryGit(work, 'rebase', '-q', '--onto', main(), followed) === null) tryGit(work, 'rebase', '--abort');
      git(o.root, 'update-ref', '-d', AS_IT_IS);
    }
    const to = project(true);
    const ahead = Number(git(work, 'rev-list', '--count', `${to}..HEAD`));
    if (!ahead) { git(work, 'reset', '-q', '--hard', to); return { conflicts: [] }; }
    if (tryGit(work, 'merge', '-q', '--no-edit', to) !== null) return { conflicts: [] };
    const conflicts = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
    tryGit(work, 'merge', '--abort');
    return { conflicts };
  }

  /**
   * Where the copy last had everything the project had. What the copy changed is measured from there, not from
   * the project as it is now: a copy that has not caught up yet did not undo what the project gained since.
   */
  const base = () => git(work, 'merge-base', project(), 'HEAD');

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
    if (!commits()) return write(what);
    // A file that is new in the copy and is in the project already, not committed but the very same (a lockfile
    // that installing wrote in both), is not work of the person's that stands in the way: it makes way for the
    // copy's, which is it. Put back if the copy does not go in after all.
    const twice = what.filter((f) => f.status === 'new' && existsSync(join(o.root, f.path)) && existsSync(join(work, f.path))
      && tryGit(o.root, 'status', '--porcelain', '--', f.path)?.startsWith('??')
      && readFileSync(join(o.root, f.path)).equals(readFileSync(join(work, f.path))))
      .map((f) => ({ file: join(o.root, f.path), bytes: readFileSync(join(o.root, f.path)) }));
    for (const t of twice) rmSync(t.file);
    // Git refuses, and touches nothing, when the person has work of their own in a file the copy changed. Nothing
    // is forced or reset here: what the person has in their project is theirs.
    try {
      git(o.root, 'merge', '-q', '--squash', branch);
    } catch (e) {
      for (const t of twice) writeFileSync(t.file, t.bytes);
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

  /**
   * Take the working copy into a project that nothing is committed for: what the copy changed is written in the
   * project's files and left there, for the person to commit. All of it or nothing; the copy has just taken in the
   * project as it is, so it only does not go when a file was changed in that same moment.
   */
  function write(what: FileChange[]): FileChange[] {
    const patch = execFileSync('git', ['diff', '--binary', project(), 'HEAD'], { cwd: work, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: o.root, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const said = e instanceof Error ? String((e as { stderr?: string }).stderr || e.message) : String(e);
      throw new Error(`the working copy does not go into the project cleanly: ${said.trim().split('\n').slice(0, 3).join(' ')}`);
    }
    git(work, 'reset', '-q', '--hard', project(true));
    return what;
  }

  /** The commits of the project that name a concept, the newest first. */
  function history(limit = 300): ConceptCommit[] {
    const out = tryGit(o.root, 'log', `-${limit}`, '--grep=^Concept: ', '--format=%H%x1f%ct%x1f%s%x1f%b%x1e') ?? '';
    return out.split('\x1e').map((c) => c.replace(/^\n/, '').split('\x1f')).filter((c) => c.length === 4).map(([hash, at, subject, body]) => ({
      hash, ts: Number(at) * 1000, subject,
      concepts: [...new Set([...body.matchAll(/^Concept: *(\S+) *$/gm)].map((m) => m[1]))],
    })).filter((c) => c.concepts.length);
  }

  /** Where the project's branch is pushed: the remote its branch follows, else origin, else the only one there is. */
  function remoteOf(): { name: string; url: string; branch: string } | undefined {
    const branch = tryGit(o.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    const remotes = (tryGit(o.root, 'remote') ?? '').split('\n').filter(Boolean);
    if (!branch || branch === 'HEAD' || !remotes.length) return undefined;
    const set = tryGit(o.root, 'config', `branch.${branch}.remote`);
    const name = set && remotes.includes(set) ? set : remotes.includes('origin') ? 'origin' : remotes[0];
    return { name, url: tryGit(o.root, 'remote', 'get-url', name) ?? '', branch };
  }

  /** Say where the project is pushed: the address of a repository that is there already. It is the project's origin from then on; empty takes it away. */
  function setRemote(url: string) {
    const to = url.trim();
    if (to && (/\s/.test(to) || to.startsWith('-'))) throw new Error('that is not the address of a repository');
    const has = (tryGit(o.root, 'remote') ?? '').split('\n').includes('origin');
    if (has && tryGit(o.root, 'remote', 'get-url', 'origin') === to) return;
    // Another address is another repository: what was known of the old one (what it had of the branch) goes with it.
    if (has) git(o.root, 'remote', 'remove', 'origin');
    if (!to) return;
    git(o.root, 'remote', 'add', 'origin', to);
    // (From now on it is where the branch goes, whatever it followed before.)
    const branch = tryGit(o.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (branch && branch !== 'HEAD') tryGit(o.root, 'config', `branch.${branch}.remote`, 'origin');
  }

  /**
   * Push the project's branch to its remote, when it has one and the remote does not have what the branch has.
   * Never forced, and never asking for a password: when it does not go, it says why and the commits stay where
   * they are. Undefined when there was nothing to push or nowhere to push to.
   */
  function push(): Promise<{ ok: boolean; remote: string; branch: string; says: string } | undefined> {
    const to = remoteOf();
    if (!to) return Promise.resolve(undefined);
    const { name: remote, branch } = to;
    if (tryGit(o.root, 'rev-parse', '-q', '--verify', `refs/remotes/${remote}/${branch}`) === tryGit(o.root, 'rev-parse', 'HEAD')) return Promise.resolve(undefined);
    return new Promise((done) => {
      execFile('git', ['push', '-q', '-u', remote, branch], { cwd: o.root, timeout: 90_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, said) => {
        const why = String(said || err?.message || '').trim().split('\n').filter((l) => !/^(hint|To |remote: *$)/.test(l)).slice(0, 3).join(' ').slice(0, 300);
        done({ ok: !err, remote, branch, says: err ? why || 'git push failed' : '' });
      });
    });
  }

  // ---- The person's own version control, from tandem's page. Everything here is done as the person, with the
  // name git knows them by: these are their commits, not the engine's.
  const own = (args: string[], more: { input?: Buffer; ok?: number[] } = {}): string => {
    try {
      return execFileSync('git', args, { cwd: o.root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      const failed = e as { status?: number; stdout?: string };
      if (more.ok?.includes(failed.status ?? -1)) return String(failed.stdout ?? '');
      throw e;
    }
  };
  const tryOwn = (...args: string[]) => { try { return own(args).trim(); } catch { return null; } };
  /** A file of the project, named from its root: nothing that could be read as an option, and nothing outside it. */
  const inside = (path: string) => {
    if (!path || path.startsWith('-') || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`${path || 'that'} is not a file of the project`);
    return path;
  };

  /** How many files git does not follow are listed one by one; more than that, and a folder of them is one line. */
  const MANY = 300;
  /** What is not committed in the project: every file that differs from the last commit, with how much. A whole folder that is new is one of them when there are very many (its path ends in a slash). */
  function uncommitted(): FileChange[] {
    // (-z: a path is said as it is, whatever is in its name; a file that moved is followed by where it was.)
    let said = own(['status', '--porcelain', '-uall', '-z']).split('\0').filter(Boolean);
    // A folder git does not follow can hold thousands of files (a node_modules whose .gitignore went with a pull):
    // past a few hundred, such a folder is one line, not every file in it.
    if (said.filter((l) => l.startsWith('??')).length > MANY) said = own(['status', '--porcelain', '-unormal', '-z']).split('\0').filter(Boolean);
    const lines = new Map((tryOwn('diff', '--numstat', '-z', 'HEAD') ?? '').split('\0').filter(Boolean).map((l) => { const [a, r, path] = l.split('\t'); return [path, [Number(a) || 0, Number(r) || 0]] as const; }));
    const files: FileChange[] = [];
    for (let i = 0; i < said.length; i++) {
      const how = said[i].slice(0, 2), path = said[i].slice(3);
      if (/[RC]/.test(how)) i++;
      const status = how === '??' || how.includes('A') ? 'new' : how.includes('D') ? 'gone' : 'changed';
      let [added, removed] = lines.get(path) ?? [0, 0];
      // (A file git does not follow yet is all new: its lines are counted here, when it is not too big to read.)
      if (how === '??' && !path.endsWith('/')) try { const text = readFileSync(join(o.root, path)); if (text.length < 1 << 20 && !text.includes(0)) added = text.toString('utf8').split('\n').length - (text.at(-1) === 10 ? 1 : 0); } catch { /* it went meanwhile */ }
      files.push({ path, added, removed, status });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  function standing(): Standing {
    const to = remoteOf();
    const has = to && tryGit(o.root, 'rev-parse', '-q', '--verify', `refs/remotes/${to.name}/${to.branch}`);
    const ahead = has ? Number(tryGit(o.root, 'rev-list', '--count', `${has}..HEAD`) ?? 0) : undefined;
    const behind = has ? Number(tryGit(o.root, 'rev-list', '--count', `HEAD..${has}`) ?? 0) : undefined;
    // (The agent's own branch is the engine's, not one of the person's.)
    const heads = (tryOwn('for-each-ref', 'refs/heads', '--sort=-committerdate', '--format=%(refname:short)%1f%(HEAD)%1f%(committerdate:unix)%1f%(subject)%1f%(upstream:short)%1f%(upstream:track)') ?? '').split('\n').filter(Boolean)
      .map((l) => l.split('\x1f')).filter((b) => b.length === 6 && b[0] !== branch)
      .map(([name, head, at, subject, follows, track]): Branch => ({
        name, current: head === '*', ts: Number(at) * 1000, subject,
        ...(follows && { follows }), ...(/ahead (\d+)/.test(track) && { ahead: Number(/ahead (\d+)/.exec(track)![1]) }), ...(/behind (\d+)/.test(track) && { behind: Number(/behind (\d+)/.exec(track)![1]) }), ...(track.includes('gone') && { gone: true }),
      }));
    // What the remote has that is not a branch here: known as of the last fetch.
    const elsewhere = !to ? [] : (tryOwn('for-each-ref', `refs/remotes/${to.name}`, '--sort=-committerdate', '--format=%(refname:lstrip=3)%1f%(committerdate:unix)%1f%(subject)') ?? '').split('\n').filter(Boolean)
      .map((l) => l.split('\x1f')).filter((b) => b.length === 3 && b[0] !== 'HEAD' && b[0] !== branch && !heads.some((h) => h.name === b[0]))
      .map(([name, at, subject]): Branch => ({ name, current: false, ts: Number(at) * 1000, subject, remote: to.name }));
    const log = tryOwn('log', '-12', '--format=%H%x1f%ct%x1f%an%x1f%s%x1e') ?? '';
    const commits = log.split('\x1e').map((c) => c.replace(/^\n/, '').split('\x1f')).filter((c) => c.length === 4)
      .map(([hash, at, by, subject], n) => ({ hash, ts: Number(at) * 1000, by, subject, ...(to && { pushed: ahead !== undefined && n >= ahead }) }));
    const name = tryOwn('config', 'user.name'), email = tryOwn('config', 'user.email');
    return {
      branch: tryGit(o.root, 'rev-parse', '--abbrev-ref', 'HEAD') ?? '',
      ...(to && { remote: { name: to.name, url: to.url } }), ...(ahead !== undefined && { ahead, behind }),
      branches: [...heads.sort((a, b) => Number(b.current) - Number(a.current)), ...elsewhere],
      files: uncommitted(), commits, ...(name && email && { who: { name, email } }),
    };
  }

  /** What is not committed in one file, to read. */
  function uncommittedIn(path: string): string {
    inside(path);
    if (path.endsWith('/')) return '';
    const tracked = tryOwn('ls-files', '--error-unmatch', '--', path) !== null;
    const diff = tracked ? own(['diff', 'HEAD', '--', path]) : own(['diff', '--no-index', '--', '/dev/null', path], { ok: [1] });
    return diff.slice(0, 60_000);
  }

  /**
   * Throw away what is not committed in one file: it is as the last commit has it again. A file that is new is
   * gone, one that was taken away is back. This cannot be undone, and only the person asks for it.
   */
  /** These files, each with what is not committed in it: every one is a file of the project that has something. Asked once, before any is thrown away. */
  function discardable(paths: string[]): FileChange[] {
    const all = uncommitted();
    return paths.map((path) => { const file = all.find((f) => f.path === inside(path)); if (!file) throw new Error(`${path} has nothing that is not committed`); return file; });
  }
  function discard(path: string, known?: FileChange): FileChange {
    const file = known ?? discardable([path])[0];
    if (!path.endsWith('/') && tryOwn('cat-file', '-e', `HEAD:${path}`) !== null) own(['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
    else {
      own(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', path]);
      rmSync(join(o.root, path), { force: true, recursive: path.endsWith('/') });
    }
    return file;
  }

  /**
   * Put the project on another of its branches. Only when nothing in it is uncommitted (nothing of the person's
   * can get lost or be carried along) and the copy has no change of its own; the copy is that branch from then on.
   */
  function switchTo(name: string): { from: string; branch: string } {
    const from = tryGit(o.root, 'rev-parse', '--abbrev-ref', 'HEAD') ?? '';
    const here = !!name && tryOwn('show-ref', '--verify', '--quiet', `refs/heads/${name}`) !== null;
    // (One that is only on the remote becomes a branch here that follows it.)
    const to = remoteOf();
    const there = !here && !!name && !!to && tryOwn('show-ref', '--verify', '--quiet', `refs/remotes/${to.name}/${name}`) !== null;
    if (!name || name.startsWith('-') || name === branch || !(here || there)) throw new Error(`${name || 'that'} is not a branch of this project`);
    if (name === from) throw new Error(`the project is on ${name} already`);
    const open = uncommitted();
    if (open.length) throw new Error(`${open.length} ${open.length === 1 ? 'file is' : 'files are'} not committed: commit or throw away what you changed first`);
    if (existsSync(join(work, '.git')) && changes().length) throw new Error('the agent\'s working copy has changes of its own: accept or reject them first');
    try { own(here ? ['switch', '-q', name] : ['switch', '-q', '-c', name, '--track', `${to!.name}/${name}`]); } catch (e) {
      throw new Error(`it could not be switched: ${String((e as { stderr?: string }).stderr || (e instanceof Error ? e.message : e)).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
    reject();
    return { from, branch: name };
  }

  /** Commit what is not committed, all of it or the files named, as the person. Says what the commit is. */
  function commit(message: string, paths?: string[]): { hash: string; subject: string; files: number } {
    const all = uncommitted();
    const which = paths ? all.filter((f) => paths.map(inside).includes(f.path)) : all;
    if (!which.length) throw new Error('there is nothing to commit');
    if (!tryOwn('config', 'user.name') || !tryOwn('config', 'user.email')) throw new Error('git does not know who you are yet: say so with git config user.name and user.email, and commit again');
    const named = which.map((f) => f.path);
    try {
      own(['add', '-A', '--', ...named]);
      own(['commit', '-q', '-m', message, '--', ...named]);
    } catch (e) {
      const said = String((e as { stderr?: string }).stderr || (e instanceof Error ? e.message : e)).trim().split('\n').filter(Boolean);
      throw new Error(`it was not committed: ${said.slice(-3).join(' ').slice(0, 300)}`);
    }
    return { hash: own(['rev-parse', 'HEAD']).trim(), subject: message.split('\n')[0], files: named.length };
  }

  /**
   * Take in what the remote has of the project's branch that the project does not. Only forward: when the project
   * has commits of its own that the remote does not have, nothing is merged or rebased here, and it says so. What
   * is not committed stays as it is; git refuses, and touches nothing, when it is in a file the remote changed.
   */
  function pull(): Promise<{ ok: boolean; remote: string; branch: string; commits: number; says: string } | undefined> {
    const to = remoteOf();
    if (!to) return Promise.resolve(undefined);
    const { name: remote, branch } = to;
    const before = tryGit(o.root, 'rev-parse', 'HEAD');
    return new Promise((done) => {
      execFile('git', ['pull', '-q', '--ff-only', remote, branch], { cwd: o.root, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, said) => {
        const text = String(said || err?.message || '');
        const why = /not possible to fast-forward|diverg/i.test(text) ? `${branch} has commits here that ${remote} does not have, and ${remote} has others: that is not brought together here`
          : text.trim().split('\n').filter((l) => !/^(hint|From |remote: *$)/.test(l)).slice(0, 3).join(' ').slice(0, 300);
        const commits = err || !before ? 0 : Number(tryGit(o.root, 'rev-list', '--count', `${before}..HEAD`) ?? 0);
        done({ ok: !err, remote, branch, commits, says: err ? why || 'git pull failed' : '' });
      });
    });
  }

  /**
   * Ask the remote what it has, of every branch: nothing of the project changes, only what is known here of the
   * remote, so how far ahead and behind each branch is, is true again. Branches that are gone there are forgotten.
   */
  function fetch(): Promise<{ ok: boolean; remote: string; says: string } | undefined> {
    const to = remoteOf();
    if (!to) return Promise.resolve(undefined);
    return new Promise((done) => {
      execFile('git', ['fetch', '-q', '--prune', to.name], { cwd: o.root, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, said) => {
        const why = String(said || err?.message || '').trim().split('\n').filter((l) => !/^(hint|From |remote: *$)/.test(l)).slice(0, 3).join(' ').slice(0, 300);
        done({ ok: !err, remote: to.name, says: err ? why || 'git fetch failed' : '' });
      });
    });
  }

  /** Throw the working copy's changes away: it is the project again. */
  function reject() {
    if (!existsSync(join(work, '.git'))) return;
    git(work, 'reset', '-q', '--hard', project(true));
    git(work, 'clean', '-q', '-fd');
    deps();
  }

  return { work, usable, sync, changes, diff, accept, reject, commitProject, settled, history, push, remote: remoteOf, setRemote, standing, uncommittedIn, commit, discard, discardable, switchTo, pull, fetch };
}

export type Code = ReturnType<typeof createCode>;
