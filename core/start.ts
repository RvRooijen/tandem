// Everything at once, for the project tandem is started in (or the folder
// given): the core, tandem's own page, and the project's page.
//   tandem's page    http://localhost:5173   (the phone page: the project in a frame, the tools over it)
//   the core         http://127.0.0.1:5201   (commands, events, the agent)
//   the project      http://localhost:5210   (its own page, started with the command from tandem.json)
// All listen on this machine only: the core can start an agent with a command
// line, which is not something to offer the whole network.
// The core runs as a child that is started again when it asks to be (exit
// code 75): it holds the project's adapter as it was when it started, so after
// a change to the code is accepted it needs a fresh start. The pages stay up.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from './project.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.env.TANDEM_PROJECT ?? process.cwd());
const project = loadProject(dir);
const PAGE_PORT = Number(process.env.TANDEM_PAGE_PORT ?? 5210);
const env = { ...process.env, TANDEM_PROJECT: project.root, TANDEM_PAGE_PORT: String(PAGE_PORT) };
const children: ChildProcess[] = [];
let core: ChildProcess | undefined;
let stopping = false;

function startCore() {
  core = spawn(process.execPath, ['--no-warnings', 'core/server.ts'], { cwd: ROOT, stdio: 'inherit', env: { ...env, TANDEM_SUPERVISED: '1' } });
  core.on('exit', (code) => {
    if (stopping) return;
    if (code === 75) { console.log('the core starts again, with the project as it is now'); return void startCore(); }
    console.log(`the core stopped (${code})`);
    stop(code ?? 1);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  core?.kill();
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

console.log(`tandem: ${project.name}, in ${project.root}`);
// Tandem's own page.
const shell = spawn('npx', ['vite'], { cwd: ROOT, stdio: 'inherit', env });
children.push(shell);
shell.on('exit', (code) => { if (!stopping) { console.log(`tandem's page stopped (${code})`); stop(code ?? 0); } });
// The project's page, when it has one.
const command = project.pageCommand(PAGE_PORT);
if (command) {
  const page = spawn('sh', ['-c', `exec ${command}`], { cwd: project.root, stdio: 'inherit', env });
  children.push(page);
  page.on('exit', (code) => { if (!stopping) console.log(`the project's page stopped (${code}): ${command}`); });
} else console.log('the project has no page to show: say how it is started in tandem.json ("page"), with {port} where the port goes');
startCore();
