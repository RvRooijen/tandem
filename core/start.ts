// Everything at once: the core server and the shell's page. `npm start`.
//   the shell   http://localhost:5200   (the phone page)
//   the core    http://127.0.0.1:5201   (commands, events, the agent)
// Both listen on this machine only: the core can start an agent with a command
// line, which is not something to offer the whole network.
import { spawn } from 'node:child_process';
import { ROOT } from './host.ts';
import { startServer } from './server.ts';

const s = await startServer();
console.log(`tandem core: ${s.host.game.name} on http://127.0.0.1:${s.port}/api  (${s.host.registry.list().length} commands, agent ${process.env.TANDEM_AGENT === 'off' ? 'off' : 'on'})`);

const vite = spawn('npx', ['vite', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
const stop = () => { vite.kill(); void s.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', (code) => { console.log(`the shell stopped (${code})`); void s.close().then(() => process.exit(code ?? 0)); });
