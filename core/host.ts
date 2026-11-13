// The host: one game, its stores, its worlds and every command, in one place.
// The server puts HTTP around it; the tests use it as it is. Nothing here knows
// about pages or agents beyond who is asking (`by`).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, createRegistry, isAgent, type By, type CommandDef, type Registry } from './commands.ts';
import { STAGES, createConcepts, type Concept, type Concepts } from './concepts.ts';
import { createEventLog, type EventLog } from './events.ts';
import type { GameModule, World } from './game.ts';
import { runJob } from './jobs.ts';
import { createLocks, type Locks } from './locks.ts';
import { encodePng } from './png.ts';
import { createProposals, type Proposal, type Proposals } from './proposals.ts';
import { createRecords, type RecordSet, type RecordValue, type Records } from './records.ts';
import { createArt, type Art } from '../art/commands.ts';
import { ecsCommands } from '../ecs/inspect.ts';
import { compare, type Pacing } from '../playtest/pacing.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A world on the host. `mine` mirrors the one the person is playing; the others are sandboxes anyone may play in. */
interface Room { world?: World; snapshot?: unknown; at: number }

export interface Host {
  game: GameModule;
  registry: Registry;
  events: EventLog;
  records: Records;
  proposals: Proposals;
  concepts: Concepts;
  locks: Locks;
  art: Art;
  dirs: { game: string; data: string; looks: string };
  /** Run a command as somebody. */
  run(name: string, input: Record<string, unknown> | undefined, by: By, round?: string): Promise<unknown>;
  world(room?: string): World;
}

