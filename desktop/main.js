// Tandem in a window of its own. Tandem itself is started as it is from a
// terminal (core/start.ts, with the Node that is installed); this only waits
// for its page and shows it. When tandem is already running, the window shows
// that one. Closing the window stops what it started.
import { app, BrowserWindow } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.TANDEM_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = `http://127.0.0.1:${process.env.TANDEM_SHELL_PORT ?? 5173}/`;
const WINDOWS = process.platform === 'win32';

/** Tandem, when this window started it. */
let tandem;

const answers = () => fetch(SHELL).then((r) => r.ok, () => false);

function start() {
  const env = { ...process.env };
  // Tandem runs its command lines with sh, which on Windows is Git's; its installer does not put it on the PATH.
  const gitSh = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin');
  const path = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
  if (WINDOWS && existsSync(gitSh)) env[path] = `${gitSh};${env[path] ?? ''}`;
  // A release comes with tandem's page built, and then needs no Vite.
  if (existsSync(join(ROOT, 'dist', 'index.html'))) env.TANDEM_SHELL = 'built';
  tandem = spawn('node', ['--no-warnings', 'core/start.ts'], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  tandem.on('exit', () => { tandem = undefined; app.quit(); });
}

function stop() {
  if (!tandem?.pid) return;
  if (WINDOWS) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(tandem.pid)], { stdio: 'ignore', windowsHide: true }); } catch { tandem.kill(); } }
  else tandem.kill('SIGTERM');
}

// One tandem at a time: a second start shows the window that is there.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let win;
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => { stop(); app.quit(); });
  app.on('before-quit', stop);

  app.whenReady().then(async () => {
    win = new BrowserWindow({ width: 1400, height: 900, title: 'tandem', backgroundColor: '#111', autoHideMenuBar: true });
    win.loadURL(`data:text/html,<body style="background:%23111;color:%23aaa;font:14px sans-serif;display:grid;place-items:center;height:100vh;margin:0">tandem starts…</body>`);
    if (!(await answers())) start();
    while (!(await answers())) await new Promise((r) => setTimeout(r, 300));
    win.loadURL(SHELL);
  });
}
