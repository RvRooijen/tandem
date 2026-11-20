// What there is to see of a project besides its page: the views, each a tab over the stage. A view is a page of
// HTML in a frame, with tandem's lines in it (bridge/page.js, so what is on it can be pointed at, and
// bridge/view.js, the way it asks for what it shows). Tandem has three kinds of its own (views/: logs, api, data);
// a project can have pages of its own ({tandem}/views), made for it by the agent. A view gets what it shows only
// through commands, the same ones the agent has: what the page says while it runs (logs.read), a SQLite file
// (data.tables, data.query), the project's server (page.request, api.endpoints) and the project's own commands
// (project.commands, project.run), which its module ({tandem}/commands.ts) brings, run in a job of their own.
//
// Everything has `copy`: the same view of the agent's working copy. While a change to how the project is run
// waits to be decided, the views are as they would be with it: a view it brings or changes is there to try, and
// so are the commands it brings.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, check, isAgent, type By, type CommandDef } from './commands.ts';
import type { CommandSpec } from './command-job.ts';
import { runScript } from './jobs.ts';
import type { Project, ViewDef } from './project.ts';
import type { Proposal, RecordValue } from './proposals.ts';
import { query, tables } from './sqlite.ts';
import { within } from './paths.ts';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
export const KINDS = ['logs', 'api', 'data'] as const;

/** A file of tandem's folder that a change to how the project is run can bring: a view's page, or the project's commands. */
export const isSetupFile = (key: string) => key === 'commands.ts' || /^views\/[\w-]+\.html$/.test(key);

/** A list of views as the person or the agent says it, checked; an empty list takes them all away. */
export function checkViews(list: unknown): ViewDef[] {
  if (!Array.isArray(list)) throw new CommandError('input', 'views is a list of views: { name, kind } with kind logs, api or data, or { name, view } for a page of the project\'s own');
  const names = new Set<string>();
  return list.map((v: Record<string, unknown>) => {
    if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name.trim()) throw new CommandError('input', 'every view has a name');
    if (names.has(v.name)) throw new CommandError('input', `two views are called ${v.name}`);
    names.add(v.name);
    if (v.kind !== undefined && !KINDS.includes(v.kind as never)) throw new CommandError('input', `${v.name}: kind is logs, api or data`);
    if ((v.kind === undefined) === (v.view === undefined)) throw new CommandError('input', `${v.name}: a view has a kind (logs, api, data) or is a page of the project's own (view: "<name>.html", in {tandem}/views)`);
    if (v.view !== undefined && (typeof v.view !== 'string' || !isSetupFile(`views/${v.view}`))) throw new CommandError('input', `${v.name}: view is the name of an .html file in {tandem}/views (letters, digits, - and _)`);
    if (v.kind === 'data' && (typeof v.file !== 'string' || !v.file)) throw new CommandError('input', `${v.name}: a data view names its SQLite file (file, in the project's folder)`);
    if (v.endpoints !== undefined && !(Array.isArray(v.endpoints) && v.endpoints.every((e: Record<string, unknown>) => e && typeof e.method === 'string' && typeof e.path === 'string' && e.path.startsWith('/'))))
      throw new CommandError('input', `${v.name}: endpoints is a list of { method, path, about?, body? }, each path starting with /`);
    if (v.openapi !== undefined && (typeof v.openapi !== 'string' || !v.openapi.startsWith('/'))) throw new CommandError('input', `${v.name}: openapi is the path of the OpenAPI document on the project's server`);
    const keep = ['name', 'kind', 'file', 'endpoints', 'openapi', 'view'];
    return Object.fromEntries(Object.entries(v).filter(([k]) => keep.includes(k))) as unknown as ViewDef;
  });
}

export interface ViewsDeps {
  project: Project;
  /** The working copy's folder, brought up to date; undefined when there is none. */
  copyRoot(): string | undefined;
  /** Where the server of the project's page answers, and the working copy's (started if it is not running). */
  pageAt(copy: boolean): Promise<string | undefined>;
  /** What the copy's page says while it runs. */
  copyLog: string;
  dataDir: string;
  /** How the project is run, as a change to it that waits would make it. */
  pendingSetup(): Proposal | undefined;
  request(by: By, i: { path: string; method?: string; copy?: boolean }): Promise<{ status: number; body?: string; type: string }>;
  /** An agent's call of a command that does something: it is proposed instead. */
  proposeRun(by: By, after: RecordValue, note: string): { proposed: string };
  events: { add(ev: Record<string, unknown>): unknown };
}