export interface HostOptions {
  game?: string;
  /** Where the game's content and concepts are; games/<id> by default. */
  gameDir?: string;
  /** Where what is not kept in git goes: the event log, proposals, pictures. */
  dataDir?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function createHost(opts: HostOptions = {}): Promise<Host> {
  const id = opts.game ?? process.env.TANDEM_GAME ?? 'gnome-garden';
  const gameDir = opts.gameDir ?? join(ROOT, 'games', id);
  const dataDir = opts.dataDir ?? join(gameDir, 'data');
  const looksDir = join(dataDir, 'looks');
  mkdirSync(looksDir, { recursive: true });

  const { game } = (await import(join(ROOT, 'games', id, 'module.ts'))) as { game: GameModule };
  const registry = createRegistry();
  const events = createEventLog(join(dataDir, 'events.jsonl'));
  const records = createRecords(join(gameDir, 'content'));
  const proposals = createProposals(join(dataDir, 'proposals'));
  const concepts = createConcepts(join(gameDir, 'concepts'));
  const locks = createLocks(join(gameDir, 'locks.json'));

  // The content in the code is where records start: whatever is not on disk yet is written out once.
  const builtIn = game.exportRecords() as RecordSet;
  for (const path in builtIn) if (!records.get(path)) records.set(path, builtIn[path]);
  game.applyRecords(records.all());

  // ------------------------------------------------------------ worlds

  const rooms = new Map<string, Room>();
  const mineFile = join(dataDir, 'mine.json');
  if (existsSync(mineFile)) {
    try { rooms.set('mine', { snapshot: JSON.parse(readFileSync(mineFile, 'utf8')), at: Date.now() }); } catch { /* a broken mirror is no mirror */ }
  }

  function build(snapshot: unknown): World {
    const w = game.createWorld(snapshot, { seed: 1 });
    w.step(0.05);                         // so that what is derived from the clock (day or night) is there
    return w;
  }

  function world(room = 'mine'): World {
    let r = rooms.get(room);
    if (!r) {
      if (room !== 'mine') throw new CommandError('missing', `there is no room called ${room}; there are: ${[...rooms.keys()].join(', ') || 'none'}. Make one with world.fork`);
      r = { at: Date.now() };
      rooms.set('mine', r);
    }
    r.world ??= build(r.snapshot);
    return r.world;
  }

  /** The world being played is the person's own; on the host it is a mirror. Writing goes to a sandbox. */
  function sandboxOnly(room: string | undefined, _by: By) {
    if (!room || room === 'mine')
      throw new CommandError('permission', 'the world being played is only mirrored here and cannot be changed from outside. Make a sandbox with world.fork and name it as room');
  }

  /** Everything built from the content has to be built again when the content changes. */
  function contentChanged() {
    game.applyRecords(records.all());
    const mine = rooms.get('mine');
    if (mine) mine.world = undefined;
  }

  // ------------------------------------------------------------ helpers

  let lookN = readdirSync(looksDir).length;
  function saveLook(pic: { w: number; h: number; px: Uint32Array }) {
    const name = `look-${Date.now().toString(36)}-${++lookN}.png`;
    writeFileSync(join(looksDir, name), encodePng(pic.px, pic.w, pic.h));
    return { file: join(looksDir, name), url: `/api/file/looks/${name}` };
  }
  const newLookFile = () => {
    const name = `look-${Date.now().toString(36)}-${++lookN}.png`;
    return { file: join(looksDir, name), url: `/api/file/looks/${name}` };
  };

  /** The concepts that say a record is theirs: its path, or everything of its kind ("flowers/*"). */
  function touching(path: string) {
    const kind = path.split('/')[0];
    return concepts.list()
      .filter((c) => c.realised.some((r) => r === path || r === `${kind}/*` || r === `record:${path}`))
      .map((c) => ({ id: c.id, name: c.name, stage: c.stage }));
  }

  /** The records as a set of pending proposals would leave them. */
  function proposed(round?: string): { set: RecordSet; changes: Proposal[] } {
    const changes = proposals.list({ status: 'pending', round }).filter((p) => p.kind === 'record');
    return { set: records.overlay(changes.map((p) => ({ path: p.path, after: p.after }))), changes };
  }

  function conceptBrief(c: Concept) {
    return { id: c.id, name: c.name, stage: c.stage, locked: locks.has(`concept:${c.id}`), summary: c.text.split('\n').find((l) => l.trim())?.slice(0, 140) ?? '', links: c.links, realised: c.realised };
  }

  const checkList = (v: unknown, what: string) => {
    if (v !== undefined && !Array.isArray(v)) throw new CommandError('input', `${what} is a list`);
  };

  // ------------------------------------------------------------ the commands

  const core: CommandDef[] = [
    {
      name: 'commands.list', kind: 'read',
      about: 'Every command there is: its name, what it is for, what it takes, and whether the agent may use it.',
      run: () => registry.list(),
    },

    // ---- talking
    {
      name: 'chat.send', kind: 'write', agent: 'free',
      about: 'Say something in the conversation. refs is a list of things it is about: "concept:<id>", "record:<path>", "entity:<id>", "drawing:<name>", "point:<x>,<y>".',
      input: { text: 'string', refs: 'json?' },
      run(c, i) {
        checkList(i.refs, 'refs');
        return events.add({ type: 'message', by: c.by, text: i.text, ...(i.refs?.length && { refs: i.refs }), ...(c.round && { round: c.round }) });
      },
    },
    {
      name: 'chat.history', kind: 'read',
      about: 'The last messages of this conversation (limit defaults to 20). A conversation starts at the last chat.new.',
      input: { limit: 'number?' },
      run(_c, i) {
        const all = events.since(0);
        const from = all.map((e) => e.type).lastIndexOf('chat.new') + 1;
        return all.slice(from).filter((e) => e.type === 'message').slice(-(i.limit ?? 20)).map((e) => ({ n: e.n, by: e.by, text: e.text, refs: e.refs }));
      },
    },
    {
      name: 'chat.new', kind: 'write',
      about: 'Start a new conversation: the chat is cleared and the agent forgets what was said. What was made stays: records, concepts, and proposals that are still pending.',
      run: (c) => events.add({ type: 'chat.new', by: c.by }),
    },
    {
      name: 'events.since', kind: 'read',
      about: 'Everything that happened after event number n: messages, proposals, pictures, playtests.',
      input: { n: 'number' },
      run: (_c, i) => events.since(i.n),
    },

    // ---- records: the content
    {
      name: 'records.list', kind: 'read',
      about: 'The paths of the content records ("<kind>/<id>"), all of them or of one kind.',
      input: { kind: 'string?' },
      run: (_c, i) => Object.keys(records.all()).filter((p) => !i.kind || p.startsWith(i.kind + '/')).sort(),
    },
    {
      name: 'records.all', kind: 'read',
      about: 'Every content record at once, by path. With proposed, as the pending proposals (of one round, or all) would leave them: this is what the page plays a proposal on.',
      input: { proposed: 'boolean?', round: 'string?' },
      run: (_c, i) => (i.proposed ? proposed(i.round).set : records.all()),
    },
    {
      name: 'records.get', kind: 'read',
      about: 'One content record. A path may end in /* for every record of a kind. With proposed, as the pending proposals would leave it.',
      input: { path: 'string', proposed: 'boolean?' },
      run(_c, i) {
        const set = i.proposed ? proposed().set : records.all();
        if (i.path.endsWith('/*')) {
          const kind = i.path.slice(0, -1);
          return Object.fromEntries(Object.entries(set).filter(([p]) => p.startsWith(kind)));
        }
        const rec = set[i.path];
        if (!rec) throw new CommandError('missing', `there is no record ${i.path}; see records.list`);
        return rec;
      },
    },
    {
      name: 'records.set', kind: 'write', agent: 'proposes',
      about: 'Change fields of a content record: value holds only the fields that change. The person\'s change is made at once; the agent\'s becomes a proposal for the person to play, accept or reject. note says why.',
      input: { path: 'string', value: 'json', note: 'string?' },
      run(c, i) {
        const now = records.get(i.path);
        if (!now) throw new CommandError('missing', `there is no record ${i.path}; see records.list. New kinds of thing need code, which is not a record's to add`);
        if (!i.value || typeof i.value !== 'object' || Array.isArray(i.value)) throw new CommandError('input', 'value is an object with the fields that change');
        locks.guard(`record:${i.path}`, c.by);
        const after: RecordValue = {};
        for (const k in i.value) {
          if (!(k in now)) throw new CommandError('input', `${i.path} has no field ${k}; it has: ${Object.keys(now).join(', ')}`);
          if (!same(now[k], i.value[k])) after[k] = i.value[k];
        }
        if (!Object.keys(after).length) return { changed: false, says: 'that is what it already is' };
        if (isAgent(c.by)) {
          const before: RecordValue = Object.fromEntries(Object.keys(after).map((k) => [k, now[k]]));
          const round = c.round ?? 'loose';
          const p = proposals.add({ round, by: c.by, kind: 'record', path: i.path, before, after, note: i.note ?? '' });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'record', path: i.path, before: p.before, after: p.after, note: p.note, touches: touching(i.path) });
          return { proposed: p.id, round, says: 'proposed; the person decides. Play it first with playtest.compare' };
        }
        records.set(i.path, { ...now, ...after });
        contentChanged();
        events.add({ type: 'record.changed', by: c.by, path: i.path, after });
        return { changed: true };
      },
    },

