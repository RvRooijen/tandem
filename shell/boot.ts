// Starting the shell: ask the core which project this is, put its page in a
// frame, the tools on top, and from then on follow the event log.
import { coreUp, follow, info as getInfo, run, type Info } from './api.ts';
import { createApp } from './app.ts';
import { h } from './dom.ts';
import { artPanel } from './panels/art.ts';
import { chatPanel } from './panels/chat.ts';
import { conceptsPanel } from './panels/concepts.ts';
import { projectsPanel } from './panels/projects.ts';
import { createStage } from './stage.ts';

export async function boot() {
  const root = document.getElementById('root')!, layer = document.getElementById('tandem')!;
  let info: Info;
  try {
    info = await getInfo();
  } catch {
    // The core is starting (again), or tandem is not running at all. Either way: said, and gone on with once it answers.
    const spin = h('i.spin'), title = h('b'), text = h('p');
    const down = h('div#t-down', {}, spin, title, text);
    layer.append(down);
    info = await coreUp((doing, running) => {
      spin.hidden = !running;
      title.textContent = running ? 'Tandem is starting.' : 'The tandem core is not running.';
      text.textContent = running ? doing : 'Start tandem in the project\'s folder; this page goes on by itself once it is there.';
    });
    down.remove();
  }
  document.title = info.project ? `${info.name} · tandem` : 'tandem';

  // The world the project's page shares is passed on, so the agent can read it and look at it.
  const stage = createStage(root, info, {
    snapshot: (snapshot) => { if (info.senses) run('world.push', { snapshot }).catch(() => {}); },
    changed: () => app.stageChanged(),
  });
  // With no project open there is one thing to do: choose one.
  const app = createApp(layer, info, stage, info.project ? [chatPanel(), conceptsPanel(), artPanel(), projectsPanel()] : [projectsPanel()]);
  if (!info.project) { app.open('projects'); return app; }

  // Everything up to now is history; what comes after is live.
  const since = Math.max(0, info.last - 400);
  follow(since, (ev) => app.feed(ev, ev.n > info.last || ev.n === 0), (up) => { document.body.classList.toggle('t-offline', !up); });

  // Beside the page the tools are in nobody's way: they start open.
  if (app.beside()) app.open('chat');

  (window as unknown as { tandem: unknown }).tandem = { app, run };
  return app;
}
