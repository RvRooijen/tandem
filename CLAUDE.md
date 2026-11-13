# tandem

A game engine for one person and an AI; see README.md for the idea and the layout.

- Node 22 runs the TypeScript directly: imports end in `.ts`, no enums, no parameter properties.
- `npm test` runs everything; `npx tsc --noEmit` type-checks. There is no browser here: the shell is tested in jsdom (`test/shell.test.ts`), never with screenshots.
- Everything that can be done is a command in a registry (`core/commands.ts`, `core/host.ts`). A new button in the shell means a command first; the shell only ever calls `run()` / `app.act()` from `shell/api.ts`, and a test enforces it.
- An agent's write is refused unless the command says `agent: 'free'` (cannot touch the project) or `agent: 'proposes'` (turns itself into a proposal).
- A game's numbers live in its code (`src/sim/content.ts`), in one place. Tests use a scratch folder for the game's concepts, drawings and data (`test/helpers.ts`), and a temporary git worktree where they need the agent's working copy; they never write in the project.
- `games/<id>/data/` is not in git: the event log, proposals, pictures, the agent's session.
- `art/src`, `art/scripts` and `art/test` are pixeldraw's code as it is there (plain JavaScript); only `art/scripts/bus.js` is tandem's own. A game's drawings are text in `games/<id>/art` and `depth`; `npm run art` builds them into the game, and a test fails when that was forgotten.
- The agent in the app never writes in the project: it codes in `.work/agent` (a worktree, branch `work/agent`), and accepting its change set squashes it into `main`. Changes the engine makes to a game's files (accepted content, concepts, art) are committed by themselves before the copy is brought up to date.
- `npm start` runs the core under a small supervisor (`core/start.ts`) that starts it again when it exits with code 75, which it does after code is accepted. Before restarting it by hand, look at `agent.status` and `art.workers`: the agent and the workers are its children.
- Heavy work (a playtest, a look some minutes in) runs in a child process (`core/job.ts`); run from the working copy, the same job plays and draws the copy.
