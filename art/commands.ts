// Art as commands: the game's drawings listed, read and looked at; a drawing
// changed (by the person at once, by the agent as a proposal); and drawing
// work handed to a worker, which proposes what it drew. That work is the
// agent's to judge from start to finish: it is told when a worker's round
// ends, approves the silhouette, gives feedback, and takes the drawing into
// the project (art.accept). A drawing is a thing like a concept: it can be
// proposed on, accepted, and locked; a locked one no worker and no agent gets.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, isAgent, type CommandDef } from '../core/commands.ts';
import type { EventLog } from '../core/events.ts';
import type { Locks } from '../core/locks.ts';
import type { Project } from '../core/project.ts';
import type { Proposal, Proposals } from '../core/proposals.ts';
import { createPictures, type Pictures } from './pictures.ts';
import { describeDrawing } from './sprites.ts';
import { parseArt } from './src/parse.js';
import { createWorkers } from './workers.ts';
import { createWorkspaces, filesIn, validName } from './workspace.ts';

export interface ArtOptions {
  /** The project the drawings belong to: they are in its art/ folder, with depth maps in depth/. */
  project: Project;
  events: EventLog;
  proposals: Proposals;
  locks: Locks;
  newLookFile(): { file: string; url: string };
  /** Drawings were taken into the project: somebody has to bring them into what the project runs on. Unset: they are built straight in. */
  accepted?(drawings: { name: string; w: number; h: number; looks: string[]; anims: Record<string, number>; isNew: boolean; depth: boolean }[]): void;
}

