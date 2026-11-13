// Everything at once. Tandem is started once; which project it works on is
// chosen in its page (or named here: `tandem <folder>`), and what was open
// last is opened again.
//   tandem's page    http://localhost:5173   (the phone page: the project in a frame, the tools over it)
//   the core         http://127.0.0.1:5201   (commands, events, the agent)
//   the project      http://localhost:5210   (its own page, started with the command from its tandem.json)
// All listen on this machine only: the core can start an agent with a command
// line, which is not something to offer the whole network.
// The core runs as a child that is started again when it asks to be: after a
// change to the code is accepted (exit code 75: it holds the project's adapter
// as it was when it started), and when another project is opened (76: then the
// project's page is started again too, on the new one). Tandem's page stays up.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, stopTree } from './project.ts';
import { SWITCH, readState, writeState } from './projects.ts';

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
    const command = project?.pageCommand(PAGE_PORT);
    if (project && command) {
      const mine = spawn('sh', ['-c', `exec ${command}`], { cwd: project.root, stdio: 'inherit', env, detached: true });
      page = mine;
      mine.on('exit', (code) => { if (!stopping && page === mine) console.log(`the project's page stopped (${code}): ${command}`); });
    } else if (project) console.log('the project has no page to show: say how it is started in tandem.json ("page"), with {port} where the port goes');
  }

  console.log(project ? `tandem: ${project.name}, in ${project.root}` : 'tandem: no project open; choose one in the page');
  core = spawn(process.execPath, ['--no-warnings', 'core/server.ts'], { cwd: ROOT, stdio: 'inherit', env: { ...env, TANDEM_SUPERVISED: '1' } });
  core.on('exit', (code) => {
    if (stopping) return;
    if (code === 75 || code === SWITCH) return void startProject();
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

// Tandem's own page.
const shell = spawn('npx', ['vite'], { cwd: ROOT, stdio: 'inherit', env: process.env, detached: true });
shell.on('exit', (code) => { if (!stopping) { console.log(`tandem's page stopped (${code})`); stop(code ?? 0); } });
startProject();
