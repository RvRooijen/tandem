# tandem

A small game engine made for one person and an AI to build games together. The
game is ECS (archetype-ecs) with pixel art drawn as text; the engine is
everything around it: one set of commands that the person's screen and the agent both
use, concepts as the layer the person works in, and four senses for the agent
(words, pictures, the ECS, time), and drawing workers that make the art.

The first game on it is Gnome Garden (`games/gnome-garden`).

## Start

    npm install
    npm start          # the core on 127.0.0.1:5201 and the phone page on http://localhost:5173

Both listen on this machine only: the core can start an agent with a command
line. `npm start -- --host` puts the page on the network if you want that.

    npm test                     # everything (about a minute: it plays a few whole games)
    npm run tandem list          # every command
    npm run tandem run game.state
    npm run game                 # Gnome Garden on its own, no engine (port 5184)
    TANDEM_AGENT=off npm start   # without the agent

## The idea in five lines

- **Everything is a command.** `core/commands.ts` is the only door. A button in the page, the agent's command line, the bot and the tests call the same named commands; the only difference is who is asking. `test/shell.test.ts` checks that the page uses nothing else.
- **The person's change is made; the agent's is proposed.** An agent's write to a concept or a drawing becomes a proposal, and its code is a change set from its working copy. Everything proposed while answering one message is one round, played, accepted or rejected as one.
- **Concepts** (`games/<game>/concepts/*.md`) are a name and a description in the person's words, with links to each other, what makes them real, and a stage (idea, design, build, playtest) that says where they are on the way into the game. A concept holds words, not numbers to be met: a playtest reports timings, it never judges them.
- **Locks.** A concept or a drawing can be locked. A locked thing is the person's alone; the engine refuses the agent any change or proposal to it, even when the person asks the agent for one.
- **A number is code.** Everything the game is tuned with (prices, growth, timings, diary lines) is in the game's code, in one place (`src/sim/content.ts`), and nowhere else. Tuning is a change by the agent in its working copy, played against the project (`playtest.compare`) and accepted like any other.
- **The agent has senses**: `game.state` (words), `game.look` / `game.lookAt` (pictures), `ecs.*` (entities and systems), `playtest.run` / `playtest.compare` (a bot plays the whole game in ten seconds, as it is and as proposed), `art.list` / `art.look` (the drawings).
- **Working files and project files.** The project is what is played. The agent codes in a working copy of its own (a git worktree in `.work/agent`), where it can build and run the tests; it may change the game's code there, not the engine, and not content, concepts or drawings as files. What its copy differs from the project is one change set: a card with the files, a button to play the copy (a second page, started from the world you are in, keeping nothing), accept (one commit into the project; the core starts again with the new code) or reject (the copy is the project again). Accepting art puts the drawing in the project's art files and tells the agent, whose work it is to bring it into the game.
- **Art is in the engine.** A drawing is text (`games/<game>/art/<name>.txt`, with a depth map in `depth/`), in pixeldraw's format and rendered by pixeldraw's own code, which lives in `art/`. A drawing worker (a headless Claude with pixeldraw's way of working: silhouette first, then colour, in rounds of edit, render, look) draws in its own copy; what it draws is a proposal with a picture before and after. Accepted, it is built straight into the game's sprites. Nothing outside this repo is needed.

## Layout

    core/        commands, events, proposals, concepts, locks, the host that ties them to a game,
                 the agent's working copy (code.ts) and its page (preview.ts),
                 the HTTP server, the command line, the agent runner and what the agent is told
    art/         drawings: pixeldraw's format, renderer and tests (src/, scripts/, test/, as they are there),
                 the guide a drawing worker follows, workspaces, workers, sprites for a game, the art commands
    ecs/         the inspector: entities, archetypes, systems, as commands
    playtest/    pacing runs, and comparing two of them
    shell/       the phone page: the game, and over it a sheet with Chat, Concepts and Art
    games/<id>/  module.ts (what the engine needs from a game), page.ts (the game in a page),
                 src/, art/ and depth/ (its drawings), concepts/, locks.json, and data/ (not in git: event log, proposals, pictures)
    test/        core, server and runner (with a stand-in for claude), playtests, the shell in jsdom

## What a game gives the engine

`games/<id>/module.ts` exports a `GameModule` (`core/game.ts`): its components, how to make a world, draw it, let a bot play it, the milestones a run reports, and its own commands. `games/<id>/page.ts` exports `mount(root)`, which runs the game in a page and returns its world; the standalone page calls the same function.

## Where it stands

Works, and is tested:

- the command layer, permissions (person / agent / proposal), the event log, SSE
- proposals per round; accept and reject
- concepts with a stage, links and what makes them real; locks on concepts and drawings
- worlds: a mirror of the one being played, sandboxes the agent can play and poke in
- the ECS inspector, in the page (live, on the world being played) and for the agent
- playtests and looks, of the project or of the agent's working copy; the two played against each other
- the agent: headless `claude -p` whose only hands are the command line; it answers in the chat, proposes, plays its proposals, takes pictures, points at the garden
- art: drawings as text in the game, rendered and built into its sprites by the engine (the build gives byte for byte what pixeldraw's export gave); drawing workers with silhouette approval, feedback rounds, proposals with pictures (a real worker drew a garden sign through both phases)
- the shell: the game plays underneath; chat with proposal, picture and playtest cards; concepts; art with workers watched live
- Gnome Garden on it, with its concepts and its drawings

Not there yet:

- **Nobody has looked at the shell on a real screen.** It is driven in jsdom and it builds, but its looks are unseen.
- **Live shared world.** The page plays its own world and shares a snapshot every five seconds; the agent reads a mirror (right state, not the exact place of every entity) and plays in sandboxes. Syncing one world live with archetype-ecs-net, the way testp does, is not built.
- **A restart cuts work off.** The agent and the drawing workers are child processes of the core; restarting it stops whatever is mid-run. A stopped worker keeps its conversation and its copy, and goes on with the next feedback.
- **Characters with clothes.** pixeldraw's attachments (a body with items per slot) render here, but nothing exports them to a game, and a worker cannot be asked for one from the page.
- **Drawing by hand.** pixeldraw's viewer (painting pixels, sketching over a frame, watching every edit live) is not here; the page shows renders.
- **The agent coding, for real.** The working copy, the change set and the hand-over of accepted art are tested with a stand-in for Claude; a real agent has not coded a change yet, and the page of the working copy has not been seen on a screen.
- **The engine itself** is not the agent's to change; it says what it would need.
- **One game at a time**, chosen with `TANDEM_GAME`. There is no second game yet to prove the seams.
- Playing a proposal lays it over the game you are in the middle of; there is no "from the start" yet other than the bot's.
