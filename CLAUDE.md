# tandem

A game engine for one person and an AI; see README.md for the idea and the layout.

- Node 22 runs the TypeScript directly: imports end in `.ts`, no enums, no parameter properties.
- `npm test` runs everything; `npx tsc --noEmit` type-checks. There is no browser here: the shell is tested in jsdom (`test/shell.test.ts`), never with screenshots.
- Everything that can be done is a command in a registry (`core/commands.ts`, `core/host.ts`). A new button in the shell means a command first; the shell only ever calls `run()` / `app.act()` from `shell/api.ts`, and a test enforces it.
- An agent's write is refused unless the command says `agent: 'free'` (cannot touch the project) or `agent: 'proposes'` (turns itself into a proposal).
- A game's numbers live in `games/<id>/content` as records, not in code. Tests use a scratch folder (`test/helpers.ts`) so they never write there.
- `games/<id>/data/` is not in git: the event log, proposals, pictures, the agent's session.
- `art/src`, `art/scripts` and `art/test` are pixeldraw's code as it is there (plain JavaScript); only `art/scripts/bus.js` is tandem's own. A game's drawings are text in `games/<id>/art` and `depth`; `npm run art` builds them into the game, and a test fails when that was forgotten.
- Heavy work that needs other content than the accepted one (a playtest of a proposal) runs in a child process (`core/job.ts`), because a game's content lives in its module.
