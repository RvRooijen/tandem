// Everything at once. Tandem is started once; which project it works on is
// chosen in its page (or named here: `tandem <folder>`), and what was open
// last is opened again.
//   tandem's page    http://localhost:5173   (the phone page: the project in a frame, the tools over it)
//   the core         http://127.0.0.1:5201   (commands, events, the agent)
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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETUP, loadProject, stopTree } from './project.ts';
import { SWITCH, readState, writeState } from './projects.ts';
import { innerPort, startThrough } from './through.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE_PORT = Number(process.env.TANDEM_PAGE_PORT ?? 5210);
let core: ChildProcess | undefined, page: ChildProcess | undefined, paging: string | undefined;
let stopping = false;

// A folder named on the command line is the one to open; otherwise the one that was open last.
const named = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.env.TANDEM_PROJECT;
if (named) writeState({ ...readState(), project: resolve(named) });

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
      const mine = spawn('sh', ['-c', command], { cwd: project.root, stdio: 'inherit', env, detached: true });
      page = mine;
      mine.on('exit', (code) => { if (!stopping && page === mine) console.log(`the project's page stopped (${code}): ${command}`); });
    } else if (project) console.log('the project has no page to show: say how it is started in tandem.json ("page"), with {port} where the port goes');
  }

  console.log(project ? `tandem: ${project.name}, in ${project.root}` : 'tandem: no project open; choose one in the page');
  core = spawn(process.execPath, ['--no-warnings', 'core/server.ts'], { cwd: ROOT, stdio: 'inherit', env: { ...env, TANDEM_SUPERVISED: '1' } });
  core.on('exit', (code) => {
    if (stopping) return;
    // How the project is run was changed: its page is started again too, with the new command.
    if (code === SETUP) paging = undefined;
    if (code === 75 || code === SWITCH || code === SETUP) return void startProject();
    console.log(`the core stopped (${code})`);
    stop(code ?? 1);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  core?.kill();
  stopTree(page);
  stopTree(shell);
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

// The project's page goes through tandem: as it is, with tandem's few lines added to it, so that things on it can
// be pointed at. Whatever project is open, it is shown on this port.
startThrough({ port: PAGE_PORT, to: innerPort(PAGE_PORT) }).catch((e) => console.log(`the project's page cannot be shown on port ${PAGE_PORT}: ${e instanceof Error ? e.message : e}`));

// Tandem's own page.
const shell = spawn('npx', ['vite'], { cwd: ROOT, stdio: 'inherit', env: process.env, detached: true });
shell.on('exit', (code) => { if (!stopping) { console.log(`tandem's page stopped (${code})`); stop(code ?? 0); } });
startProject();