export function createArt(o: ArtOptions) {
  const root = o.project.root;
  const spaces = createWorkspaces(root, join(o.project.dirs.data, 'art-work'));
  const pictureOf = createPictures(spaces, o.newLookFile);
  const workers = createWorkers({
    spaces, events: o.events, proposals: o.proposals, pictures: pictureOf,
    // A round ended: the agent is set to work on it. Nobody else decides about drawing work.
    ended(w) {
      const name = w.names[0];
      const how = w.state === 'failed' ? `failed: ${w.doing}`
        : w.state === 'stopped' ? 'was stopped in the middle of a round; what it had drawn so far is what it proposes'
          : w.phase === 'silhouette' ? 'has a silhouette ready, and waits for it to be approved'
            : 'has the drawing ready in colour, and waits for it to be taken into the project';
      const next = w.state === 'failed' ? 'art.tell sets it going again with what you tell it; art.close ends it.'
        : `${w.state === 'waiting' && w.phase === 'silhouette' ? 'art.approve when the shape is right (it goes on with colour)' : 'art.accept when it is what was asked for (it goes into the project)'}, art.tell with what should be different for another round, or art.close to be done with it without taking anything.`;
      o.events.add({
        type: 'message', by: 'engine', kind: 'art', worker: w.id, name, state: w.state, phase: w.phase,
        text: `The drawing worker ${w.id}, on ${name}, ${how}.${w.said && w.state !== 'failed' ? ` It says: "${w.said.slice(0, 600)}"` : ''} That was round ${w.rounds ?? 1} of its work. `
          + `Judging it is yours, from start to finish: the person is not asked and has no buttons for it. ${w.state === 'failed' ? '' : `Look at what it drew (art.look with worker "${w.id}") and hold it against what was asked for. Then: `}${next} `
          + 'Do not keep it going round: after about three rounds of feedback, take the best there is or close it. Say in a sentence what you did with it.',
      });
    },
  });
  const artFile = (name: string) => join(root, 'art', `${name}.txt`);
  const depthFile = (name: string) => join(root, 'depth', `${name}.txt`);
  const has = (name: string) => validName(name) && existsSync(artFile(name));

  function need(name: string) {
    if (!has(name)) throw new CommandError('missing', `there is no drawing called ${name}; there are: ${names().join(', ') || 'none'}`);
  }
  const names = () => Object.keys(filesIn(root)).filter((p) => p.startsWith('art/')).map((p) => p.slice(4, -4));

  /** A drawing's text has to be something the format can read. */
  function check(text: string, what: string) {
    try { parseArt(text); } catch (e) { throw new CommandError('input', `${what} is not a drawing the format can read: ${e instanceof Error ? e.message : e}`); }
  }

  /** The project's own build of its drawings (tandem.json: art.build), run in the project. */
  function build(): Promise<string> {
    const command = o.project.config.art?.build;
    if (!command) return Promise.resolve('the project has no build for its drawings (tandem.json: art.build); nothing was built');
    return new Promise((ok, fail) => {
      // (`tandem export`, tandem's own build of drawings, is found like any command of the project's.)
      const env = { ...process.env, PATH: `${fileURLToPath(new URL('../bin', import.meta.url))}:${process.env.PATH ?? ''}` };
      execFile('sh', ['-c', command], { cwd: root, timeout: 120_000, env }, (err, stdout, stderr) => {
        if (err) fail(new CommandError('failed', `the drawings could not be built into the project: ${(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`));
        else ok(stdout.trim().split('\n').pop() ?? '');
      });
    });
  }

  /** Put a drawing in the project: its text, and its depth map when it comes with one. */
  function write(name: string, value: { text?: string; depth?: string }) {
    mkdirSync(join(root, 'art'), { recursive: true });
    if (value.text !== undefined) writeFileSync(artFile(name), value.text);
    if (value.depth !== undefined) { mkdirSync(join(root, 'depth'), { recursive: true }); writeFileSync(depthFile(name), value.depth); }
  }

  /**
   * Take drawings into the project: their text, in the game's art files. That is all. A drawing that changed or is
   * new is not in the game yet: building it in, and making the game use what is new about it, is the agent's work
   * in its working copy (see core/code.ts), and it is told (o.accepted). Without an agent that codes, the drawings
   * are built straight in, which is all an unchanged game can do with them.
   */
  async function take(list: { name: string; value: { text?: string; depth?: string } }[], by: string) {
    if (!list.length) return;
    const isNew = list.map((d) => !has(d.name));
    for (const d of list) write(d.name, d.value);
    if (!o.accepted) await build();
    o.events.add({ type: 'art.changed', by, names: list.map((d) => d.name), built: !o.accepted });
    o.accepted?.(list.map((d, i) => ({ ...describeDrawing(d.name, readFileSync(artFile(d.name), 'utf8')), isNew: isNew[i], depth: existsSync(depthFile(d.name)) })));
  }

  /** A picture of one of the game's drawings, rendered in a workspace of its own. */
  async function picture(name: string, flags: string[] = [], file = `art/${name}.txt`) {
    const space = spaces.scratch();
    try {
      const look = o.newLookFile();
      copyFileSync(await spaces.render(space, file, flags), look.file);
      return look;
    } finally { spaces.remove(space); }
  }

  const worker = (id: string) => {
    const w = /^[\w-]+$/.test(id) ? workers.get(id) : undefined;
    if (!w) throw new CommandError('missing', `there is no worker ${id}; see art.workers`);
    return w;
  };
  const brief = (w: NonNullable<ReturnType<typeof workers.get>>) => ({ worker: w.id, drawing: w.names[0], state: w.state, phase: w.phase, doing: w.doing, minutes: Math.round((Date.now() - w.started) / 60_000) });

  /** May this round be taken as it is? A silhouette is not a drawing yet. */
  function acceptable(round: string) {
    const w = workers.get(round);
    if (w && workers.busy(round)) throw new CommandError('busy', `${round} is still drawing; wait for its round, or stop it`);
    if (w?.phase === 'silhouette') throw new CommandError('input', `${round} has only a silhouette of ${w.names[0]}: approve it (art.approve) so it goes on with colour, or reject it`);
  }

  const commands: CommandDef[] = [
    {
      name: 'art.list', kind: 'read',
      about: 'The project\'s drawings: the size of each, its looks (colour variants), its animations with how many frames, whether it has a depth map and whether it is locked.',
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
      about: 'A picture of a drawing: every animation as a row of frames, enlarged, with a small preview. anim and frame (from 1) narrow it down, look picks a colour variant, depth shows its depth map, worker shows a worker\'s version instead of the project\'s. The file can be read as an image.',
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
            look = await picture(i.name, flags, file);
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
      about: 'Write a drawing: its whole text, and its depth map if that changes too. The person\'s is in the project at once; the agent\'s becomes a proposal with a picture before and after. For real drawing work, ask a worker (art.ask) instead: it draws in rounds and looks at what it makes.',
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
        await take([{ name: i.name, value: after }], c.by);
        return { changed: true };
      },
    },
    {
      name: 'art.ask', kind: 'write', agent: 'free',
      about: 'Hand drawing work to a worker: a change to a drawing there is, or a new one (new: true), with a brief in plain words. edit names more drawings it may change. It draws in its own copy, silhouette first; when a round of it ends the agent is told, and judges it: art.approve, art.tell, art.accept or art.close. Nothing reaches the project until it is accepted. A locked drawing cannot be given to a worker.',
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
      about: 'The drawing workers that are open: what each draws, whether it is running or waiting (for its silhouette to be approved, or its drawing to be accepted), and what it is doing.',
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
      name: 'art.accept', kind: 'write', agent: 'free',
      about: 'Take what a waiting worker drew into the project: its drawings go into the project\'s art files, and the worker is done. Only a drawing in colour; a silhouette is approved first (art.approve). Drawing work is the agent\'s to judge from start to finish, so this is the one thing it takes into the project itself; a drawing that is locked it cannot take.',
      input: { worker: 'string' },
      async run(c, i) {
        const w = worker(i.worker);
        acceptable(w.id);
        const pending = o.proposals.list({ status: 'pending', round: w.id }).filter((p) => p.kind === 'drawing');
        if (!pending.length) throw new CommandError('missing', `${w.id} has proposed nothing to take; give it feedback (art.tell) or close it (art.close)`);
        for (const p of pending) o.locks.guard(`drawing:${p.path}`, c.by);
        await take(pending.map((p) => ({ name: p.path, value: p.after as { text?: string; depth?: string } })), c.by);
        const set = o.proposals.decide(w.id, 'accepted');
        workers.close(w.id);
        o.events.add({ type: 'proposal.decided', by: c.by, round: w.id, status: 'accepted', count: set.length, ids: set.map((p) => p.id), left: 0, paths: set.map((p) => `${p.kind}:${p.path}`) });
        return {
          accepted: pending.map((p) => p.path),
          says: o.accepted ? 'in the project\'s art files now. Tandem tells you in a moment, when they are in your working copy too: bring them into the project then, not in this turn' : 'in the project now, and built into it',
        };
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
      about: 'Run the project\'s own build of its drawings (tandem.json: art.build), as they are now.',
      run: async (c) => { const built = await build(); o.events.add({ type: 'art.changed', by: c.by, names: [] }); return { built }; },
    },
  ];

  return {
    commands, workers,
    /**
     * A round is being accepted: its drawings go into the project's art files.
     */
    accepting: (pending: Proposal[]) => take(pending.filter((p) => p.kind === 'drawing').map((p) => ({ name: p.path, value: p.after as { text?: string; depth?: string } })), 'me'),
    /** A round was decided: the worker whose round it was is done. */
    decided(round: string) {
      if (workers.get(round)) workers.close(round);
    },
    acceptable,
  };
}

export type Art = ReturnType<typeof createArt>;
