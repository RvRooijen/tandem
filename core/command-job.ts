// A project's own commands (its module, {tandem}/commands.ts), run in a process of their own: a mistake in the
// module does not take the core with it, and a changed module counts from the next call on. Run in the project's
// folder or in the agent's working copy; reads one spec from stdin and says its result as job.ts does.
//
// The module exports `commands`, a list of
//   { name, about, kind: 'read' | 'write', input?: { field: 'string' | 'number' | 'boolean' | 'json' (+ '?') },
//     run(input, t) }
// where t is what a command has to work with: the folder it runs in (root, and copy: whether that is the working
// copy), request(path, { method, body, headers }) to the server of the project's page (or the copy's), query(file,
// sql, params) on a SQLite file, read-only, and sh(command) for a command line in that folder.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query } from './sqlite.ts';

export interface CommandSpec {
  do: 'describe' | 'run';
  /** The module, wherever it is kept (the project's, or the one a proposal brings). */
  module: string;
  copy: boolean;
  /** Where the server of the page is, when there is one. */
  page?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ProjectCommand {
  name: string;
  about: string;
  kind: 'read' | 'write';
  input?: Record<string, string>;
  run(input: Record<string, unknown>, t: Tools): unknown;
}

export interface Tools {
  root: string;
  copy: boolean;
  request(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; type: string; body: unknown }>;
  query(file: string, sql: string, params?: unknown[]): { columns: string[]; rows: unknown[][]; more: boolean };
  sh(command: string, opts?: { timeoutMs?: number }): Promise<{ code: number; out: string }>;
}

process.on('uncaughtException', (e) => { process.stdout.write('\n@@error ' + JSON.stringify(e instanceof Error ? e.message : String(e)) + '\n'); process.exit(1); });
process.on('unhandledRejection', (e) => { process.stdout.write('\n@@error ' + JSON.stringify(e instanceof Error ? e.message : String(e)) + '\n'); process.exit(1); });

const spec = JSON.parse(readFileSync(0, 'utf8')) as CommandSpec;
const root = process.cwd();
// (A changed module is a new file name to import: the query string sees to that across calls, not within one.)
const mod = (await import(`${pathToFileURL(spec.module).href}?t=${Date.now()}`)) as { commands?: ProjectCommand[] };
if (!Array.isArray(mod.commands)) throw new Error('the project\'s commands.ts does not export `commands`, a list');
const list = mod.commands;

let result: unknown;
if (spec.do === 'describe') {
  result = list.map((c) => ({ name: String(c.name), about: String(c.about ?? ''), kind: c.kind === 'write' ? 'write' : 'read', input: c.input ?? {} }));
} else {
  const c = list.find((x) => x.name === spec.name);
  if (!c) throw new Error(`the project has no command called ${spec.name}`);
  const t: Tools = {
    root, copy: spec.copy,
    async request(path, init = {}) {
      if (!spec.page) throw new Error('the project has no page whose server could be asked');
      const method = (init.method ?? (init.body === undefined ? 'GET' : 'POST')).toUpperCase();
      const headers: Record<string, string> = { ...init.headers };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        if (typeof init.body !== 'string') headers['content-type'] ??= 'application/json';
      }
      const res = await fetch(new URL(path, spec.page), { method, headers, body });
      const type = res.headers.get('content-type') ?? '';
      const text = await res.text();
      let parsed: unknown = text;
      if (/json/.test(type)) { try { parsed = JSON.parse(text); } catch { /* as text */ } }
      return { status: res.status, type, body: parsed };
    },
    query: (file, sql, params) => query(resolve(root, file), sql, params),
    sh: (command, opts = {}) => new Promise((done) => {
      execFile('sh', ['-c', command], { cwd: root, timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 20e6 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        done({ code, out: `${stdout}${stderr}`.trim().slice(-20_000) });
      });
    }),
  };
  result = await c.run(spec.input ?? {}, t);
}
process.stdout.write('\n@@result ' + JSON.stringify(result ?? null) + '\n');
