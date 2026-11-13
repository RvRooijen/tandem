// Playing the working copy: a second page server, run from the agent's working
// copy, so the person can play what the agent coded before any of it is in the
// project. It talks to the same core. Started when first asked for.
import { spawn, type ChildProcess } from 'node:child_process';

export const PREVIEW_PORT = Number(process.env.TANDEM_PREVIEW_PORT ?? 5174);

export function createPreview(work: string) {
  let proc: ChildProcess | undefined;
  const up = async () => {
    try { return (await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  };
  return {
    /** The address of the working copy's page; starts its server if it is not running. */
    async url(): Promise<string> {
      if (!(await up())) {
        proc?.kill();
        proc = spawn('npx', ['vite', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: work, stdio: 'ignore', env: { ...process.env, TANDEM_PREVIEW: '1' } });
        for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
        if (!(await up())) throw new Error('the page of the working copy did not start');
      }
      return `http://localhost:${PREVIEW_PORT}/?preview`;
    },
    stop() { proc?.kill(); proc = undefined; },
  };
}
