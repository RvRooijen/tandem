// Everything at once. Tandem is started once; which project it works on is
// chosen in its page (or named here: `tandem <folder>`), and what was open
// last is opened again.
//   tandem's page    http://localhost:5173   (the phone page: the project in a frame, the tools over it)
//   the core         http://127.0.0.1:5201   (commands, events, the agent)
//   what it is doing http://127.0.0.1:5202   (while the core is starting and cannot answer yet)
//   the project      http://localhost:5210   (its own page, started with the command tandem was given for it, on an
//                                            inner port, and shown through tandem: core/through.ts)
// All listen on this machine only: the core can start an agent with a command
// line, which is not something to offer the whole network.
// The core runs as a child that is started again when it asks to be: after a
// change to the code is accepted (exit code 75: it holds the project's adapter
// as it was when it started), and when another project is opened (76: then the
// project's page is started again too, on the new one; 77: how the project is
// run was changed, and its page is started again with that). Tandem's page stays up.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETUP, loadProject, startTree, stopTree } from './project.ts';
import { SWITCH, opening, readState, writeState } from './projects.ts';
import { innerPort, startThrough } from './through.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE_PORT = Number(process.env.TANDEM_PAGE_PORT ?? 5210);
const STATUS_PORT = Number(process.env.TANDEM_STATUS_PORT ?? 5202);
/** What is being started, and how far that is; `doing` is empty once the core answers for itself. */
let starting = { name: '', root: '', doing: '', since: Date.now() };
let core: ChildProcess | undefined, page: ChildProcess | undefined, paging: string | undefined;
let stopping = false;

// A folder named on the command line is the one to open; otherwise the one that was open last.
const named = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.env.TANDEM_PROJECT;
if (named) writeState(opening(resolve(named)));

function startProject() {
  const dir = readState().project;
  const project = dir && existsSync(dir) ? loadProject(dir) : undefined;
  const env = { ...process.env, TANDEM_PROJECT: project?.root ?? '', TANDEM_PAGE_PORT: String(PAGE_PORT) };

  // The project's page, when it has one; it stays up while the core starts again on the same project.
  if (paging !== project?.root) {
    stopTree(page);
    page = undefined;
    paging = project?.root;
    // The page itself runs on an inner port; it is shown through tandem, on the port it is known at (see below).
    const command = project?.pageCommand(innerPort(PAGE_PORT));
    if (project && command) {
      const mine = startTree(command, { cwd: project.root, env, stdio: ['inherit', 'pipe', 'pipe'] });
      keepLog(mine, project.pageLog);
      page = mine;
      mine.on('exit', (code) => { if (!stopping && page === mine) console.log(`the project's page stopped (${code}): ${command}`); });
    } else if (project) console.log('the project has no page to show: say how it is started in tandem.json ("page"), with {port} where the port goes');
  }

  console.log(project ? `tandem: ${project.name}, in ${project.root}` : 'tandem: no project open; choose one in the page');
  starting = { name: project?.name ?? '', root: project?.root ?? '', doing: 'starting the core', since: Date.now() };
  core = spawn(process.execPath, ['--no-warnings', 'core/server.ts'], { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...env, TANDEM_SUPERVISED: '1' } });
  core.on('message', (m: { doing?: string; up?: boolean }) => { starting.doing = m.up ? '' : String(m.doing ?? ''); });
  core.on('exit', (code) => {
    if (stopping) return;
    // How the project is run was changed: its page is started again too, with the new command.
    if (code === SETUP) paging = undefined;
    if (code === 75 || code === SWITCH || code === SETUP) return void startProject();
    console.log(`the core stopped (${code})`);
    stop(code ?? 1);
  });
}

/**
 * What the page says goes to the terminal as before, and into a file in the project's data (the logs a view shows).
 * Started anew with the page; when it grows past a few megabytes only its last part is kept.
 */
function keepLog(child: ChildProcess, file: string) {
  const MAX = 4_000_000, KEEP = 1_000_000;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  let size = 0;
  const take = (to: NodeJS.WriteStream) => (d: Buffer) => {
    to.write(d);
    try {
      appendFileSync(file, d);
      size += d.length;
      if (size > MAX) {
        const all = readFileSync(file);
        const nl = all.indexOf(10, all.length - KEEP);
        const from = nl < 0 ? all.length - KEEP : nl + 1;
        writeFileSync(file, all.subarray(from));
        size = all.length - from;
      }
    } catch { /* the terminal still has it */ }
  };
  child.stdout?.on('data', take(process.stdout));
  child.stderr?.on('data', take(process.stderr));
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  core?.kill();
  status.close();
  stopTree(page);
  stopTree(shell);
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
// (The terminal it was started in is closed.)
process.on('SIGHUP', () => stop());

// The project's page goes through tandem: as it is, with tandem's few lines added to it, so that things on it can
// be pointed at. Whatever project is open, it is shown on this port.
// (A tandem that was stopped a moment ago may still hold the port: tried for a while before giving up.)
(async () => {
  for (let tries = 0; ; tries++) {
    try { return void await startThrough({ port: PAGE_PORT, to: innerPort(PAGE_PORT) }); } catch (e) {
      if (stopping) return;
      if ((e as { code?: string }).code !== 'EADDRINUSE' || tries >= 40) return console.log(`the project's page cannot be shown on port ${PAGE_PORT}: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
})();

// While the core starts it cannot answer; this says what it is doing meanwhile (the page asks through /starting).
const status = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ...starting, seconds: Math.round((Date.now() - starting.since) / 1000) }));
});
status.on('error', (e) => console.log(`what the core is doing while it starts cannot be told on port ${STATUS_PORT}: ${e.message}`));
status.listen(STATUS_PORT, '127.0.0.1');

// Tandem's own page.
const shell = startTree('npx vite', { cwd: ROOT, env: process.env });
shell.on('exit', (code) => { if (!stopping) { console.log(`tandem's page stopped (${code})`); stop(code ?? 0); } });
startProject();
