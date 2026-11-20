// What tandem needs on this machine besides itself: Git (with its sh), Node.js and Claude Code. The settings show
// which version of each is there, and install or update one with a button: on Windows Git and Node.js through
// winget, Claude Code everywhere with its own installer and `claude update`. Elsewhere Git and Node.js are the
// system's package manager's.
import { execFile } from 'node:child_process';
import { CommandError, type CommandDef } from './commands.ts';

const WINDOWS = process.platform === 'win32';
const CLAUDE = () => process.env.CLAUDE_BIN ?? 'claude';

interface Dep {
  id: string;
  name: string;
  /** How its version is asked. */
  version: () => [string, string[]];
  /** How it is installed, and how it is updated, on this machine (none: not by tandem). */
  install?: [string, string[]];
  update?: [string, string[]];
}

const winget = (verb: 'install' | 'upgrade', id: string): [string, string[]] =>
  ['winget', [verb, '--id', id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']];

const DEPS: Dep[] = [
  {
    id: 'git', name: 'Git', version: () => ['git', ['--version']],
    ...(WINDOWS && { install: winget('install', 'Git.Git'), update: winget('upgrade', 'Git.Git') }),
  },
  {
    id: 'node', name: 'Node.js', version: () => ['node', ['--version']],
    ...(WINDOWS && { install: winget('install', 'OpenJS.NodeJS.LTS'), update: winget('upgrade', 'OpenJS.NodeJS.LTS') }),
  },
  {
    id: 'claude', name: 'Claude Code', version: () => [CLAUDE(), ['--version']],
    install: WINDOWS
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']]
      : ['sh', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']],
    update: [CLAUDE(), ['update']],
  },
];

function run(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 10e6 }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}\n${stderr}`.trim() }));
  });
}

async function versionOf(dep: Dep): Promise<string | null> {
  const [cmd, args] = dep.version();
  const got = await run(cmd, args, 15_000);
  return got.ok ? got.out.split('\n')[0].trim() : null;
}

/** What an installer put on the PATH is there for the next process; this one reads it again (Windows keeps it in the registry). */
async function freshPath() {
  if (!WINDOWS) return;
  const got = await run('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], 15_000);
  if (!got.ok || !got.out) return;
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
  // (What tandem itself put in front, Git's sh, stays.)
  const own = (process.env[key] ?? '').split(';').filter((p) => /\\Git\\usr\\bin$/i.test(p));
  process.env[key] = [...own, got.out.trim()].join(';');
}

export function depCommands(): CommandDef[] {
  const list = () => Promise.all(DEPS.map(async (d) => ({
    id: d.id, name: d.name, version: await versionOf(d), install: !!d.install, update: !!d.update,
  })));
  return [
    {
      name: 'deps.list', kind: 'read',
      about: 'What tandem needs on this machine (Git, Node.js, Claude Code): the version of each that is there (null: it is not), and whether tandem can install or update it here.',
      run: () => list(),
    },
    {
      name: 'deps.install', kind: 'write',
      about: 'Install one of what tandem needs (deps.list) when it is not there, or update it when it is. Takes a while. Node.js that was updated is used once tandem is started again.',
      input: { id: 'string' },
      async run(_c, i) {
        const dep = DEPS.find((d) => d.id === i.id);
        if (!dep) throw new CommandError('input', `there is no ${i.id}; there are: ${DEPS.map((d) => d.id).join(', ')}`);
        const was = await versionOf(dep);
        const how = was ? dep.update : dep.install;
        if (!how) throw new CommandError('unsupported', `${dep.name} is ${was ? 'updated' : 'installed'} with the system's package manager here, not by tandem`);
        const got = await run(how[0], how[1], 15 * 60_000);
        // (winget says so, and stops with an error, when there is nothing newer.)
        const newest = /No (available|applicable) (upgrade|update)|is up to date|already (installed|up to date|on the latest)/i.test(got.out);
        if (!got.ok && !newest) throw new CommandError('failed', `${dep.name} could not be ${was ? 'updated' : 'installed'}: ${got.out.split('\n').filter(Boolean).slice(-3).join(' ')}`);
        await freshPath();
        const now = await versionOf(dep);
        return {
          id: dep.id, was, version: now,
          said: !now ? `${dep.name} was installed, but tandem does not find it yet; start tandem again.`
            : was && now === was ? `${dep.name} is the newest already (${now}).`
            : `${dep.name} is ${now}${was ? ` (was ${was})` : ''}.${dep.id === 'node' ? ' Tandem runs on it once it is started again.' : ''}`,
        };
      },
    },
  ];
}
