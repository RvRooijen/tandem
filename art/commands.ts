// Art as commands: the game's drawings listed, read and looked at; a drawing
// changed (by the person at once, by the agent as a proposal); and drawing
// work handed to a worker, which proposes what it drew. That work is the
// agent's to judge from start to finish: it is told when a worker's round
// ends, approves the silhouette, gives feedback, and takes the drawing into
// the project (art.accept). A drawing is a thing like a concept: it can be
// proposed on, accepted, and locked; a locked one no worker and no agent gets.
// A drawing can also be a 3D model (art/model: a short program that says
// // @model): it is kept, asked for, judged and accepted the same way, and only
// looks different.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, isAgent, type CommandDef } from '../core/commands.ts';
import type { EventLog } from '../core/events.ts';
import type { Locks } from '../core/locks.ts';
import type { Project } from '../core/project.ts';
import type { Proposal, Proposals } from '../core/proposals.ts';
import { isModel } from './model/format.ts';
import { toGlb } from './model/glb.ts';
import { readModel, readModelLater } from './model/run.ts';
import { optionsOf } from './model/render.ts';
import { byHeat } from './model/clips.ts';
import { buildModel } from './model/shapes.ts';
import { createPictures, type Pictures } from './pictures.ts';
import { describeDrawing, type Described } from './sprites.ts';
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
  accepted?(drawings: (Described & { isNew: boolean; depth: boolean })[]): void;
  /** A worker's drawings were taken into the project by art.accept: whatever follows every accept (committing, pushing). */
  taken?(by: string): Promise<void>;
}

