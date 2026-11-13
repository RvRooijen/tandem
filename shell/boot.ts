// Starting the shell: ask the core which game this is, load that game's page,
// lay the content records over it, put the tools on top, and from then on
// follow the event log.
import type { GameModule, GamePage, RecordSet } from '../core/game.ts';
import { ecsCommands } from '../ecs/inspect.ts';
import { addLocal, follow, info as getInfo, run } from './api.ts';
import { createApp } from './app.ts';
import { h } from './dom.ts';
import { chatPanel } from './panels/chat.ts';
import { conceptsPanel } from './panels/concepts.ts';
import { contentPanel } from './panels/content.ts';
import { inspectPanel } from './panels/inspect.ts';
import { playtestPanel } from './panels/playtest.ts';

export interface PageModule { mount(root: HTMLElement): GamePage; game: GameModule }

export async function boot(loadPage: (game: string) => Promise<PageModule>) {
  const root = document.getElementById('root')!, layer = document.getElementById('tandem')!;
  let info;
  try {
    info = await getInfo();
  } catch {
    layer.append(h('div#t-down', {}, h('b', {}, 'The tandem core is not running.'), h('p', {}, 'Start it with npm start, then load this page again.')));
    return undefined;
  }
  const { mount, game } = await loadPage(info.game);

  // The content is what is on the host, not what happens to be in the code.
  game.applyRecords(await run<RecordSet>('records.all'));
  const page = mount(root);

  // The game's own commands and the inspector's, on the world in this page.
  addLocal(...game.commands(() => page.world), ...ecsCommands(() => page.world, game, () => {}));

  const app = createApp(layer, info, game, page, [chatPanel(), conceptsPanel(), contentPanel(), inspectPanel(), playtestPanel()]);

  // Everything up to now is history; what comes after is live.
  const since = Math.max(0, info.last - 400);
  follow(since, (ev) => app.feed(ev, ev.n > info.last || ev.n === 0), (up) => { document.body.classList.toggle('t-offline', !up); });

  // Share the world being played, so the agent can read it and look at it.
  const share = () => { run('world.push', { snapshot: page.world.snapshot() }).catch(() => {}); };
  share();
  (setInterval(share, 5000) as unknown as { unref?: () => void }).unref?.();
  document.addEventListener('visibilitychange', () => { if (document.hidden) share(); });

  (window as unknown as { tandem: unknown }).tandem = { app, run };
  return app;
}
