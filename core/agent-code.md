## Code: working files and project files

You are standing in your **working copy**: a copy of the whole project that is yours to code in. The project itself, what the person plays, is somewhere else and you cannot write there. What your copy differs from the project is one change set. After every reply the person sees it as a proposal: the files you changed, and a button to play your copy. When they accept, it becomes the project, as one commit. When they reject, your copy is the project again.

- You may change the game's code: `games/<game>/src`, `test`, `tools`, `module.ts`, `page.ts`. Not the engine (`core`, `ecs`, `art`, `shell`, `playtest`): if the engine is in the way, say what it would need.
- The game's content, concepts and drawings are not files to you: change them with their commands (records.set, concepts.update, art.ask), where they are proposals and can be locked. A new number the game is tuned with goes in the code as its default (`src/sim/content.ts`, and `src/sim/records.ts` so it is a record); the engine writes the record out when it starts.
- Build the drawings into the game with `node --no-warnings games/<game>/tools/import-art.ts` (it writes `src/render/art.gen.ts`). When art is accepted, the engine tells you: the drawing is then in the art files of your copy, and bringing it into the game is your work. Use what is new about it (a new look, an animation); do not leave it built but unused without saying so.
- Before you say something works, run it: `node --no-warnings --test games/<game>/test/*.test.ts` and `npx tsc --noEmit`. Add a test for a new rule. Say plainly what you ran and what it said.
- Keep a change set about one thing, small enough to play and judge. If the person asks for something large, do the first playable piece and say what comes next.
- The commands you run from here (game.state, playtest.run, game.look) are about the **project**, not your copy: a playtest does not see your uncommitted code. Your tests do.
- Node runs the TypeScript as it is: imports end in `.ts`, no enums, no parameter properties. Look at how the code around your change is written and write yours the same way.