export function createArt(o: ArtOptions) {
  const root = o.project.root;
  const spaces = createWorkspaces(root, join(o.project.dirs.data, 'art-work'));
  const pictureOf = createPictures(spaces, o.newLookFile);
  const workers = createWorkers({
    spaces, events: o.events, proposals: o.proposals, pictures: pictureOf,
    // What a worker looks at, who watches it sees too: a copy, since its next render writes over it.
    looked(w, png) {
      const look = o.newLookFile();
      copyFileSync(png, look.file);
      o.events.cast({ type: 'art.looked', worker: w.id, name: w.names[0], url: look.url });
    },
    // A round ended: the agent is set to work on it. Nobody else decides about drawing work.
    async ended(w) {
      const name = w.names[0], model = w.kind === 'model';
      // Of a model, where its shapes cross is measured, not left to be seen: the agent gets the list.
      let crossings = '';
      if (model && w.state !== 'failed') {
        try {
          const { said } = await spaces.rendered(w.id, `art/${name}.txt`, ['--clips', '--views=three-quarter,front,side,back,three-quarter-back,below', '--size=160']);
          const lines = said.split('\n').filter((l) => !/^out\/|triangles; it stands/.test(l));
          crossings = ` Measured where its shapes cross: ${lines.slice(0, 16).join(' ').replace(/\s+/g, ' ')}${lines.length > 16 ? ' (more with art.look clips: true)' : ''}`;
        } catch { /* it does not build: the round says so */ }
      }
      const how = w.state === 'failed' ? `failed: ${w.doing}`
        : w.state === 'stopped' ? 'was stopped in the middle of a round; what it had drawn so far is what it proposes'
          : w.phase === 'silhouette' ? (model
            ? 'has the form of the model ready, in one tone, and waits for it to be approved. A form is approved when its parts are right from every side: proportions, where each part sits and how big it is beside the others, and joints and ends shaped, not only blocked out; and made of meshes that are the shapes, not of primitives stuck together (look with wire: a hump, hair, a belly or hands made of balls, or a part stuck through another instead of growing out of it, or one surface made of two shapes with a seam or a flat cap where they meet, is a blockout). Always look for clipping: the measured list of what pokes out through another shape is below, and art.look with heat: true shows it glowing, from every side and close up with zoom where parts meet; every piece that pokes through is a fix: name each one in art.tell. Something that only looks like the thing at a glance is a blockout: send it back with art.tell, naming what to refine and which primitives the mesh pass is to replace'
            : 'has a silhouette ready, and waits for it to be approved')
            : `has the ${model ? 'model' : 'drawing'} ready in colour, and waits for it to be taken into the project${model ? '. Its details are right when what belongs to a surface is made in it (a visor slit as the gap between two shells, a ridge or a brow in the outline of the rings, an edge as a step in them), and only what is a thing of its own (a buckle, a rivet, a strap) is a shape of its own: a thin plate or box stuck on a surface where the surface should have it is sent back for the detail pass (look close up with wire and zoom)' : ''}`;
      const next = w.state === 'failed' ? 'art.tell sets it going again with what you tell it; art.close ends it.'
        : `${w.state === 'waiting' && w.phase === 'silhouette' ? `art.approve when the ${model ? 'form is right from every side' : 'shape is right'} (it goes on with colour)` : 'art.accept when it is what was asked for (it goes into the project)'}, art.tell with what should be different for another round, or art.close to be done with it without taking anything.`;
      o.events.add({
        type: 'message', by: 'engine', kind: 'art', worker: w.id, name, state: w.state, phase: w.phase,
        text: `The drawing worker ${w.id}, on ${name}, ${how}.${w.described && (w.rounds ?? 1) <= 1 ? ` What it made it as: "${w.described.slice(0, 800)}"` : ''}${w.said && w.state !== 'failed' ? ` It says: "${w.said.slice(0, 600)}"` : ''} That was round ${w.rounds ?? 1} of its work.${crossings} `
          + `Judging it is yours, from start to finish: the person is not asked and has no buttons for it. ${w.state === 'failed' ? '' : `Look at what it drew (art.look with worker "${w.id}"${model ? ': the model from four sides; views, zoom, wire and anim show more, clips: true measures where shapes cross: what pokes out through another shape is clipping and a fix, always; every other crossing that shows is a fix or meant, and one that is not accounted for in what the worker says is sent back with art.tell; heat: true shows what pokes through glowing' : ''}) and hold it against what was asked for. Then: `}${next} `
          + 'Do not keep it going round: after about three rounds of feedback in a phase, take the best there is or close it. Say in a sentence what you did with it.',
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
    try { if (isModel(text)) readModel(text); else parseArt(text); } catch (e) { throw new CommandError('input', `${what} is not a drawing the format can read: ${e instanceof Error ? e.message : e}`); }
  }

  /** The project's own build of its drawings (tandem.json: art.build), run in the project. */
  function build(): Promise<string> {
    const command = o.project.config.art?.build;
    if (!command) return Promise.resolve('the project has no build for its drawings (tandem.json: art.build); nothing was built');
    return new Promise((ok, fail) => {
      // (`tandem export`, tandem's own build of drawings, is found like any command of the project's.)
      const env = { ...process.env, PATH: `${fileURLToPath(new URL('../bin', import.meta.url))}${delimiter}${process.env.PATH ?? ''}` };
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
      const look = o.newLookFile(), { png, said } = await spaces.rendered(space, file, flags);
      copyFileSync(png, look.file);
      return { ...look, said };
    } finally { spaces.remove(space); }
  }

  const worker = (id: string) => {
    const w = /^[\w-]+$/.test(id) ? workers.get(id) : undefined;
    if (!w) throw new CommandError('missing', `there is no worker ${id}; see art.workers`);
    return w;
  };
  const brief = (w: NonNullable<ReturnType<typeof workers.get>>) => ({ worker: w.id, drawing: w.names[0], ...(w.described && { described: w.described }), state: w.state, phase: w.phase, doing: w.doing, minutes: Math.round((Date.now() - w.started) / 60_000) });

  /** May this round be taken as it is? A silhouette is not a drawing yet. */
  function acceptable(round: string) {
    const w = workers.get(round);
    if (w && workers.busy(round)) throw new CommandError('busy', `${round} is still drawing; wait for its round, or stop it`);
    if (w?.phase === 'silhouette') throw new CommandError('input', `${round} has only a silhouette of ${w.names[0]}: approve it (art.approve) so it goes on with colour, or reject it`);
  }

  const commands: CommandDef[] = [
    {
      name: 'art.list', kind: 'read',
      about: 'The project\'s drawings: the size of each, its looks (colour variants), its animations with how many frames, whether it has a depth map and whether it is locked. One that is a 3D model says so (model): the box it stands in is w wide, h high and d deep in its own units, with how many shapes and triangles, its bones, and its animations with how many seconds each takes. One whose text cannot be read is listed with what is wrong with it (error).',
      run: () => names().map((n) => {
        const text = readFileSync(artFile(n), 'utf8');
        let what: Described & { error?: string };
        try { what = describeDrawing(n, text); } catch (e) { what = { name: n, w: 0, h: 0, looks: [], anims: {}, error: e instanceof Error ? e.message : String(e) }; if (isModel(text)) Object.assign(what, { model: true, d: 0, shapes: 0, triangles: 0, bones: [] }); }
        return { ...what, depth: existsSync(depthFile(n)), locked: o.locks.has(`drawing:${n}`) };
      }),
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
      about: 'A picture of a drawing: every animation as a row of frames, enlarged, with a small preview. anim and frame (from 1) narrow it down, look picks a colour variant, depth shows its depth map, worker shows a worker\'s version instead of the project\'s. A 3D model is shown from four sides (3/4 front, front, side, back); views picks others ("front,side,top"; also back, three-quarter-back, below), turn adds one from any angle ("60,15": turned 60 degrees, tipped 15), wire draws the outlines of its faces (how its lines run), form shows it in one tone, and anim shows it in one of its animations, a row per moment of the loop (at: "0,0.5"; four when not said), with its bones; zoom looks close up ("0,1.2,0.1,0.15": round that place, so far round it), to see where parts meet; clips measures where shapes cross, draws it in white where it shows from outside, and gives the list (clips in what comes back): first the little pieces of a shape that poke out through another it is in (clipping, always a fix), then every crossing that shows, which two shapes, how long, where, seen from which sides; heat shows the model in grey with what pokes through glowing, a heatmap. The file can be read as an image.',
      input: { name: 'string', anim: 'string?', frame: 'number?', look: 'string?', depth: 'boolean?', worker: 'string?', views: 'string?', turn: 'string?', wire: 'boolean?', form: 'boolean?', at: 'string?', zoom: 'string?', clips: 'boolean?', heat: 'boolean?' },
      async run(c, i) {
        if (!validName(i.name)) throw new CommandError('input', 'a drawing is named in lower-case words with dashes');
        let flags = [i.anim && `--anim=${i.anim}`, i.frame && `--frame=${i.frame}`, i.look && i.look !== 'default' && `--recolor=${i.look}`].filter(Boolean) as string[];
        const file = `${i.depth ? 'depth' : 'art'}/${i.name}.txt`;
        const at = join(i.worker ? spaces.dir(worker(i.worker).id) : root, 'art', `${i.name}.txt`);
        if (existsSync(at) && isModel(readFileSync(at, 'utf8'))) {
          if (i.depth) throw new CommandError('input', `${i.name} is a 3D model: it has no depth map`);
          flags = [i.views && `--views=${i.views}`, i.turn && `--turn=${i.turn}`, i.wire && '--wire', i.form && '--form', i.anim && `--anim=${i.anim}`, i.anim && i.at && `--at=${i.at}`, i.zoom && `--zoom=${i.zoom}`, i.clips && '--clips', i.heat && '--heat'].filter(Boolean) as string[];
          try { optionsOf(flags); } catch (e) { throw new CommandError('input', e instanceof Error ? e.message : String(e)); }
        }
        let look: { file: string; url: string; said?: string };
        try {
          if (i.worker) {
            const { png, said } = await spaces.rendered(i.worker, file, flags);
            look = { ...o.newLookFile(), said };
            copyFileSync(png, look.file);
          } else {
            need(i.name);
            look = await picture(i.name, flags, file);
          }
        } catch (e) {
          if (e instanceof CommandError) throw e;
          throw new CommandError('failed', e instanceof Error ? e.message : String(e));
        }
        const caption = `drawing ${i.name}${i.depth ? ', depth map' : ''}${i.anim ? `, ${i.anim}` : ''}${i.views ? `, ${i.views.replaceAll(',', ', ')}` : ''}${i.worker ? `, as ${i.worker} has it` : ''}`;
        // What the agent looks at is shown in the conversation; the person browsing their own drawings is not news.
        if (isAgent(c.by)) o.events.add({ type: 'look', by: c.by, url: look.url, caption, text: caption });
        // (Where the shapes of a model cross, as the render measured it.)
        const clips = i.clips && look.said ? look.said.split('\n').filter((l) => !/^out\/|triangles; it stands/.test(l)).map((l) => l.trim()) : undefined;
        return { file: look.file, url: look.url, ...(clips && { clips }) };
      },
    },
    {
      name: 'art.set', kind: 'write', agent: 'proposes',
      about: 'Write a drawing: its whole text, and its depth map if that changes too. The person\'s is in the project at once; the agent\'s becomes a proposal with a picture before and after. For real drawing work, ask a worker (art.ask) instead: it draws in rounds and looks at what it makes.',
      input: { name: 'string', text: 'string', depth: 'string?', note: 'string?' },
      async run(c, i) {
        if (!validName(i.name)) throw new CommandError('input', 'a drawing is named in lower-case words with dashes');
        check(i.text, 'the text');
        if (i.depth !== undefined && isModel(i.text)) throw new CommandError('input', 'a 3D model has no depth map');
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
      about: 'Hand drawing work to a worker: a change to a drawing there is, or a new one (new: true), with a brief in plain words. edit names more drawings it may change. A new one is pixel art, or with model: true a 3D model (one thing, built from simple shapes with its colours; the project gets it as <name>.glb): ask for a model when the project is in 3D or the thing is to be seen from every side, and say in the brief which way it faces and how large it is in the project\'s units. Say too whether it is going to move, and how (an idle, a walk, a bite): its parts that move get joints (bones), and the animations go into the .glb. An animation for a model there is, is asked the same way, as a change to it. It draws in its own copy, silhouette first; when a round of it ends the agent is told, and judges it: art.approve, art.tell, art.accept or art.close. Nothing reaches the project until it is accepted. A locked drawing cannot be given to a worker.',
      input: { name: 'string', message: 'string', new: 'boolean?', model: 'boolean?', edit: 'json?' },
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
        if (i.model && !i.new) throw new CommandError('input', 'model says what a new one is to be (with new: true); one that is there is what it is');
        const model = i.new ? !!i.model : isModel(readFileSync(artFile(i.name), 'utf8'));
        const w = workers.start({ name: i.name, message: i.message.trim(), isNew: !!i.new, by: c.by, edit, model });
        o.events.add({ type: 'art.asked', by: c.by, name: i.name, message: i.message.trim(), worker: w.id, isNew: !!i.new });
        return { worker: w.id, says: 'a worker is drawing; its work comes back as a proposal. See art.workers' };
      },
    },
    {
      name: 'art.workers', kind: 'read',
      about: 'The drawing workers that are open: what each draws (and of a model, what it described it as), whether it is running or waiting (for its silhouette to be approved, or its drawing to be accepted), and what it is doing.',
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
      about: 'Approve the silhouette a worker is waiting with: it is kept as the depth map, and the worker goes on with colour. Of a 3D model it is the form that is approved.',
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
        await o.taken?.(c.by);
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
        if (dropped.length) o.events.add({ type: 'proposal.decided', by: c.by, round: w.id, status: 'rejected', count: dropped.length, ids: dropped.map((p) => p.id), left: 0, paths: dropped.map((p) => `${p.kind}:${p.path}`) });
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
      name: 'art.mesh', kind: 'read',
      about: 'A 3D model as the Art tab shows it: built into a .glb (base64), with the silhouettes its tubes were made from, its bones and its animations. Of the project\'s, of a worker\'s copy (worker), or of a text (text); with draft, a text as it is being typed gives what is whole of it so far (draft: true in what comes back); with heat, grey with what pokes out through another shape glowing.',
      input: { name: 'string?', worker: 'string?', text: 'string?', draft: 'boolean?', heat: 'boolean?' },
      async run(_c, i) {
        let text = i.text;
        if (text === undefined) {
          if (!i.name || !validName(i.name)) throw new CommandError('input', 'say which model (name), or give its text');
          const at = join(i.worker ? spaces.dir(worker(i.worker).id) : root, 'art', `${i.name}.txt`);
          if (!i.worker) need(i.name);
          if (!existsSync(at)) throw new CommandError('missing', `${i.worker} has no ${i.name} yet`);
          text = readFileSync(at, 'utf8');
        }
        if (!isModel(text)) throw new CommandError('input', 'that is not a 3D model (its first line is not // @model)');
        let read;
        try { read = await readModelLater(text, !!i.draft && i.text !== undefined); } catch (e) { throw new CommandError('input', e instanceof Error ? e.message : String(e)); }
        const built = buildModel(read.model);
        return {
          // (As a heatmap: grey, with what pokes out through another shape glowing.)
          glb: Buffer.from(toGlb(i.heat ? byHeat(built) : built, i.name ?? 'model')).toString('base64'),
          profiles: read.profiles, bones: built.bones.map((b) => b.name),
          anims: Object.fromEntries(Object.entries(read.model.anims).map(([a, v]) => [a, v.seconds])), triangles: built.triangles,
          ...(read.draft && { draft: true }),
        };
      },
    },
    {
      name: 'art.build', kind: 'write',
      about: 'Run the project\'s own build of its drawings (tandem.json: art.build), as they are now.',
      run: async (c) => { const built = await build(); o.events.add({ type: 'art.changed', by: c.by, names: [] }); return { built }; },
    },
  ];

  return {
    commands, workers,
    /** What the person decides is being accepted: its drawings go into the project's art files. */
    accepting: (pending: Proposal[]) => take(pending.filter((p) => p.kind === 'drawing').map((p) => ({ name: p.path, value: p.after as { text?: string; depth?: string } })), 'me'),
  };
}

export type Art = ReturnType<typeof createArt>;
