// Art as a sense and as work to hand out. The game's drawings are made in
// pixeldraw (a project of its own, next to this one); from here they can be
// listed and looked at, a pixeldraw worker can be asked to draw or redraw one,
// and what it made can be accepted and brought into the game. pixeldraw's own
// viewer stays the place to watch a worker draw.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandError, type CommandDef } from './commands.ts';
import type { EventLog } from './events.ts';
import type { Drawing } from './game.ts';
import { runJob } from './jobs.ts';

export interface ArtOptions {
  game: string;
  root: string;
  events: EventLog;
  newLookFile(): { file: string; url: string };
}

export const PIXELDRAW = process.env.PIXELDRAW ?? resolve(import.meta.dirname, '../../pixeldraw');

function sh(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 4e6 }, (err, stdout, stderr) => {
      if (err) fail(new CommandError('failed', (stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')));
      else ok(stdout.trim());
    });
  });
}

export function artCommands(o: ArtOptions): CommandDef[] {
  const pixeldraw = (...args: string[]) => {
    if (!existsSync(join(PIXELDRAW, 'scripts/api.js'))) throw new CommandError('unsupported', `pixeldraw is not at ${PIXELDRAW}; say where with PIXELDRAW=`);
    return sh(process.execPath, ['scripts/api.js', ...args], PIXELDRAW).catch((e: Error) => {
      throw new CommandError('failed', /fetch failed|ECONNREFUSED/.test(e.message) ? 'pixeldraw is not running: start its viewer (npm run dev) and its worker (npm run worker) there' : e.message);
    });
  };
  const worker = (w: string) => {
    if (!/^[a-z0-9-]+$/i.test(w)) throw new CommandError('input', 'a worker is named by its id, as art.workers lists them');
    return w;
  };

  return [
    {
      name: 'art.list', kind: 'read',
      about: 'The drawings the game is made of: the size of each, its looks, and its animations with how many frames they have.',
      run: async () => (await runJob<{ drawings: Drawing[] }>({ game: o.game, do: 'art' })).drawings,
    },
    {
      name: 'art.look', kind: 'look',
      about: 'A sheet of one drawing as a picture: one frame of every animation, or with anim every frame of that one. The file can be read as an image.',
      input: { name: 'string', look: 'string?', anim: 'string?' },
      async run(c, i) {
        const look = o.newLookFile();
        const res = await runJob<{ frames: string[]; scale: number }>({ game: o.game, do: 'art', name: i.name, look: i.look, anim: i.anim, out: look.file })
          .catch((e: Error) => { throw new CommandError('missing', e.message); });
        const caption = `drawing ${i.name}${i.anim ? `, ${i.anim}` : ''}`;
        o.events.add({ type: 'look', by: c.by, url: look.url, caption, text: res.frames.join(', ') });
        return { ...look, frames: res.frames, scale: res.scale };
      },
    },
    {
      name: 'art.ask', kind: 'write', agent: 'free',
      about: 'Ask a pixeldraw worker to change a drawing (name is an existing one) or make a new one (new: true), with a brief in plain words. It draws in pixeldraw and waits there for approval; nothing reaches the game until art.accept and art.import.',
      input: { name: 'string', message: 'string', new: 'boolean?' },
      async run(c, i) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(i.name)) throw new CommandError('input', 'a drawing is named in lower-case words with dashes');
        const out = await pixeldraw('start', JSON.stringify({ kind: i.new ? 'new' : 'feedback', name: i.name, message: i.message }));
        const id = out.split('\n')[0].trim();
        o.events.add({ type: 'art.asked', by: c.by, name: i.name, message: i.message, worker: id });
        return { worker: id, says: 'a worker is drawing; see art.workers' };
      },
    },
    {
      name: 'art.workers', kind: 'read',
      about: 'The pixeldraw workers that are open: what each is drawing, whether it is running or waiting for approval, and which drawings it changed.',
      run: async () => ({ workers: await pixeldraw('workers') }),
    },
    {
      name: 'art.tell', kind: 'write', agent: 'free',
      about: 'Give a pixeldraw worker feedback, or answer its question: it does another round.',
      input: { worker: 'string', message: 'string' },
      run: async (_c, i) => ({ says: await pixeldraw('tell', worker(i.worker), i.message) || 'told' }),
    },
    {
      name: 'art.approve', kind: 'write', agent: 'free',
      about: 'Approve the silhouette a pixeldraw worker is waiting with: it goes on with colour.',
      input: { worker: 'string', message: 'string?' },
      run: async (_c, i) => ({ says: await pixeldraw('approve', worker(i.worker), ...(i.message ? [i.message] : [])) || 'approved' }),
    },
    {
      name: 'art.accept', kind: 'write',
      about: 'Accept what a pixeldraw worker drew: its changes go into the real drawings in pixeldraw. Then art.import brings them into the game.',
      input: { worker: 'string' },
      async run(c, i) {
        const says = await pixeldraw('accept', worker(i.worker));
        o.events.add({ type: 'art.accepted', by: c.by, worker: i.worker });
        return { says: says || 'accepted' };
      },
    },
    {
      name: 'art.import', kind: 'write',
      about: 'Bring the drawings in from pixeldraw as they are now: the game is rebuilt with them and the page reloads.',
      async run(c) {
        const tool = join(o.root, 'games', o.game, 'tools/import-art.ts');
        if (!existsSync(tool)) throw new CommandError('unsupported', `${o.game} has no tools/import-art.ts`);
        await sh(process.execPath, ['--no-warnings', tool], join(o.root, 'games', o.game));
        const drawings = (await runJob<{ drawings: Drawing[] }>({ game: o.game, do: 'art' })).drawings;
        o.events.add({ type: 'art.imported', by: c.by, drawings: drawings.length });
        return { imported: drawings.length };
      },
    },
  ];
}
