// Playing the working copy: the project's own page, started a second time from
// the agent's working copy on a port of its own, so the person can play what
// the agent coded before any of it is in the project. Started when first asked
// for.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { stopTree, type Project } from './project.ts';
import { innerPort, startThrough } from './through.ts';

export const COPY_PORT = Number(process.env.TANDEM_COPY_PORT ?? 5211);

/** `copy` gives the working copy as a project; it is asked for when the page is, because the copy is made late. */
export function createPreview(copy: () => Project) {
  let proc: ChildProcess | undefined;
  // Like the project's own page, the copy's runs on an inner port and is shown through tandem.
  let through: Promise<Server> | undefined;
  const up = async () => {
    try { return (await fetch(`http://127.0.0.1:${COPY_PORT}/`, { signal: AbortSignal.timeout(1500) })).status < 500; } catch { return false; }
  };
  return {
    /** The address of the working copy's page; starts it if it is not running. */
    async url(): Promise<string> {
      if (!(await up())) {
        stopTree(proc);
        const at = copy();
        through ??= startThrough({ port: COPY_PORT, to: innerPort(COPY_PORT) });
        try { await through; } catch (e) { through = undefined; throw e; }
        const command = at.pageCommand(innerPort(COPY_PORT));
        if (!command) throw new Error('the project has no page to start');
        proc = spawn('sh', ['-c', command], { cwd: at.root, stdio: 'ignore', env: { ...process.env, TANDEM_COPY: '1' }, detached: true });
        for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
        if (!(await up())) throw new Error(`the page of the working copy did not start (${command})`);
      }
      return `http://localhost:${COPY_PORT}/`;
    },
    stop() { stopTree(proc); proc = undefined; void through?.then((s) => s.close(), () => {}); through = undefined; },
  };
}

export type Preview = ReturnType<typeof createPreview>;
