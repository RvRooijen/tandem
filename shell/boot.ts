// Starting the shell: ask the core which project this is, put its page in a
// frame, the tools on top, and from then on follow the event log.
import { follow, info as getInfo, run } from './api.ts';
import { createApp } from './app.ts';
import { h } from './dom.ts';
import { artPanel } from './panels/art.ts';
import { chatPanel } from './panels/chat.ts';
import { conceptsPanel } from './panels/concepts.ts';
import { createStage } from './stage.ts';

export async function boot() {
  const root = document.getElementById('root')!, layer = document.getElementById('tandem')!;
  let info;
  try {
    info = await getInfo();
  } catch {
    layer.append(h('div#t-down', {}, h('b', {}, 'The tandem core is not running.'), h('p', {}, 'Start tandem in the project\'s folder, then load this page again.')));
    return undefined;
  }
  document.title = `${info.name} · tandem`;

  // The world the project's page shares is passed on, so the agent can read it and look at it.
  const stage = createStage(root, info, {
    snapshot: (snapshot) => { if (info.senses) run('world.push', { snapshot }).catch(() => {}); },
    changed: () => app.stageChanged(),
  });
  const app = createApp(layer, info, stage, [chatPanel(), conceptsPanel(), artPanel()]);

  // Everything up to now is history; what comes after is live.
  const since = Math.max(0, info.last - 400);
  follow(since, (ev) => app.feed(ev, ev.n > info.last || ev.n === 0), (up) => { document.body.classList.toggle('t-offline', !up); });

  (window as unknown as { tandem: unknown }).tandem = { app, run };
  return app;
}
