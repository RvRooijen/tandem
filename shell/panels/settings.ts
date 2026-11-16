// Settings: what the person sets for themselves in this browser. Opened with
// the button beside the tabs, not a tab itself.
import type { App, Panel } from '../app.ts';
import { clear, h } from '../dom.ts';
import { setSound, sound } from '../prefs.ts';
import { babble } from '../voice.ts';

export function settingsPanel(): Panel {
  return {
    id: 'settings', title: 'Settings', tab: false,
    init(_app: App) {},
    show(body) {
      const box = h<'input'>('input.switch', {
        type: 'checkbox', role: 'switch', 'aria-label': 'Sound', checked: sound(),
        // (Turned on, it says so: that is heard at once, and the browser lets the page make sound from then on.)
        onchange: () => { setSound(box.checked); if (box.checked) babble('Hello, this is how I sound.', 70); },
      });
      clear(body, [
        h('div.doc-head', {}, h('h3', {}, 'Settings')),
        h('label.keep', {}, box, h('span', {}, 'Sound')),
        h('p.hint', {}, 'The figure in the chat says what the agent says out loud, in its own babble.'),
      ]);
    },
  };
}
