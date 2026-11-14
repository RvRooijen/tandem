# tandem

A tool for one person and an AI to build a project together: a game, or any
web project. You start it once and choose a project. It shows the project's own
page with a sheet of tools over it (a chat, concepts, art), and runs an agent
that works on the project through the same commands your screen uses.

Tandem brings nothing into a project but a small folder of its own (`.tandem`).
The project stays what it was.

## Start

    /path/to/tandem/bin/tandem            # or put tandem/bin on your PATH and type: tandem
    tandem ~/projects/your-project        # straight into one project

Then open tandem's page and choose a project in the Projects tab: the folders next to tandem itself are listed (and
any other folder you add there). What was open last is opened again the next time.

    tandem's page    http://localhost:5173    open this one
    the core         http://127.0.0.1:5201    commands, events, the agent
    what it is doing http://127.0.0.1:5202    while the core is starting (on a slow disk opening a project takes a while) and cannot answer yet
    the project      http://localhost:5210    its own page, shown in tandem's
    the copy         http://localhost:5211    the agent's working copy, when you ask to play it

Everything listens on this machine only: the core can start an agent with a
command line.

    tandem list                 every command the running core has
    tandem run concepts.list    run one
    TANDEM_AGENT=off tandem     without the agent
    npm test                    (in tandem) its own tests

## What a project needs

A git repository. That is all: tandem then gives you the chat, concepts, locks
and an agent that reads the project and codes in a working copy.

Everything else is optional, in `.tandem/tandem.json` (tandem's own folder in the project; a `tandem.json` at the
project's root is read too, when you would rather keep it among the project's files). The agent proposes it
(`project.configure`) when it sets tandem up; nothing of tandem's is written among the project's own files, so a
project that wants tandem out of its history ignores `.tandem` and that is all:

    {
      "name": "Gnome Garden",
      "page": "npx vite --port {port} --strictPort --host 127.0.0.1",
      "test": "npm test",
      "check": "npx tsc --noEmit",
      "run": ["npm run lint"],
      "adapter": "tandem.adapter.ts",
      "art": { "build": "node tools/import-art.ts" }
    }

- **page**: how the project's page is started, with `{port}` where the port goes (and `{project}` for the project's own folder, to name a script of its own). The working copy's page gets `TANDEM_COPY=1` in its environment, for a project that wants the copy to keep its hands off something (a database). Tandem shows it in a frame, and starts it a second time from the agent's working copy when you want to play that. For a project with Vite in its package.json this is guessed.
- **test**, **check**, **run**: what the agent may run in its working copy. Without them it can change code but run nothing, and says so.
- **art**: drawings live in `art/` (depth maps in `depth/`) as text, in pixeldraw's format. `build` is the project's own step that turns them into what it loads.
- **adapter**: a module that lets tandem see inside the running project (see below).
- **edit**: what the agent may change, as patterns; everything but `.tandem`, `art` and `depth` by default.

## A new project, and one that exists already

The project chooser (the folder button in the sheet) makes a new project: a name, and a folder you choose by walking
the folders of the machine (it is never chosen for you); it makes a new folder there with a git repository in it.
It also opens any folder; one without a repository gets one, with what is in it as its first commit.

