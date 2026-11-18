// Settings: what the person sets for themselves. Opened with the button beside
// the tabs, not a tab itself. Sound is for this browser; the models are
// tandem's, for every project.
import type { App, Panel } from '../app.ts';
import * as capture from '../capture.ts';
import { clear, h } from '../dom.ts';
import { setSound, sound } from '../prefs.ts';
import { babble } from '../voice.ts';

type Who = 'agent' | 'workers';
interface Choice { model: string; effort: string }
interface Models { agent: Choice; workers: Choice; models: { id: string; name: string }[]; efforts: string[] }

export function settingsPanel(): Panel {
  let app!: App;

  function choose(got: Models, who: Who, label: string) {
    const set = (input: Partial<Choice>) => void app.act('models.set', { who, ...input });
    const model = h<'select'>('select', { 'aria-label': `${label} model`, onchange: () => set({ model: model.value }) },
      got.models.map((m) => h<'option'>('option', { value: m.id, selected: m.id === got[who].model }, m.name)));
    const effort = h<'select'>('select', { 'aria-label': `${label} effort`, onchange: () => set({ effort: effort.value }) },
      got.efforts.map((e) => h<'option'>('option', { value: e, selected: e === got[who].effort }, e)));
    return h('div.model', {}, h('span', {}, label), model, effort);
  }

  return {
    id: 'settings', title: 'Settings', tab: false,
    init(a: App) { app = a; },
    show(body) {
      const box = h<'input'>('input.switch', {
        type: 'checkbox', role: 'switch', 'aria-label': 'Sound', checked: sound(),
        // (Turned on, it says so: that is heard at once, and the browser lets the page make sound from then on.)
        onchange: () => { setSound(box.checked); if (box.checked) babble('Hello, this is how I sound.', 70); },
      });
      // (Turned on in the click itself: a browser only asks the person to share on one.)
      const shareBox = h<'input'>('input.switch', {
        type: 'checkbox', role: 'switch', 'aria-label': 'Real pictures', checked: capture.sharing(),
        onchange: () => { if (shareBox.checked) void capture.share().then((on) => { shareBox.checked = on; }); else capture.stop(); },
      });
      const unsubscribe = capture.onChange(() => { if (!shareBox.isConnected) return unsubscribe(); shareBox.checked = capture.sharing(); });
      const models = h('div.models', {});
      clear(body, [
        h('div.doc-head', {}, h('h3', {}, 'Settings')),
        h('label.keep', {}, box, h('span', {}, 'Sound')),
        h('p.hint', {}, 'The figure in the chat says what the agent says out loud, in its own babble.'),
        capture.extension()
          ? h('p.hint', {}, 'Real pictures: tandem\'s extension takes what the agent sees of the page and what you point at from the screen itself.')
          : capture.can() && [
            h('label.keep', {}, shareBox, h('span', {}, 'Real pictures')),
            h('p.hint', {}, 'Shares this tab, so what the agent sees of the page and what you point at is a picture of the screen itself. It is asked for too when you let the agent use the page, and the first time you point at something. Off, the page is drawn again from its styles, which is not always what you see. Tandem\'s Chrome extension (the extension folder in tandem, loaded unpacked) does it without sharing.'),
          ],
        models,
      ]);
      void app.act<Models>('models.get').then((got) => {
        if (!got) return;
        clear(models, [
          h('h4.models-head', {}, 'Models'),
          choose(got, 'agent', 'Agent'),
          choose(got, 'workers', 'Workers'),
          h('p.hint', {}, 'For every project; it counts from the next round.'),
        ]);
      });
    },
  };
}
