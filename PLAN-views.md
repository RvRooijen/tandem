# Views: meer dan de page bekijken

Gebouwd; dit is bijgewerkt naar hoe het nu is.

Linksboven over de stage komen tabjes. Eén ervan is de page zoals nu; de andere zijn views op wat er verder draait
of ligt: logs, de API, data, of een view die de agent voor dit project bouwt. Alles wat in een view staat kun je
aanwijzen, net als op de page, en het gaat als ref mee naar de chat.

## Wat een view is

Elke view is een HTML-pagina in een eigen frame op de stage. Hij krijgt `bridge/page.js` op dezelfde manier
ingevoegd als de page (via `withTandem`), dus aanwijzen, `page.look` en `pick` werken er vanzelf.

- **Ingebouwde soorten**, door tandem meegeleverd in `views/` in tandem zelf, met een paar parameters:
  - `logs`: wat de page en de copy-page op stdout/stderr zeggen. Live, met filter op level/tekst.
  - `api`: een lijst endpoints. Zelf in te vullen in de setup, of uit een OpenAPI-spec als het project die heeft.
    Per endpoint een request doen en de response zien.
  - `data`: een SQLite-file. Tabellen, rijen, en een read-only query.
- **Eigen views** van het project: HTML in `.tandem/views/<name>.html`, door de agent gemaakt.

In `tandem.json`:

    "views": [
      { "name": "Logs", "kind": "logs" },
      { "name": "API", "kind": "api", "endpoints": "dotnet/src/GeneralAgent.WebApp/Api/Routes.cs" },
      { "name": "Index", "kind": "data", "file": "data/index.db" },
      { "name": "Evals", "view": "evals.html" }
    ]

De page zelf is altijd het eerste tabje en hoeft er niet in.

## Hoe een view aan data komt

Alleen via tandem commands, zodat alles wat een view toont ook door de agent op te vragen is.

- **Vaste commands** (in `core/views.ts`):
  - `logs.read`: de laatste regels, of alles na regel n, van de page of de copy.
  - `data.query`: read-only SQL op een SQLite-file in het project (`node:sqlite`, `readOnly: true`). Alleen files
    die een view in de setup noemt.
  - `page.request` bestaat al.
- **Project commands**: `.tandem/commands.ts` exporteert `commands`, een lijst `{ name, about, kind, input, run(input, t) }`.
  Ze gaan via `project.commands` (de lijst) en `project.run { name, input, copy }`; `project.<name>` botste met
  `project.configure` e.d. Een command met `kind: 'write'` wordt een proposal als de agent het
  aanroept (`agent: 'proposes'`); jij voert het vanuit een view gewoon uit.
  Ze draaien in een job (`core/job.ts`-achtig), niet in de core: een fout in de module neemt de core niet mee, en
  een gewijzigde module geldt meteen zonder restart.

Een view roept commands aan via `postMessage` naar de shell; de shell geeft alleen door wat een view mag
(`logs.read`, `data.query`, `page.request`, `project.*`) en doet dat met `run()`. Zo blijft de regel staan dat alleen
de shell commands aanroept.

## Logs

`start.ts` laat de page nu naar de terminal schrijven. Dat wordt een tee: terminal én `.tandem/data/page.log`
(afgekapt op een paar MB). De copy schrijft al naar `copy-page.log`. De logs-view vraagt elke seconde `logs.read`
met `after` (byte offset); dat bleek simpeler dan events, en loopt via dezelfde command als de agent.

## De agent

- Bij `project.init` kijkt de agent wat er draait en ligt, en stelt `views` voor in de setup. Een eigen view en
  `commands.ts` gaan mee als files in de setup proposal (`files: { "views/x.html": "<pad in de copy>" }`).
- `page.look` krijgt `view: <name>` erbij, zodat de agent een view kan bekijken zoals hij nu de page bekijkt.
- Een eigen view wordt in de working copy gebouwd en getest? Nee: `.tandem` is van tandem, niet van het project.
  Hij gaat via de setup. Wel moet de agent hem kunnen zien voordat jij hem accepteert (zie open vragen).

## Shell

- `stage.ts` krijgt meerdere frames: een per tabje, lui geladen, verborgen als je een ander tabje kiest (dan
  behoudt een view zijn state).
- Tabjes linksboven, alleen als er views zijn. Op een telefoon een kleine dropdown.
- Een ref van iets aangewezen in een view: `view:<name>:{words, near, selector}`, plus de foto ervan.

## Movares als eerste case

- **Logs**: de WebApp logt met SimpleConsole; daar zie je indexeren, fouten en Azure-calls.
- **API**: de endpoints uit `Routes.cs` (`/status`, `/answer`, `/query`, `/reindex`, `/portal/*`, ...). Geen OpenAPI,
  dus de agent schrijft de lijst in de setup.
- **Data**: `index.db`, `chunks.db`, `evals.db`, `projects.db`.
- **Eigen views**, voorbeelden: "Index" (welke documenten per bron, hoeveel chunks, wat faalde), "Evals" (rang van
  het juiste document per vraag, per run). Project commands: `project.reindex` (write), `project.eval` (write),
  `project.chunks` (read, de chunks van een document).

## Volgorde

1. Logs: de tee in `start.ts`, `logs.read`, live events, en de ingebouwde logs-view. Daarmee staan de tabjes en het
   aanwijzen in een view.
2. `data.query` en de data-view.
3. De api-view.
4. Project commands via `.tandem/commands.ts`, als job.
5. Eigen views en de setup proposal met files; `page.look` met `view`.
6. Het init-prompt van de agent, en Movares ermee opzetten.

## Open vragen

- ~~Een eigen view zien voordat je hem accepteert~~: als preview. Een view (en `views.ts`) in een setup proposal
  wordt uit de proposal geserveerd en staat als tabje met een "voorgesteld"-markering op de stage, met de
  voorgestelde project commands erbij, zodat jij en de agent hem kunnen gebruiken voordat je accepteert.
- ~~API-view tegen de copy of de page~~: een schakelaar zoals de stage. `page.request` heeft `copy` al.
- ~~`data.query` op de copy~~: ja. De schakelaar project/copy geldt voor alle views: logs, data, api en eigen
  views krijgen `copy: true|false` mee, en de vaste commands en project commands kennen allemaal `copy`.