    // ---- locks
    {
      name: 'locks.list', kind: 'read',
      about: 'What is locked: things that are the person\'s alone. The agent cannot change a locked thing or propose a change to it, even when asked.',
      run: () => locks.list(),
    },
    {
      name: 'locks.set', kind: 'write',
      about: 'Lock or unlock something: ref is "concept:<id>", "record:<path>" or "drawing:<name>". Only the person does this.',
      input: { ref: 'string', locked: 'boolean' },
      run(c, i) {
        if (locks.has(i.ref) === i.locked) return { locked: i.locked };
        locks.set(i.ref, i.locked);
        events.add({ type: 'lock.changed', by: c.by, ref: i.ref, locked: i.locked });
        return { locked: i.locked };
      },
    },

    // ---- proposals
    {
      name: 'proposals.list', kind: 'read',
      about: 'What has been proposed: all of it, or only what is pending, accepted or rejected.',
      input: { status: 'string?' },
      run: (_c, i) => proposals.list({ status: i.status }),
    },
    {
      name: 'proposals.decide', kind: 'write',
      about: 'Accept or reject a round of proposals as one. Accepting makes the changes real.',
      input: { round: 'string', accept: 'boolean' },
      async run(c, i) {
        if (i.accept) art.acceptable(i.round);
        const set = proposals.decide(i.round, i.accept ? 'accepted' : 'rejected');
        if (!set.length) throw new CommandError('missing', `nothing is pending in round ${i.round}`);
        if (i.accept) {
          for (const p of set) {
            if (p.kind === 'record') records.set(p.path, { ...(records.get(p.path) ?? {}), ...p.after });
            else if (p.kind === 'concept') {
              const now = concepts.get(p.path);
              concepts.save({ id: p.path, name: p.path, stage: 'idea', links: [], realised: [], text: '', ...now, ...(p.after as Partial<Concept>) });
            }
          }
          contentChanged();
        }
        await art.decide(i.round, i.accept, set);
        events.add({ type: 'proposal.decided', by: c.by, round: i.round, status: i.accept ? 'accepted' : 'rejected', count: set.length, paths: set.map((p) => `${p.kind}:${p.path}`) });
        return { decided: set.length };
      },
    },

