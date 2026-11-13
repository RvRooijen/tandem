# tandem

A small game engine made for one person and an AI to build games together. The
game is ECS (archetype-ecs) with art from pixeldraw; the engine is everything
around it: one set of commands that the person's screen and the agent both
use, concepts as the layer the person works in, and four senses for the agent
(words, pictures, the ECS, time), with art as work it can hand to a pixeldraw worker.

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
- **The person's change is made; the agent's is proposed.** An agent's write to content or a concept becomes a proposal. Everything proposed while answering one message is one round, played, accepted or rejected as one.
- **Concepts** (`games/<game>/concepts/*.md`) are a name and a description in the person's words, with links to each other, what makes them real, and a firmness (loose, worked, playable, fixed) that says how much freedom the agent has. A concept holds words, not numbers to be met: a playtest reports timings, it never judges them.
- **Content is records** (`games/<game>/content/<kind>/<id>.json`): every number and line the game is tuned with. The game reads them; nothing is tuned in code.
- **The agent has senses**: `game.state` (words), `game.look` / `game.lookAt` (pictures), `ecs.*` (entities and systems), `playtest.run` / `playtest.compare` (a bot plays the whole game in ten seconds, as it is and as proposed), `art.list` / `art.look` (the drawings).

## Layout

    core/        commands, events, records, proposals, concepts, the host that ties them to a game,
                 the HTTP server, the command line, the agent runner and what the agent is told,
                 art (the drawings, and pixeldraw's workers)
    ecs/         the inspector: entities, archetypes, systems, as commands
    playtest/    pacing runs, and comparing two of them
    shell/       the phone page: the game, and over it a sheet with Chat, Concepts, Content, Art, Inspect, Playtest
    games/<id>/  module.ts (what the engine needs from a game), page.ts (the game in a page),
                 src/, art/, content/, concepts/, and data/ (not in git: event log, proposals, pictures)
    test/        core, server and runner (with a stand-in for claude), playtests, the shell in jsdom

## What a game gives the engine

`games/<id>/module.ts` exports a `GameModule` (`core/game.ts`): its components, its content as records and how to lay records over it, how to make a world, draw it, let a bot play it, the milestones a run reports, and its own commands. `games/<id>/page.ts` exports `mount(root)`, which runs the game in a page and returns its world; the standalone page calls the same function.

## Where it stands

Works, and is tested:

- the command layer, permissions (person / agent / proposal), the event log, SSE
- records with a proposal overlay; proposals per round; accept and reject
- concepts with firmness, links and what makes them real
- worlds: a mirror of the one being played, sandboxes the agent can play and poke in
- the ECS inspector, in the page (live, on the world being played) and for the agent
- playtests: a run, a before/after comparison of a proposal, a look at any minute
- the agent: headless `claude -p` whose only hands are the command line; it answers in the chat, proposes, plays its proposals, takes pictures, points at the garden
- art: the game's drawings listed and drawn as sheets; bringing them in from pixeldraw (`art.import`, run for real once)
- the shell: the game plays underneath; chat with proposal, picture and playtest cards; concepts; content; art; inspector with pick-in-the-garden; playtest
- Gnome Garden on it, with its numbers as records and eight concepts

Not there yet:

- **Nobody has looked at the shell on a real screen.** It is driven in jsdom and it builds, but its looks are unseen.
- **Live shared world.** The page plays its own world and shares a snapshot every five seconds; the agent reads a mirror (right state, not the exact place of every entity) and plays in sandboxes. Syncing one world live with archetype-ecs-net, the way testp does, is not built.
- **Art, the round trip.** Asking a pixeldraw worker (`art.ask`), telling, approving and accepting it are thin calls to pixeldraw's own `scripts/api.js`. Only `art.workers` and `art.import` have been run against the real pixeldraw; no worker has been started from here yet. pixeldraw's viewer and worker have to be running (ports 5173), and watching a worker draw still happens there. A new drawing also needs code before the game shows it.
- **Code.** The agent cannot change code, only content and concepts. A new kind of thing (a new flower with its own sprite, a new rule) still needs a coding session.
- **New records.** A record can be changed, not added: the game only reads the ones it knows.
- **One game at a time**, chosen with `TANDEM_GAME`. There is no second game yet to prove the seams.
- Playing a proposal lays it over the game you are in the middle of; there is no "from the start" yet other than the bot's.
