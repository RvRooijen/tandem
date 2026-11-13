// Starting a job (see job.ts) and waiting for what it says.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobSpec } from './job.ts';

export type { JobSpec };

const ENGINE = fileURLToPath(new URL('..', import.meta.url));

/** Run a job in a copy of the project: the project itself, or the agent's working copy. */
export function runJob<T>(spec: JobSpec, opts: { root: string; timeoutMs?: number }): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return new Promise((resolve, reject) => {
    // The job is the engine's; what it loads (the adapter, and through it the project) is the copy's.
    const child = spawn(process.execPath, ['--no-warnings', join(ENGINE, 'core/job.ts')], { cwd: opts.root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the ${spec.do} job took more than ${timeoutMs / 1000}s and was stopped`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = out.match(/@@result (.*)\n?$/);
      const said = out.match(/@@error (.*)\n?$/);
      if (code === 0 && m) resolve(JSON.parse(m[1]) as T);
      else if (said) reject(new Error(JSON.parse(said[1])));
      else reject(new Error(`the ${spec.do} job failed: ${(err || out).trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`));
    });
    child.stdin.end(JSON.stringify(spec));
  });
}