    // ---- concepts: the layer the person works in
    {
      name: 'concepts.list', kind: 'read',
      about: 'Every concept: its name, its stage (idea, design, build, playtest), whether it is locked, and its first line.',
      run: () => concepts.list().map(conceptBrief),
    },
    {
      name: 'concepts.get', kind: 'read',
      about: 'One concept in full: the words, its stage, whether it is locked, its links and what makes it real.',
      input: { id: 'string' },
      run(_c, i) {
        const c = concepts.get(i.id);
        if (!c) throw new CommandError('missing', `there is no concept ${i.id}; see concepts.list`);
        return { ...c, locked: locks.has(`concept:${c.id}`) };
      },
    },
    {
      name: 'concepts.create', kind: 'write', agent: 'proposes',
      about: 'A new concept: a name and a description in plain words. It starts as an idea unless said otherwise. The agent\'s becomes a proposal.',
      input: { name: 'string', text: 'string?', stage: 'string?' },
      run(c, i) {
        const cid = concepts.slug(i.name);
        if (concepts.get(cid)) throw new CommandError('exists', `there already is a concept ${cid}`);
        const stage = STAGES.includes(i.stage) ? i.stage : 'idea';
        const fresh: Concept = { id: cid, name: i.name, stage, links: [], realised: [], text: i.text ?? '' };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          const { id: _id, ...after } = fresh;
          const p = proposals.add({ round, by: c.by, kind: 'concept', path: cid, after: after as unknown as RecordValue, note: 'a new concept' });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'concept', path: cid, after: p.after, note: p.note });
          return { proposed: p.id, id: cid, round };
        }
        concepts.save(fresh);
        events.add({ type: 'concept.changed', by: c.by, id: cid, what: 'created' });
        return { id: cid };
      },
    },
    {
      name: 'concepts.update', kind: 'write', agent: 'proposes',
      about: 'Change a concept: its name, text, stage (idea, design, build, playtest), links ([{to, kind}], kind is part-of, leads-to or clashes-with), realised (record paths, drawings, tests). The agent\'s becomes a proposal.',
      input: { id: 'string', name: 'string?', text: 'string?', stage: 'string?', links: 'json?', realised: 'json?', note: 'string?' },
      run(c, i) {
        const now = concepts.get(i.id);
        if (!now) throw new CommandError('missing', `there is no concept ${i.id}; see concepts.list`);
        if (i.stage !== undefined && !STAGES.includes(i.stage)) throw new CommandError('input', `stage is one of ${STAGES.join(', ')}`);
        locks.guard(`concept:${i.id}`, c.by);
        for (const k of ['links', 'realised'] as const) checkList(i[k], k);
        const after: Record<string, unknown> = {};
        for (const k of ['name', 'text', 'stage', 'links', 'realised'] as const)
          if (i[k] !== undefined && !same(i[k], now[k])) after[k] = i[k];
        if (!Object.keys(after).length) return { changed: false };
        if (isAgent(c.by)) {
          const round = c.round ?? 'loose';
          const before = Object.fromEntries(Object.keys(after).map((k) => [k, now[k as keyof Concept]]));
          const p = proposals.add({ round, by: c.by, kind: 'concept', path: i.id, before: before as RecordValue, after: after as RecordValue, note: i.note ?? '' });
          events.add({ type: 'proposal', by: c.by, round, id: p.id, kind: 'concept', path: i.id, before: p.before, after: p.after, note: p.note, touches: [{ id: now.id, name: now.name, stage: now.stage }] });
          return { proposed: p.id, round };
        }
        concepts.save({ ...now, ...(after as Partial<Concept>) });
        events.add({ type: 'concept.changed', by: c.by, id: i.id, what: 'updated', fields: Object.keys(after) });
        return { changed: true };
      },
    },
    {
      name: 'concepts.remove', kind: 'write',
      about: 'Throw a concept away.',
      input: { id: 'string' },
      run(c, i) {
        if (!concepts.get(i.id)) throw new CommandError('missing', `there is no concept ${i.id}`);
        concepts.remove(i.id);
        events.add({ type: 'concept.changed', by: c.by, id: i.id, what: 'removed' });
        return { removed: true };
      },
    },

    // ---- worlds
    {
      name: 'world.push', kind: 'write',
      about: 'The page shares the world being played, so the agent can read it and look at it. Done by the page every few seconds.',
      input: { snapshot: 'json' },
      run(_c, i) {
        rooms.set('mine', { snapshot: i.snapshot, at: Date.now() });
        writeFileSync(mineFile, JSON.stringify(i.snapshot));
        return { ok: true };
      },
    },
    {
      name: 'world.rooms', kind: 'read',
      about: 'The worlds on the host: mine (a mirror of the one being played) and the sandboxes.',
      run: () => [...rooms].map(([name, r]) => ({ name, sandbox: name !== 'mine', secondsAgo: Math.round((Date.now() - r.at) / 1000) })),
    },
    {
      name: 'world.fork', kind: 'write', agent: 'free',
      about: 'Make a sandbox world to play and poke in: a copy of the one being played (from "mine", the default), of another room, or a brand new game (from "new").',
      input: { room: 'string', from: 'string?' },
      run(_c, i) {
        if (i.room === 'mine' || !/^[a-z][a-z0-9-]{0,30}$/.test(i.room)) throw new CommandError('input', 'a sandbox is named in lower-case letters, and is not called mine');
        const from = i.from ?? 'mine';
        const snapshot = from === 'new' ? undefined : world(from).snapshot();
        rooms.set(i.room, { world: build(snapshot), at: Date.now() });
        return { room: i.room, state: world(i.room).describe() };
      },
    },
    {
      name: 'world.drop', kind: 'write', agent: 'free',
      about: 'Throw a sandbox away.',
      input: { room: 'string' },
      run(_c, i) {
        if (i.room === 'mine') throw new CommandError('permission', 'mine is not a sandbox');
        return { dropped: rooms.delete(i.room) };
      },
    },
    {
      name: 'game.state', kind: 'read',
      about: 'A world in words and numbers: where the player is, what they have, what is unlocked. Without a room, the one being played.',
      input: { room: 'string?' },
      run: (_c, i) => ({ room: i.room ?? 'mine', state: world(i.room).describe() }),
    },
    {
      name: 'game.look', kind: 'look',
      about: 'A picture of a world as it is now, with the same state in words. The file can be read as an image. The mirror of the world being played has the right state but not the exact places of everything in it.',
      input: { room: 'string?', caption: 'string?' },
      run(c, i) {
        const w = world(i.room);
        const look = saveLook(game.render(w, { time: 3.3 }));
        const text = w.describe();
        events.add({ type: 'look', by: c.by, url: look.url, caption: i.caption ?? `${i.room ?? 'the world being played'}, now`, text });
        return { ...look, text };
      },
    },
    {
      name: 'game.lookAt', kind: 'look',
      about: 'A picture of the game some minutes in: a new game is played up to there by a bot (profile: eager or casual) and drawn. With proposed, on the content as the pending proposals would leave it. Takes a few seconds per hour of game.',
      input: { minutes: 'number', profile: 'string?', proposed: 'boolean?', caption: 'string?' },
      async run(c, i) {
        const look = newLookFile();
        const set = i.proposed ? proposed(undefined).set : records.all();
        const res = await runJob<{ text: string }>({ game: id, records: set, do: 'lookAt', minutes: Math.max(0, i.minutes), profile: i.profile, out: look.file });
        events.add({ type: 'look', by: c.by, url: look.url, caption: i.caption ?? `${i.minutes} minutes in${i.proposed ? ', as proposed' : ''}`, text: res.text });
        return { ...look, text: res.text };
      },
    },

    // ---- playtests
    {
      name: 'playtest.run', kind: 'read',
      about: 'Let a bot play the whole game (profile eager or casual) and say when every milestone came, in minutes. With proposed, on the content as the pending proposals would leave it. About ten seconds.',
      input: { profile: 'string?', proposed: 'boolean?', round: 'string?' },
      async run(c, i) {
        const profile = i.profile ?? 'eager';
        if (!game.profiles.includes(profile)) throw new CommandError('input', `profile is one of ${game.profiles.join(', ')}`);
        const set = i.proposed ? proposed(i.round).set : records.all();
        const pacing = await runJob<Pacing>({ game: id, records: set, do: 'pacing', profile });
        events.add({ type: 'playtest', by: c.by, kind: 'run', profile, proposed: !!i.proposed, length: pacing.length, minutes: pacing.minutes });
        return { profile, length: pacing.length, minutes: pacing.minutes, took: pacing.took };
      },
    },
    {
      name: 'playtest.compare', kind: 'read',
      about: 'Play the game twice, as it is and as the pending proposals would leave it (of one round, or all), and say which milestones moved, and by how much. Do this before telling the person what a proposal does. About twenty seconds.',
      input: { round: 'string?', profile: 'string?' },
      async run(c, i) {
        const profile = i.profile ?? 'eager';
        if (!game.profiles.includes(profile)) throw new CommandError('input', `profile is one of ${game.profiles.join(', ')}`);
        const round = i.round ?? (isAgent(c.by) ? c.round : undefined);
        let after = proposed(round);
        if (!after.changes.length && !i.round) after = proposed(undefined);
        if (!after.changes.length) throw new CommandError('missing', 'no record proposals are pending, so there is nothing to compare');
        const [a, b] = await Promise.all([
          runJob<Pacing>({ game: id, records: records.all(), do: 'pacing', profile }),
          runJob<Pacing>({ game: id, records: after.set, do: 'pacing', profile }),
        ]);
        const out = {
          profile, round: round ?? 'all pending', changes: after.changes.map((p) => p.path),
          length: { before: a.length, after: b.length },
          moved: compare(a, b),
        };
        events.add({ type: 'playtest', by: c.by, kind: 'compare', ...out });
        return out;
      },
    },
    {
      name: 'playtest.milestones', kind: 'read',
      about: 'The milestones a playthrough reports, each with a few words: so that the names in a playtest mean something.',
      run: () => game.milestones(),
    },

    // ---- the stage: the agent shows the person something in the app
    {
      name: 'stage.point', kind: 'write', agent: 'free',
      about: 'Point at a place in the world being played (world units) with a few words: a ring appears there on the person\'s screen.',
      input: { x: 'number', y: 'number', text: 'string?' },
      run: (c, i) => { events.add({ type: 'stage.point', by: c.by, x: i.x, y: i.y, text: i.text ?? '' }); return { shown: true }; },
    },
    {
      name: 'stage.open', kind: 'write', agent: 'free',
      about: 'Open something on the person\'s screen: tab is chat, concepts, content, art, inspect or playtest; id is the concept, record path, drawing or entity to open there.',
      input: { tab: 'string', id: 'string?' },
      run: (c, i) => { events.add({ type: 'stage.open', by: c.by, tab: i.tab, id: i.id ?? '' }); return { shown: true }; },
    },
  ];

  // The game's own commands and the inspector work on the host's worlds; the page has the same ones on its own.
  const guarded = (defs: CommandDef[]): CommandDef[] => defs.map((d) => d.kind !== 'write' || d.name.startsWith('ecs.') ? d : {
    ...d, run: (c, i) => { sandboxOnly(i.room, c.by); return d.run(c, i); },
  });
  const art = createArt({ game: id, root: ROOT, gameDir, dataDir, events, proposals, locks, newLookFile });
  registry.add(...core, ...guarded(game.commands(world)), ...ecsCommands(world, game, sandboxOnly), ...art.commands);

  return {
    game, registry, events, records, proposals, concepts, locks, art,
    dirs: { game: gameDir, data: dataDir, looks: looksDir },
    run: (name, input, by, round) => registry.run(name, input, { by, round }),
    world,
  };
}

/** Throw away what a host keeps outside git: for tests. */
export const wipeData = (dir: string) => rmSync(dir, { recursive: true, force: true });
