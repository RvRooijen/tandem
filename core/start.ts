// Everything at once: the core server and the shell's page. `npm start`.
//   the shell   http://localhost:5173   (the phone page)
//   the core    http://127.0.0.1:5201   (commands, events, the agent)
// Both listen on this machine only: the core can start an agent with a command
// line, which is not something to offer the whole network.
// The core runs as a child that is started again when it asks to be (exit
// code 75): it holds the game's code as it was when it started, so after a
// change to that code is accepted it needs a fresh start. The page stays up.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let core: ChildProcess | undefined;
let stopping = false;

function startCore() {
  core = spawn(process.execPath, ['--no-warnings', 'core/server.ts'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TANDEM_SUPERVISED: '1' } });
  core.on('exit', (code) => {
    if (stopping) return;
    if (code === 75) { console.log('the core starts again, with the game as it is now'); return void startCore(); }
    console.log(`the core stopped (${code})`);
    vite.kill();
    process.exit(code ?? 1);
  });
}

const vite = spawn('npx', ['vite', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
const stop = () => { stopping = true; core?.kill(); vite.kill(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', (code) => { if (!stopping) { console.log(`the shell stopped (${code})`); stopping = true; core?.kill(); process.exit(code ?? 0); } });
startCore();