export function createViews(d: ViewsDeps) {
  const { project } = d;
  const pending = () => d.pendingSetup()?.after;

  /** The views as they are, or as the change that waits would make them. */
  function list(): ViewDef[] {
    const p = pending();
    return (p && Array.isArray(p.views) ? p.views : project.config.views ?? []) as unknown as ViewDef[];
  }
  /** A file of tandem's folder as it is, or as the change that waits would make it ('' is taken away). */
  function file(key: string): string | undefined {
    const p = pending();
    if (p && typeof p[key] === 'string') return (p[key] as string) || undefined;
    const at = join(project.dirs.tandem, key);
    return existsSync(at) ? readFileSync(at, 'utf8') : undefined;
  }
  /** Whether a view is new or changed by the change that waits. */
  function proposed(v: ViewDef): boolean {
    const p = pending();
    if (!p) return false;
    const was = (project.config.views ?? []).find((x) => x.name === v.name);
    if (Array.isArray(p.views) && JSON.stringify(was) !== JSON.stringify(v)) return true;
    return !!v.view && typeof p[`views/${v.view}`] === 'string';
  }
  function find(name: string): ViewDef {
    const v = list().find((x) => x.name === name);
    if (!v) throw new CommandError('missing', `there is no view called ${name}; there are: ${list().map((x) => x.name).join(', ') || 'none'}`);
    return v;
  }

  /** A folder to look in: the project's, or the working copy's. */
  function rootFor(copy?: boolean): string {
    if (!copy) return project.root;
    const root = d.copyRoot();
    if (!root) throw new CommandError('unsupported', 'there is no working copy here: the project is not in a repository');
    return root;
  }
  /** A file in that folder; never one outside it. */
  function inside(root: string, path: string): string {
    const at = resolve(root, path);
    const rel = within(root, at);
    if (!rel) throw new CommandError('input', `${path} is not a file in the project's folder`);
    if (!existsSync(at)) throw new CommandError('missing', `there is no ${rel}${root === project.root ? '' : ' in the working copy'}`);
    return at;
  }

  // ---- the project's own commands: what its module says it has, asked of a job once for each version of it
  let described: { key: string; list: Promise<Described[]> } | undefined;
  type Described = { name: string; about: string; kind: 'read' | 'write'; input: Record<string, string> };
  /** The module to load: the project's, or the one the change that waits brings (kept in tandem's data until then). */
  function module(): { path: string; key: string } | undefined {
    const text = file('commands.ts');
    if (text === undefined) return undefined;
    const key = createHash('sha1').update(text).digest('hex').slice(0, 12);
    const own = join(project.dirs.tandem, 'commands.ts');
    if (existsSync(own) && readFileSync(own, 'utf8') === text) return { path: own, key };
    const dir = join(d.dataDir, 'proposed');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'commands.ts');
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
    return { path, key };
  }
  async function job<T>(spec: Omit<CommandSpec, 'module' | 'page'>, root: string, write = false): Promise<T> {
    const m = module();
    if (!m) throw new CommandError('missing', 'the project has no commands of its own: they are made in {tandem}/commands.ts, with project.configure (files)');
    const page = await d.pageAt(spec.copy).catch(() => undefined);
    try {
      return await runScript<T>('core/command-job.ts', { ...spec, module: m.path, ...(page && { page }) }, { root, timeoutMs: write ? 60 * 60_000 : 2 * 60_000 });
    } catch (e) { throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
  }
  function commands(): Promise<Described[]> {
    const m = module();
    if (!m) return Promise.resolve([]);
    if (described?.key !== m.key) {
      const list = job<Described[]>({ do: 'describe', copy: false }, project.root);
      described = { key: m.key, list };
      list.catch(() => { if (described?.list === list) described = undefined; });
    }
    return described.list;
  }
  async function runCommand(by: By, name: string, input: Record<string, unknown>, copy: boolean) {
    const c = (await commands()).find((x) => x.name === name);
    if (!c) throw new CommandError('missing', `the project has no command called ${name}; see project.commands`);
    check({ name: `project.run ${name}`, input: c.input }, input);
    if (c.kind === 'write' && isAgent(by)) return d.proposeRun(by, { name, input: input as RecordValue, copy }, '');
    const result = await job<unknown>({ do: 'run', name, input, copy }, rootFor(copy), c.kind === 'write');
    if (c.kind === 'write') d.events.add({ type: 'project.ran', by, name, ...(copy && { copy }) });
    return result;
  }

  /** What a page of the project's server says it has, from its OpenAPI document. */
  async function openapi(path: string, copy: boolean) {
    const got = await d.request('me', { path, copy });
    if (got.status >= 400) throw new CommandError('failed', `the server answered ${got.status} for ${path}`);
    let doc: { paths?: Record<string, Record<string, { summary?: string; description?: string }>> };
    try { doc = JSON.parse(got.body ?? ''); } catch { throw new CommandError('failed', `${path} is not an OpenAPI document in JSON`); }
    return Object.entries(doc.paths ?? {}).flatMap(([p, ops]) => Object.entries(ops)
      .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map(([m, op]) => ({ method: m.toUpperCase(), path: p, ...((op.summary || op.description) && { about: op.summary || op.description }) })));
  }

  // ---- the page of a view, as the frame gets it
  const bridge = (name: string) => readFileSync(join(ENGINE, 'bridge', name), 'utf8');
  /** A view's page with tandem's lines in it; undefined when there is no such view. */
  function page(name: string, copy: boolean): string | undefined {
    const v = list().find((x) => x.name === name);
    if (!v) return undefined;
    const html = v.kind ? readFileSync(join(ENGINE, 'views', `${v.kind}.html`), 'utf8')
      : file(`views/${v.view}`) ?? `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;color:#9c9aae;background:#17161c;padding:24px"><b>${v.view} is not there yet.</b><p>It is made in {tandem}/views with project.configure (files).</p></body>`;
    const config = JSON.stringify({ ...v, copy }).replaceAll('<', '\\u003c');
    const tag = `<script>window.tandemView=${config};</script><script>${bridge('view.js')}</script><script>${bridge('page.js')}</script>`;
    const at = html.toLowerCase().indexOf('</head>');
    return at >= 0 ? html.slice(0, at) + tag + html.slice(at) : tag + html;
  }

  const defs: CommandDef[] = [
    {
      name: 'views.list', kind: 'read',
      about: 'The views of this project: what there is to see besides its page, each a tab over the person\'s stage (logs, api, data, or a page of the project\'s own). While a change to how the project is run waits, as it would be with it; proposed says which views it brings or changes.',
      run: () => list().map((v) => ({ name: v.name, kind: v.kind ?? 'view', url: `/api/view/${encodeURIComponent(v.name)}`, ...(proposed(v) && { proposed: true }) })),
    },
    {
      name: 'logs.read', kind: 'read',
      about: 'What the project\'s page (its server) has said while it runs, as tandem keeps it: the last part, or what came after `after` (the next you got last time). find keeps only the lines that have it in them. copy: true for the working copy\'s page. Answers with text, and next for the call after this one.',
      input: { after: 'number?', find: 'string?', copy: 'boolean?' },
      run(_c, i) {
        const at = i.copy ? d.copyLog : project.pageLog;
        if (!existsSync(at)) return { text: '', next: 0, none: i.copy ? 'the working copy\'s page has not been started' : 'nothing is kept yet: tandem keeps what the page says from when it starts it' };
        const size = statSync(at).size;
        // (A page started again has a log of its own: what was asked after is gone, so it is read from the start.)
        const reset = typeof i.after === 'number' && i.after > size;
        let from = typeof i.after === 'number' && !reset ? i.after : Math.max(0, size - 64_000);
        if (size - from > 400_000) from = size - 400_000;
        const fd = openSync(at, 'r');
        const buf = Buffer.alloc(size - from);
        try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
        let text = buf.toString('utf8');
        // (Read from the middle, the first line is only part of one.)
        if (from > 0 && (typeof i.after !== 'number' || reset)) text = text.slice(text.indexOf('\n') + 1);
        // eslint-disable-next-line no-control-regex
        text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        if (i.find) { const f = i.find.toLowerCase(); text = text.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n'); }
        return { text, next: size, ...(reset && { reset: true }) };
      },
    },
    {
      name: 'data.tables', kind: 'read',
      about: 'The tables of a SQLite file in the project (file: its path in the project\'s folder): their columns, and how many rows each has. Read-only. copy: true for the file in the working copy.',
      input: { file: 'string', copy: 'boolean?' },
      run(_c, i) {
        try { return tables(inside(rootFor(i.copy), i.file)); } catch (e) { if (e instanceof CommandError) throw e; throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
      },
    },
    {
      name: 'data.query', kind: 'read',
      about: 'Ask a SQLite file in the project (file: its path in the project\'s folder) one SQL question, read-only: nothing in it can be changed this way. params fills in the ? in it. Answers with the columns and at most limit rows (500), and more when there were more. copy: true for the file in the working copy.',
      input: { file: 'string', sql: 'string', params: 'json?', limit: 'number?', copy: 'boolean?' },
      run(_c, i) {
        if (i.params !== undefined && !Array.isArray(i.params)) throw new CommandError('input', 'params is a list, one value for each ? in the sql');
        try { return query(inside(rootFor(i.copy), i.file), i.sql, i.params, Math.max(1, Math.min(i.limit ?? 500, 5000))); } catch (e) { if (e instanceof CommandError) throw e; throw new CommandError('failed', e instanceof Error ? e.message : String(e)); }
      },
    },
    {
      name: 'api.endpoints', kind: 'read',
      about: 'The endpoints of the project\'s server, as an api view says them (view: which one, when there are more): its list, or what its OpenAPI document says. Call one with page.request. copy: true asks the working copy\'s server for its OpenAPI document.',
      input: { view: 'string?', copy: 'boolean?' },
      async run(_c, i) {
        const v = i.view ? find(i.view) : list().find((x) => x.kind === 'api');
        if (!v || v.kind !== 'api') throw new CommandError('missing', i.view ? `${i.view} is not an api view` : 'the project has no api view');
        return [...(v.endpoints ?? []), ...(v.openapi ? await openapi(v.openapi, !!i.copy) : [])];
      },
    },
    {
      name: 'project.commands', kind: 'read',
      about: 'The project\'s own commands, from its module ({tandem}/commands.ts): what each is for, whether it only reads (read) or does something (write), and what it takes. Run one with project.run.',
      run: () => commands(),
    },
    {
      name: 'project.run', kind: 'write', agent: 'proposes',
      about: 'Run one of the project\'s own commands (project.commands): name, and input as it takes it. In the project\'s folder, or with copy: true in the working copy. One that only reads answers at once; the agent\'s call of one that does something is a proposal, run when the person accepts it.',
      input: { name: 'string', input: 'json?', copy: 'boolean?' },
      run(c, i) {
        if (i.input !== undefined && (typeof i.input !== 'object' || i.input === null || Array.isArray(i.input))) throw new CommandError('input', 'input is an object of what the command takes');
        return runCommand(c.by, i.name, (i.input ?? {}) as Record<string, unknown>, !!i.copy);
      },
    },
  ];

  return {
    commands: defs,
    list,
    page,
    find,
    /** A proposed run of one of the project's commands, accepted: it is done now, by whoever accepted it. */
    async accepted(p: Proposal, by: By) {
      const { name, input, copy } = p.after as { name: string; input?: Record<string, unknown>; copy?: boolean };
      try {
        const result = await job<unknown>({ do: 'run', name, input: input ?? {}, copy: !!copy }, rootFor(copy), true);
        const said = JSON.stringify(result ?? null);
        d.events.add({ type: 'project.ran', by, name, ...(copy && { copy }), proposal: p.id, result: said.length > 4000 ? `${said.slice(0, 4000)}…` : said });
      } catch (e) {
        d.events.add({ type: 'project.ran', by, name, ...(copy && { copy }), proposal: p.id, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

export type Views = ReturnType<typeof createViews>;