In a project tandem has not been in before, the chat opens with a first line. For one that has things in it, that
is the offer to set tandem up for it (also: the button in the empty Concepts tab, or under the project in the
project chooser; `project.init`). The agent reads the project (its notes, its scripts, its code) and proposes the
concepts it is already made of, and how tandem runs it (kept in `.tandem`, not among the project's files); both come as proposals. It takes commands
from the project's own scripts and notes and cannot start the page itself, so what it writes for `page` is unrun until
you see it work.

## How much a project shows

| The project has | Then |
| --- | --- |
| a git repository | chat, concepts, locks; the agent reads the code and codes in a working copy; its change set is a proposal you accept as one commit |
| `page` | you use the project inside tandem, and can switch the frame to the agent's working copy before accepting |
| `test` / `check` | the agent runs them before it says something works |
| drawings in `art/` | the Art tab: look at a drawing, lock it, ask a worker for a change and watch it draw; its round is a proposal with pictures |
| the bridge in its page | the agent can read the world you are in; the working copy starts from where you are; the agent can point at things |
| an adapter | the agent sees inside: state in words, pictures, entities and systems, a bot that plays it through, and all of that on its working copy too |

**Pointing, on any page.** A project's page is started on an inner port and shown through tandem (`core/through.ts`), which
adds a few lines of its own to it on the way (`bridge/page.js`); the project is not changed for it. With those, the agent
can put a ring around something on the page (`stage.point` with `at`: the words on it, or a selector), and you can drag
tandem's round button onto something to point at it: it goes with your next message.

**The bridge** is one small file, `bridge/tandem.bridge.ts`, copied into the project (it has no imports). The page calls `tandemStart()` before it starts its world and `tandemConnect({ snapshot, toScreen })` once it runs. Outside tandem's frame it does nothing.

**The adapter** exports `game`, a `GameModule` (`core/game.ts`): how to make a world from a snapshot, step it, describe it in words, draw it to pixels, let a bot play it and report milestones, and the things a player can do as commands. Tandem loads it in the core and in jobs, never in the page. Gnome Garden's is `tandem.adapter.ts` in `../incremental`.

## The idea

- **Everything is a command.** `core/commands.ts` is the only door. A button in the page, the agent's command line and the tests call the same named commands; the only difference is who is asking.
- **Concepts** (`.tandem/concepts/*.md`) are a name and a description in your own words, with links, what makes them real, and a stage (idea, design, build, playtest) that tells the agent what kind of help fits. They hold words, not numbers to be met.
- **Locks.** A concept or a drawing can be locked: the engine refuses the agent any change or proposal to it, even when you ask the agent for one.
- **Working files and project files.** The project is what you use. The agent codes in a working copy (a git worktree in a hidden folder right beside the project, so `../something` still resolves). What the copy differs from the project is one change set: a card with the files, the copy played in the frame, accept (one commit) or reject. Your own uncommitted work is never committed, reset or overwritten for you; if it is in the way of an accept, tandem says which files.
- **The person's change is made; the agent's is proposed**, for concepts and drawings too. Everything proposed while answering one message is one round.
- **The chat is where things are asked.** Type @ to point at a concept or a drawing; use the paperclip (or paste) to share a photo or a file, which the agent reads. Art is asked for there too: the Art tab is for looking, locking and watching a worker draw. With the tools shut, tandem speaks in a bubble over the project's page; what waits for an answer stays there with Approve and Decline. The tools never open by themselves.
- **Art is drawn in rounds.** A drawing worker (a headless Claude with pixeldraw's way of working: silhouette first, then colour) draws in its own copy; you watch it in the Art tab as it is typed. Accepted art goes into the project's art files and the agent is told: bringing it into the project is its work.

## Layout

    bin/tandem   the command
    core/        commands, events, proposals, concepts, locks, the project (project.ts), the host that ties
                 them together, the HTTP server, the agent runner and what the agent is told, the agent's
                 working copy (code.ts) and its page (preview.ts), jobs
    art/         drawings: pixeldraw's format, renderer and tests (src/, scripts/, test/, as they are there),
                 the guide a drawing worker follows, workspaces, workers, sprites, the art commands
    ecs/         the inspector, for projects on archetype-ecs with an adapter
    playtest/    pacing runs, and comparing two of them
    bridge/      the file a project's page copies to talk to tandem, and the lines tandem adds to any page it shows
    shell/       tandem's page: the project in a frame, a sheet with Chat, Concepts and Art over it
    test/        on a small fixture project (test/fixture) and, for what needs an adapter, on Gnome Garden

In a project: `.tandem/tandem.json` (and `.tandem/page.sh` when starting the page takes a script), `.tandem/concepts`, `.tandem/locks.json`, and `.tandem/data` (not in git: the event log, proposals, pictures, the agent's session).

## Where it stands

Works, and is tested: everything above, on the fixture project and on Gnome Garden (`../incremental`), including a real agent coding in its working copy and real drawing workers.

Not there, or not seen:

- **The frame on a real screen.** The shell is driven in jsdom with the bridge's messages said for the page; the project in a frame with the tools over it has not been looked at on a phone.
- **A second real project.** Only Gnome Garden and a fixture run on it. A project without Vite needs its `page` command written by hand; one whose dev server refuses to be framed, or needs its own port, will need care.
- **The agent in a project without an adapter** cannot see the running thing at all; it works from code and tests, and you are its eyes.
- **Live shared world.** The page shares a snapshot every five seconds; the agent reads a mirror, not the live world.
- **Characters with clothes** (pixeldraw's attachments) render but nothing exports them; drawing by hand is not here.
- **A restart cuts work off.** The agent and the workers are children of the core.
