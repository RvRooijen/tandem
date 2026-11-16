// Version control: how the project stands in its repository. What is not
// committed, to read and to commit; what is not pushed, to push; the last
// commits; and what tandem does by itself after an accept (commit, push) and
// where it pushes.
import type { App, Panel } from '../app.ts';
import type { Event } from '../../core/events.ts';
import { clear, h } from '../dom.ts';

interface File { path: string; added: number; removed: number; status: 'new' | 'changed' | 'gone' }
interface Commit { hash: string; ts: number; by: string; subject: string; pushed?: boolean }
interface Branch { name: string; current: boolean; ts: number; subject: string; follows?: string; ahead?: number; behind?: number; gone?: boolean; remote?: string }
interface Standing {
  git: boolean; branch: string; remote?: { name: string; url: string }; ahead?: number; behind?: number; branches: Branch[];
  files: File[]; commits: Commit[]; who?: { name: string; email: string }; commit: boolean; push: boolean;
}

/** How long ago something was, in a word or two. */
function ago(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ago`;
  if (min < 60 * 24 * 60) return `${Math.floor(min / 60 / 24)} d ago`;
  return new Date(ts).toLocaleDateString();
}

/** After these the repository stands differently, whoever did it. */
const MOVES = new Set(['proposal.decided', 'code.changed', 'art.changed', 'project.pushed', 'project.committed', 'project.discarded', 'project.switched', 'project.pulled', 'keep.changed', 'remote.changed', 'setup.changed']);

export function gitPanel(): Panel {
  let app!: App;
  let body: HTMLElement | undefined;
  /** What is being written and chosen is kept while the panel is drawn again: the message, the files left out, the file being read. */
  let message = '';
  const left = new Set<string>();
  let reading: string | undefined;
  /** The file whose change is about to be thrown away: asked once more, in its own row. */
  let discarding: string | undefined;
  /** The same for everything that is checked at once. */
  let discardingAll = false;
  const diffs = new Map<string, string>();
  let busy = '';
  /** The other branches are a long list in some projects: shown when asked for. */
  let allBranches = false;
  /** How the repository stood when it was last asked: shown at once when the tab is opened, and asked again behind it. */
  let last: Standing | undefined;

  /** What changed in a file, line by line. */
  function lines(diff: string): HTMLElement {
    const all = diff.split('\n');
    const from = all.findIndex((l) => l.startsWith('@@'));
    const text = (from < 0 ? [] : all.slice(from)).filter((l) => !l.startsWith('\\'));
    while (text.length && !text.at(-1)) text.pop();
    if (!text.length) return h('p.t-hint', {}, 'Nothing to read in it: it is not text, or it only moved.');
    return h('pre.diff', {}, text.map((l) => h('span', { data: { how: l.startsWith('@@') ? 'at' : l.startsWith('+') ? 'in' : l.startsWith('-') ? 'out' : 'same' } }, l.startsWith('@@') ? '⋯' : l || ' ')));
  }

  async function read(path: string) {
    if (reading === path) { reading = undefined; return paint(); }
    reading = path;
    const got = await app.act<{ diff: string }>('git.diff', { path });
    if (got) diffs.set(path, got.diff);
    paint();
  }

  /**
   * Ask how the repository stands now, and draw it if that is not what is on the screen already: a panel that is
   * drawn again loses where the person was typing, so it is only done when something changed.
   */
  async function refresh() {
    const got = await app.act<Standing>('git.status');
    if (!got) return;
    const same = !!last && JSON.stringify(got) === JSON.stringify(last);
    last = got;
    if (body && !(same && body.childNodes.length && !body.querySelector('.loading'))) paint();
  }

  /** Draw the repository as it was last heard of. */
  function paint() {
    const now = last;
    if (!body || !now) return;
    if (!now.git) return clear(body, h('div.empty', {}, h('b', {}, 'No repository.'), h('p', {}, 'This project is not in a git repository, so there is nothing to commit or push.')));
    for (const path of [...left]) if (!now.files.some((f) => f.path === path)) left.delete(path);
    if (reading && !now.files.some((f) => f.path === reading)) reading = undefined;
    if (discarding && !now.files.some((f) => f.path === discarding)) discarding = undefined;
    const chosen = now.files.filter((f) => !left.has(f.path));

    // ---- what is not committed
    const words = h<'textarea'>('textarea', { rows: 2, placeholder: 'What is this commit?', 'aria-label': 'Commit message', value: message, oninput: () => { message = words.value; commitBtn.disabled = !can(); } });
    const can = () => !busy && !!message.trim() && chosen.length > 0;
    const commit = async () => {
      if (!can()) return;
      busy = 'commit';
      commitBtn.disabled = true;
      const made = await app.act<{ files: number }>('git.commit', { message: message.trim(), ...(left.size && { paths: chosen.map((f) => f.path) }) });
      busy = '';
      if (made) { message = ''; diffs.clear(); left.clear(); app.toast(`Committed ${made.files} ${made.files === 1 ? 'file' : 'files'}.`); }
      paint();
      void refresh();
    };
    const commitBtn = h<'button'>('button.primary', { disabled: !can(), onclick: () => void commit() }, chosen.length === now.files.length ? 'Commit' : `Commit ${chosen.length} of ${now.files.length}`);
    const discard = async (f: File) => {
      discarding = undefined;
      if (await app.act('git.discard', { path: f.path })) { diffs.delete(f.path); left.delete(f.path); app.toast(f.status === 'new' ? 'It is gone.' : 'It is as it was committed.'); }
      void refresh();
    };
    const discardChosen = async () => {
      discardingAll = false;
      busy = 'discard';
      paint();
      const gone = await app.act<{ discarded: string[] }>('git.discard', { paths: chosen.map((f) => f.path) });
      busy = '';
      if (gone) { diffs.clear(); app.toast(`${gone.discarded.length} ${gone.discarded.length === 1 ? 'change is' : 'changes are'} thrown away.`); }
      paint();
      void refresh();
    };
    const toggleAll = () => { if (left.size) left.clear(); else for (const f of now.files) left.add(f.path); paint(); };
    const file = (f: File) => {
      // (A whole folder that is new is one line when there is very much in it: its path ends in a slash.)
      const folder = f.path.endsWith('/');
      const at = f.path.lastIndexOf('/', f.path.length - (folder ? 2 : 1));
      return h(`div.gfile${reading === f.path ? '.open' : ''}`, { data: { how: f.status } },
        h('div.frow', { title: f.path, onclick: () => void read(f.path) },
          h<'input'>('input', { type: 'checkbox', 'aria-label': `Commit ${f.path}`, checked: !left.has(f.path), onclick: (ev: MouseEvent) => ev.stopPropagation(), onchange: (ev: globalThis.Event) => { if ((ev.target as HTMLInputElement).checked) left.delete(f.path); else left.add(f.path); paint(); } }),
          h('span.mark', { title: f.status === 'new' ? 'New' : f.status === 'gone' ? 'Taken away' : 'Changed' }, f.status === 'new' ? 'A' : f.status === 'gone' ? 'D' : 'M'),
          // (The name first, where it is after it: in a narrow panel the folder is what gives way.)
          h('span.fname', {}, h('b', {}, f.path.slice(at + 1)), at < 0 ? null : h('i', {}, f.path.slice(0, at))),
          // Thrown away, it cannot be brought back: so it is asked once more, here in the row.
          discarding === f.path ? [
            h('span.sure', {}, folder ? 'Delete the folder?' : f.status === 'new' ? 'Delete it?' : f.status === 'gone' ? 'Bring it back?' : 'Throw away?'),
            h<'button'>('button.yes', { 'aria-label': `Yes, discard ${f.path}`, onclick: (ev: MouseEvent) => { ev.stopPropagation(); void discard(f); } }, 'Yes'),
            h<'button'>('button.no', { 'aria-label': 'No, keep it', onclick: (ev: MouseEvent) => { ev.stopPropagation(); discarding = undefined; paint(); } }, 'No'),
          ] : [
            h('span.count', {}, folder ? h('i', {}, 'folder') : null, f.added ? h('i.in', {}, `+${f.added}`) : null, f.removed ? h('i.out', {}, `−${f.removed}`) : null),
            h<'button'>('button.undo', { 'aria-label': `Discard ${f.path}`, title: 'Throw this change away', onclick: (ev: MouseEvent) => { ev.stopPropagation(); discarding = f.path; paint(); } }, '↩'),
          ]),
        reading === f.path && diffs.has(f.path) && lines(diffs.get(f.path)!));
    };
    const sum = now.files.reduce((n, f) => ({ in: n.in + f.added, out: n.out + f.removed }), { in: 0, out: 0 });

    // ---- what is not pushed
    const unpushed = now.remote ? now.ahead ?? now.commits.length : 0;
    const push = async () => {
      busy = 'push';
      pushBtn.disabled = true;
      pushBtn.textContent = 'Pushing…';
      const went = await app.act<{ pushed: boolean; says?: string }>('git.push');
      busy = '';
      if (went) app.toast(went.pushed ? 'Pushed.' : went.says ? `It was not pushed: ${went.says}` : 'It was not pushed.');
      paint();
      void refresh();
    };
    const pushBtn = h<'button'>('button', { disabled: !!busy || !now.remote || !unpushed, onclick: () => void push() }, unpushed ? `Push ${unpushed} ${unpushed === 1 ? 'commit' : 'commits'}` : 'Push');
    const pull = async () => {
      busy = 'pull';
      pullBtn.disabled = true;
      pullBtn.textContent = 'Pulling…';
      const got = await app.act<{ pulled: boolean; commits: number; says?: string }>('git.pull');
      busy = '';
      if (got) app.toast(!got.pulled ? `It was not pulled: ${got.says ?? ''}` : got.commits ? `Pulled ${got.commits} ${got.commits === 1 ? 'commit' : 'commits'}.` : 'Nothing new there.');
      if (got?.pulled) diffs.clear();
      paint();
      void refresh();
    };
    // (How far behind it is, is only what was last heard of the remote: pulling asks it.)
    const pullBtn = h<'button'>('button', { disabled: !!busy || !now.remote, onclick: () => void pull() }, now.behind ? `Pull ${now.behind}` : 'Pull');
    const askRemote = async () => {
      busy = 'fetch';
      fetchBtn.disabled = true;
      fetchBtn.textContent = 'Fetching…';
      const got = await app.act<{ remote: string; behind?: number }>('git.fetch');
      busy = '';
      if (got) app.toast(got.behind ? `${got.remote} has ${got.behind} ${got.behind === 1 ? 'commit' : 'commits'} you do not have yet.` : `Nothing new on ${got.remote} for this branch.`);
      paint();
      void refresh();
    };
    const fetchBtn = h<'button'>('button', { disabled: !!busy || !now.remote, title: 'Ask the remote what it has; nothing of the project changes', onclick: () => void askRemote() }, 'Fetch');
    const where = !now.remote ? 'It has no remote: give it one below to push.'
      : now.ahead === undefined ? `Nothing of ${now.branch} is on ${now.remote.name} yet.`
      : now.ahead ? `${now.ahead} ${now.ahead === 1 ? 'commit is' : 'commits are'} not on ${now.remote.name} yet.`
      : `${now.remote.name} has everything that is committed.`;

    // ---- settings: where it is pushed, and what tandem does by itself
    const remote = h<'input'>('input', { placeholder: 'https://github.com/you/project.git', 'aria-label': 'Where the project is pushed', value: now.remote?.url ?? '' });
    const saveRemote = async () => {
      const set = await app.act<{ url: string | null; pushed?: boolean; says?: string }>('project.setRemote', { url: remote.value.trim() });
      if (!set) return;
      app.toast(!set.url ? 'It has no remote any more.' : set.pushed === false ? `It is set, but pushing to it did not work: ${set.says ?? ''}` : set.pushed ? 'It is set, and the project is pushed there.' : 'It is set.');
      void refresh();
    };
    remote.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void saveRemote(); });
    const pushes = now.commit && now.push;
    const keep = (name: 'commit' | 'push', on: boolean, label: string, off = false) => {
      const box = h<'input'>('input.switch', { type: 'checkbox', role: 'switch', 'aria-label': label, checked: on, disabled: off, onchange: async () => { await app.act('project.keep', { [name]: box.checked }); void refresh(); } });
      return h('label.keep', {}, box, h('span', {}, label));
    };

    // ---- the branches
    const others = now.branches.filter((b) => !b.current);
    const dirty = now.files.length > 0;
    const go = async (b: Branch) => {
      busy = 'switch';
      const went = await app.act<{ branch: string }>('git.switch', { branch: b.name });
      busy = '';
      if (went) { diffs.clear(); left.clear(); reading = undefined; allBranches = false; app.toast(`The project is on ${went.branch} now.`); }
      paint();
      void refresh();
    };
    const branch = (b: Branch) => h(`div.branch${b.current ? '.current' : ''}`, {},
      h('div.line', {}, h('b', {}, b.name), b.current && h('span.t-chip', {}, 'here'), b.remote && h('span.arrow.down', { title: `Only on ${b.remote}: switching to it makes it a branch here` }, b.remote),
        b.ahead ? h('span.arrow.up', { title: `${b.ahead} not on ${b.follows}` }, `↑${b.ahead}`) : null,
        b.behind ? h('span.arrow.down', { title: `${b.behind} on ${b.follows} that are not here` }, `↓${b.behind}`) : null),
      h('small', {}, [b.remote ? `only on ${b.remote}` : b.follows ? (b.gone ? `followed ${b.follows}, which is gone` : `follows ${b.follows}`) : 'only here', ago(b.ts), b.subject].join(' · ')),
      !b.current && h<'button'>('button.switch', { 'aria-label': `Switch to ${b.name}`, disabled: dirty || !!busy, title: dirty ? 'Commit or throw away what you changed first' : `Put the project on ${b.name}`, onclick: () => void go(b) }, 'Switch'));

    // The commits, the newest first, as a line: what the remote does not have yet stands out, and where it has the rest is marked.
    const upto = now.remote && now.ahead !== undefined ? now.commits.findIndex((c) => c.pushed !== false) : -1;
    const one = (c: Commit, n: number) => [
      n === upto && upto > 0 && h('div.mark-remote', {}, h('span', {}, `${now.remote!.name}/${now.branch}`)),
      h(`div.rev${c.pushed === false ? '.ahead' : ''}`, {},
        h('i.dot'),
        h('div', { title: `${c.subject}\n${c.hash.slice(0, 7)} · ${c.by} · ${new Date(c.ts).toLocaleString()}` }, h('b', {}, c.subject), h('small', {}, `${c.hash.slice(0, 7)} · ${ago(c.ts)}`))),
    ];

    clear(body,
      h('div.standing', {},
        h('div.line', {}, h('b.name', {}, now.branch || 'no branch'),
          now.ahead ? h('span.arrow.up', {}, `↑${now.ahead}`) : null, now.behind ? h('span.arrow.down', {}, `↓${now.behind}`) : null,
          now.files.length ? h('span.arrow.dirty', {}, `${now.files.length} changed`) : h('span.arrow.clean', {}, 'clean')),
        h('small', {}, where)),
      h('div.head', {}, h('h3', {}, now.files.length ? `Changes (${now.files.length})` : 'Changes'),
        now.files.length > 0 && h('span.count', {}, sum.in ? h('i.in', {}, `+${sum.in}`) : null, sum.out ? h('i.out', {}, `−${sum.out}`) : null),
        now.files.length > 1 && h<'button'>('button.link', { onclick: toggleAll }, left.size ? 'All' : 'None'),
        // (What changed outside tandem, in an editor or a terminal, is not told to it: this looks again.)
        h<'button'>('button.again', { 'aria-label': 'Refresh', title: 'Look at the repository again', onclick: () => void refresh() }, '⟳')),
      now.files.length ? [
        h('div.gfiles', {}, now.files.map(file)),
        h('div.adder.commit', {}, words, commitBtn),
        // Everything that is checked can be thrown away at once: asked once more, with how many it is.
        h('div.discard', {}, discardingAll && chosen.length ? [
          h('span.sure', {}, `Throw away ${chosen.length === now.files.length ? (chosen.length === 1 ? 'the change' : `all ${chosen.length} changes`) : `${chosen.length} of ${now.files.length} changes`}? It cannot be brought back.`),
          h<'button'>('button.yes', { 'aria-label': 'Yes, discard what is checked', onclick: () => void discardChosen() }, 'Yes'),
          h<'button'>('button.no', { 'aria-label': 'No, keep them', onclick: () => { discardingAll = false; paint(); } }, 'No'),
        ] : h<'button'>('button.link.danger', { disabled: !!busy || !chosen.length, onclick: () => { discardingAll = true; paint(); } }, busy === 'discard' ? 'Throwing away…' : `Discard ${chosen.length} checked`)),
        h('p.t-hint', {}, now.who ? `Committed as ${now.who.name} <${now.who.email}>. Tap a file to read what changed in it; ↩ throws its change away.` : 'Git does not know who you are yet (git config user.name and user.email), so nothing can be committed here.'),
      ] : h('p.t-hint', {}, 'Everything in the project is committed.'),
      h('div.head', {}, h('h3', {}, 'Commits'), fetchBtn, pullBtn, pushBtn),
      h('div.commits', {}, now.commits.map(one)),
      !now.commits.length && h('p.t-hint', {}, 'No commits yet.'),
      h('div.head', {}, h('h3', {}, others.length ? `Branches (${now.branches.length})` : 'Branches'),
        others.length > 0 && h<'button'>('button.link', { onclick: () => { allBranches = !allBranches; paint(); } }, allBranches ? 'Only this one' : 'Show all')),
      h('div.branches', {}, now.branches.filter((b) => b.current || allBranches).map(branch)),
      allBranches && others.length > 0 && dirty && h('p.t-hint', {}, 'To switch to another branch, commit or throw away what you changed first.'),
      !now.branches.length && h('p.t-hint', {}, 'No branch yet.'),
      h('h3', {}, 'Settings'),
      h('div.adder.remote', {}, remote, h<'button'>('button.primary', { onclick: () => void saveRemote() }, 'Save')),
      h('p.t-hint', {}, now.remote
        ? `The remote of this project${pushes ? `: ${now.branch || 'its branch'} is pushed there after every accept` : ''}. Empty it to take it away.`
        : 'A remote for this project: make an empty repository (on GitHub: New repository), and give its address.'),
      keep('commit', now.commit, 'Commit what is accepted'),
      keep('push', pushes, 'Push after every accept', !now.commit),
      h('p.t-hint', {}, now.commit
        ? 'Tandem commits an accepted change in the project. Switched off, it is written in the project\'s files and left for you to commit here, and nothing is pushed by itself.'
        : 'What is accepted is written in the project\'s files and left uncommitted: committing and pushing are yours, here.'));
  }

  return {
    id: 'git', title: 'Git',
    init(a) { app = a; },
    show(b) { body = b; paint(); void refresh(); },
    hide() { body = undefined; },
    // (Also while the tab is not showing: what it shows when it is opened is then how it stands.)
    event(ev: Event, live: boolean) { if (live && !busy && (body || last) && MOVES.has(ev.type)) void refresh(); },
  };
}
