// Starting a job (see job.ts) and waiting for what it says.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JobSpec } from './job.ts';

const JOB = fileURLToPath(new URL('./job.ts', import.meta.url));

export function runJob<T>(spec: JobSpec, timeoutMs = 10 * 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', JOB], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the ${spec.do} job took more than ${timeoutMs / 1000}s and was stopped`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = out.match(/@@result (.*)\n?$/);
      if (code === 0 && m) resolve(JSON.parse(m[1]) as T);
      else reject(new Error(`the ${spec.do} job failed: ${(err || out).trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`));
    });
    child.stdin.end(JSON.stringify(spec));
  });
}
