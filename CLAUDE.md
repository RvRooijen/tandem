# tandem

A tool for one person and an AI to build a project together; see README.md. It is started in a project's folder and works on that project from outside.

- Node 22 runs the TypeScript directly: imports end in `.ts`, no enums, no parameter properties.
- `npm test` runs everything; `npx tsc --noEmit` type-checks. There is no browser here: the shell is tested in jsdom (`test/shell.test.ts`), never with screenshots.
- Nothing in here knows a particular project. What a project is comes from `core/project.ts` (its `tandem.json`, its `.tandem` folder) and, for seeing inside it, its adapter. Commands that need an adapter are registered only when there is one.
- Everything that can be done is a command (`core/commands.ts`, `core/host.ts`, `art/commands.ts`). A new button in the shell means a command first; the shell only calls `run()` / `app.act()` from `shell/api.ts`, and a test enforces it.
- An agent's write is refused unless the command says `agent: 'free'` (cannot touch the project) or `agent: 'proposes'` (turns itself into a proposal). The one exception is drawing work, which is the agent's from start to finish: it is told when a worker's round ends and takes the drawing into the project itself (`art.accept`); the person only watches, and a lock keeps a drawing out of it.
- The agent never writes in the project: it codes in a worktree beside it (`.<project>-tandem-work`, branch `tandem-agent`), and accepting squashes that into the project's branch. The engine commits only what it wrote itself in a project (concepts, locks, accepted drawings); the person's uncommitted work is never committed, reset or overwritten. After an accept the project's branch is pushed to its remote when it has one (never forced).
- The shell does not load a project's code: the project's page is in a frame, and talks to the shell through `bridge/tandem.bridge.ts` (postMessage). Keep the bridge free of imports; projects copy it.
- `art/src`, `art/scripts`, `art/runtime` and `art/test` are pixeldraw's code as it is there (plain JavaScript); only `art/scripts/bus.js` is tandem's own. `art/export.ts` (`tandem export <folder>`) is tandem's build of a project's drawings, for a project that has none: it writes what pixeldraw's sprite and game export write.
- Tests never write in a real project: `test/helpers.ts` makes a fixture project in a temporary folder, and uses Gnome Garden (`../incremental`) read-only with a temporary worktree for what needs an adapter.
- Before restarting a running core by hand, look at `agent.status` and `art.workers`: the agent and the workers are its children. `core/start.ts` restarts the core by itself (exit code 75) after code is accepted.
