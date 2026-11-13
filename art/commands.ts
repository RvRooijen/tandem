// Art as commands: the game's drawings listed, read and looked at; a drawing
// changed (by the person at once, by the agent as a proposal); and drawing
// work handed to a worker, which proposes what it drew. A drawing is a thing
// like a record: it can be proposed on, played, accepted, and locked.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, isAgent, type CommandDef } from '../core/commands.ts';
import type { EventLog } from '../core/events.ts';
import type { Locks } from '../core/locks.ts';
import type { Proposal, Proposals } from '../core/proposals.ts';
import { createPictures, type Pictures } from './pictures.ts';
import { describeDrawing } from './sprites.ts';
import { parseArt } from './src/parse.js';
import { createWorkers } from './workers.ts';
import { createWorkspaces, filesIn, validName } from './workspace.ts';

export interface ArtOptions {
  game: string;
  /** The engine's root, where a game's own build tool is found. */
  root: string;
  /** Where the game's drawings are: art/ and depth/ in here. */
  gameDir: string;
  dataDir: string;
  events: EventLog;
  proposals: Proposals;
  locks: Locks;
  newLookFile(): { file: string; url: string };
}

export function createArt(o: ArtOptions) {
  const spaces = createWorkspaces(o.gameDir, join(o.dataDir, 'art-work'));
  const pictureOf = createPictures(spaces, o.newLookFile);
  const workers = createWorkers({ spaces, events: o.events, proposals: o.proposals, pictures: pictureOf });
  const artFile = (name: string) => join(o.gameDir, 'art', `${name}.txt`);
  const depthFile = (name: string) => join(o.gameDir, 'depth', `${name}.txt`);
  const has = (name: string) => validName(name) && existsSync(artFile(name));

  function need(name: string) {
    if (!has(name)) throw new CommandError('missing', `there is no drawing called ${name}; there are: ${names().join(', ') || 'none'}`);
  }
  const names = () => Object.keys(filesIn(o.gameDir)).filter((p) => p.startsWith('art/')).map((p) => p.slice(4, -4));

  /** A drawing's text has to be something the format can read. */
  function check(text: string, what: string) {
    try { parseArt(text); } catch (e) { throw new CommandError('input', `${what} is not a drawing the format can read: ${e instanceof Error ? e.message : e}`); }
  }

  /** The game is built again with the drawings as they are now. */
  function build(): Promise<string> {
    const tool = join(o.root, 'games', o.game, 'tools/import-art.ts');
    if (!existsSync(tool)) return Promise.resolve('this game has no tools/import-art.ts; nothing was built');
    // A game that lives somewhere else (a test's scratch copy) builds next to itself, not into the real one.
    const real = join(o.root, 'games', o.game);
    const args = o.gameDir === real ? [] : [`--from=${o.gameDir}`, `--out=${join(o.dataDir, 'art.gen.ts')}`];
    return new Promise((ok, fail) => {
      execFile(process.execPath, ['--no-warnings', tool, ...args], { timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) fail(new CommandError('failed', `the drawings could not be built into the game: ${(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`));
        else ok(stdout.trim().split('\n').pop() ?? '');
      });
    });
  }

  /** Put a drawing in the game: its text, and its depth map when it comes with one. */
  function write(name: string, value: { text?: string; depth?: string }) {
    mkdirSync(join(o.gameDir, 'art'), { recursive: true });
    if (value.text !== undefined) writeFileSync(artFile(name), value.text);
    if (value.depth !== undefined) { mkdirSync(join(o.gameDir, 'depth'), { recursive: true }); writeFileSync(depthFile(name), value.depth); }
  }

  /** A picture of a drawing as some text would make it, without touching the real one. */
  async function picture(name: string, value: { text: string; depth?: string } | undefined, flags: string[] = [], file = `art/${name}.txt`) {
    const root = spaces.ensure('_look', true);
    if (value) {
      writeFileSync(join(root, 'art', `${name}.txt`), value.text);
      if (value.depth !== undefined) writeFileSync(join(root, 'depth', `${name}.txt`), value.depth);
    }
    const look = o.newLookFile();
    copyFileSync(await spaces.render('_look', file, flags), look.file);
    return look;
  }

  const worker = (id: string) => {
    const w = /^[\w-]+$/.test(id) ? workers.get(id) : undefined;
    if (!w) throw new CommandError('missing', `there is no worker ${id}; see art.workers`);
    return w;
  };
  const brief = (w: NonNullable<ReturnType<typeof workers.get>>) => ({ worker: w.id, drawing: w.names[0], state: w.state, phase: w.phase, doing: w.doing, minutes: Math.round((Date.now() - w.started) / 60_000) });

  const commands: CommandDef[] = [
    {
      name: 'art.list', kind: 'read',
      about: 'The game\'s drawings: the size of each, its looks (colour variants), its animations with how many frames, whether it has a depth map and whether it is locked.',
      run: () => names().map((n) => ({ ...describeDrawing(n, readFileSync(artFile(n), 'utf8')), depth: existsSync(depthFile(n)), locked: o.locks.has(`drawing:${n}`) })),
    },
    {
      name: 'art.get', kind: 'read',
      about: 'A drawing as it is written: its text (palette, shapes, frames) and its depth map. This is the drawing itself; a picture of it comes from art.look. With worker, as that worker has it in its own copy.',
      input: { name: 'string', worker: 'string?' },
      run(_c, i) {
        if (i.worker) {
          const root = spaces.dir(worker(i.worker).id);
          const at = (d: string) => join(root, d, `${i.name}.txt`);
          if (!validName(i.name) || !existsSync(at('art'))) return { name: i.name, text: '', worker: i.worker };
          return { name: i.name, text: readFileSync(at('art'), 'utf8'), depth: existsSync(at('depth')) ? readFileSync(at('depth'), 'utf8') : undefined, worker: i.worker };
        }
        need(i.name);
        return { name: i.name, text: readFileSync(artFile(i.name), 'utf8'), depth: existsSync(depthFile(i.name)) ? readFileSync(depthFile(i.name), 'utf8') : undefined, locked: o.locks.has(`drawing:${i.name}`) };
      },
    },
    {
      name: 'art.look', kind: 'look',
      about: 'A picture of a drawing: every animation as a row of frames, enlarged, with a small preview. anim and frame (from 1) narrow it down, look picks a colour variant, depth shows its depth map, worker shows a worker\'s version instead of the game\'s. The file can be read as an image.',
      input: { name: 'string', anim: 'string?', frame: 'number?', look: 'string?', depth: 'boolean?', worker: 'string?' },
      async run(c, i) {
        if (!validName(i.name)) throw new CommandError('input', 'a drawing is named in lower-case words with dashes');
        const flags = [i.anim && `--anim=${i.anim}`, i.frame && `--frame=${i.frame}`, i.look && i.look !== 'default' && `--recolor=${i.look}`].filter(Boolean) as string[];
        const file = `${i.depth ? 'depth' : 'art'}/${i.name}.txt`;
        let look;
        try {
          if (i.worker) {
            worker(i.worker);
            look = o.newLookFile();
            copyFileSync(await spaces.render(i.worker, file, flags), look.file);
          } else {
            need(i.name);
            look = await picture(i.name, undefined, flags, file);
          }
        } catch (e) {
          if (e instanceof CommandError) throw e;
          throw new CommandError('failed', e instanceof Error ? e.message : String(e));
        }
        const caption = `drawing ${i.name}${i.depth ? ', depth map' : ''}${i.anim ? `, ${i.anim}` : ''}${i.worker ? `, as ${i.worker} has it` : ''}`;
        // What the agent looks at is shown in the conversation; the person browsing their own drawings is not news.
        if (isAgent(c.by)) o.events.add({ type: 'look', by: c.by, url: look.url, caption, text: caption });
        return look;
      },
    },
    {
      name: 'art.set', kind: 'write', agent: 'proposes',
      about: 'Write a drawing: its whole text, and its depth map if that changes too. The person\'s is in the game at once; the agent\'s becomes a proposal with a picture before and after. For real drawing work, ask a worker (art.ask) instead: it draws in rounds and looks at what it makes.',
      input: { name: 'string', text: 'string', depth: 'string?', note: 'string?' },
      async run(c, i) {
        if (!validName(i.name)) throw new CommandError('input', 'a drawing is named in lower-case words with dashes');
        check(i.text, 'the text');
        if (i.depth !== undefined) check(i.depth, 'the depth map');
        o.locks.guard(`drawing:${i.name}`, c.by);
        const was = has(i.name) ? { text: readFileSync(artFile(i.name), 'utf8'), ...(existsSync(depthFile(i.name)) && { depth: readFileSync(depthFile(i.name), 'utf8') }) } : undefined;
        const after = { text: i.text, ...(i.depth !== undefined && { depth: i.depth }) };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          let pictures: Pictures;
          try { pictures = await pictureOf.of(i.name, was, after); } catch (e) { throw new CommandError('input', `that does not render: ${e instanceof Error ? e.message : e}`); }
          const p = o.proposals.add({ round, by: c.by, kind: 'drawing', path: i.name, before: was, after, note: i.note ?? '' });
          o.events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'drawing', path: i.name, phase: 'color', pictures, note: p.note, isNew: !was });
          return { proposed: p.id, round, picture: pictures.after };
        }
        write(i.name, after);
        const built = await build();
        o.events.add({ type: 'art.changed', by: c.by, names: [i.name] });
        return { changed: true, built };
      },
    },
    {
      name: 'art.ask', kind: 'write', agent: 'free',
      about: 'Hand drawing work to a worker: a change to a drawing there is, or a new one (new: true), with a brief in plain words. edit names more drawings it may change. It draws in its own copy, silhouette first, and what it makes comes back as a proposal with pictures; nothing reaches the game until the person accepts it. A locked drawing cannot be given to a worker.',
      input: { name: 'string', message: 'string', new: 'boolean?', edit: 'json?' },
      run(c, i) {
        if (!validName(i.name)) throw new CommandError('input', 'a drawing is named in lower-case words with dashes');
        const edit: string[] = Array.isArray(i.edit) ? i.edit.map(String) : [];
        if (i.new && has(i.name)) throw new CommandError('exists', `there already is a drawing called ${i.name}`);
        if (!i.new) need(i.name);
        for (const n of edit) need(n);
        for (const n of [i.name, ...edit])
          if (o.locks.has(`drawing:${n}`))
            throw new CommandError('locked', `drawing:${n} is locked: no worker and no agent can change it, even when asked. ${isAgent(c.by) ? 'Tell the person it is locked; only they can unlock it' : 'Unlock it first'}`);
        if (!i.message.trim()) throw new CommandError('input', 'say what it should draw');
        const w = workers.start({ name: i.name, message: i.message.trim(), isNew: !!i.new, by: c.by, edit });
        o.events.add({ type: 'art.asked', by: c.by, name: i.name, message: i.message.trim(), worker: w.id, isNew: !!i.new });
        return { worker: w.id, says: 'a worker is drawing; its work comes back as a proposal. See art.workers' };
      },
    },
    {
      name: 'art.workers', kind: 'read',
      about: 'The drawing workers that are open: what each draws, whether it is running or waiting (for approval of its silhouette, or to be accepted), and what it is doing.',
      run: () => workers.list().map(brief),
    },
    {
      name: 'art.tell', kind: 'write', agent: 'free',
      about: 'Give a waiting worker feedback: it does another round and proposes again.',
      input: { worker: 'string', message: 'string' },
      run(c, i) {
        const w = worker(i.worker);
        try { workers.tell(w.id, i.message); } catch (e) { throw new CommandError('busy', e instanceof Error ? e.message : String(e)); }
        o.events.add({ type: 'art.told', by: c.by, worker: w.id, name: w.names[0], message: i.message });
        return { says: 'it is drawing another round' };
      },
    },
    {
      name: 'art.approve', kind: 'write', agent: 'free',
      about: 'Approve the silhouette a worker is waiting with: it is kept as the depth map, and the worker goes on with colour.',
      input: { worker: 'string', message: 'string?' },
      run(c, i) {
        const w = worker(i.worker);
        try { workers.approve(w.id, i.message); } catch (e) { throw new CommandError('busy', e instanceof Error ? e.message : String(e)); }
        o.events.add({ type: 'art.told', by: c.by, worker: w.id, name: w.names[0], message: `silhouette approved${i.message ? `: ${i.message}` : ''}` });
        return { says: 'it goes on with colour' };
      },
    },
    {
      name: 'art.stop', kind: 'write', agent: 'free',
      about: 'Stop a worker in the middle of a round. What it has drawn so far is proposed.',
      input: { worker: 'string' },
      run: (_c, i) => ({ stopped: workers.stop(worker(i.worker).id) }),
    },
    {
      name: 'art.close', kind: 'write', agent: 'free',
      about: 'Be done with a worker without taking its drawing: it stops, what it proposed is rejected, and its copy is thrown away.',
      input: { worker: 'string' },
      run(c, i) {
        const w = worker(i.worker);
        const dropped = o.proposals.decide(w.id, 'rejected');
        workers.close(w.id);
        if (dropped.length) o.events.add({ type: 'proposal.decided', by: c.by, round: w.id, status: 'rejected', count: dropped.length, paths: dropped.map((p) => `${p.kind}:${p.path}`) });
        o.events.cast({ type: 'art.status', worker: w.id, name: w.names[0], state: 'closed', phase: w.phase, doing: '' });
        return { closed: true };
      },
    },
    {
      name: 'art.note', kind: 'write', agent: 'free',
      about: 'A worker reporting on its own work: a round, a critique of its render, the phase it finished. Sent by its tools, not by hand.',
      input: { worker: 'string', type: 'string', name: 'string?', message: 'string?' },
      run(_c, i) { workers.note(i.worker, i.type, i.name ?? '', i.message ?? ''); return { ok: true }; },
    },
    {
      name: 'art.build', kind: 'write',
      about: 'Build the drawings into the game again, as they are now. Done by itself whenever a drawing changes.',
      run: async (c) => { const built = await build(); o.events.add({ type: 'art.changed', by: c.by, names: [] }); return { built }; },
    },
  ];

  return {
    commands, workers,
    /** A round of proposals is being decided: what it means for drawings, and for the worker whose round it is. */
    async decide(round: string, accept: boolean, set: Proposal[]) {
      const drawings = set.filter((p) => p.kind === 'drawing');
      if (accept && drawings.length) {
        for (const p of drawings) write(p.path, p.after as { text?: string; depth?: string });
        await build();
        o.events.add({ type: 'art.changed', by: 'me', names: drawings.map((p) => p.path) });
      }
      if (workers.get(round)) workers.close(round);
    },
    /** May this round be accepted as it is? A silhouette is not a drawing yet. */
    acceptable(round: string) {
      const w = workers.get(round);
      if (w && workers.busy(round)) throw new CommandError('busy', `${round} is still drawing; wait for its round, or stop it`);
      if (w?.phase === 'silhouette') throw new CommandError('input', `${round} has only a silhouette of ${w.names[0]}: approve it (art.approve) so it goes on with colour, or reject it`);
    },
  };
}

export type Art = ReturnType<typeof createArt>;
