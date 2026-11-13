// The shell, started in jsdom against a real core: the game in the page, the
// tools over it, and a walk through every tab the way a thumb would. No pixels
// are checked, only that everything is there, pressed, and ends in a command.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { startServer } from '../core/server.ts';
import { AGENT, scratchHost } from './helpers.ts';

// A stylesheet is nothing to node.
registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const { host, cleanup } = await scratchHost();
const s = await startServer({ port: 0, host });
process.env.TANDEM_PORT = String(s.port);
const origin = `http://127.0.0.1:${s.port}`;
after(async () => { await s.close(); cleanup(); });

// ---------------------------------------------------------------- a browser, just enough of one

const html = readFileSync(new URL('../shell/index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost/?new' });
const w = dom.window as unknown as Window & typeof globalThis;
(w.HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => ({
  createImageData: (cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }),
  putImageData() {},
});
w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
(w.HTMLElement.prototype as unknown as { setPointerCapture: unknown }).setPointerCapture = () => {};
w.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 620, right: 360, bottom: 620, x: 0, y: 0, toJSON() {} });
Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get: () => 620 });
Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get: () => 360 });
class FakeImageData { data: Uint8ClampedArray; width: number; height: number; constructor(d: Uint8ClampedArray, cw: number, ch: number) { this.data = d; this.width = cw; this.height = ch; } }

const realFetch = globalThis.fetch;
class FakeEventSource {
  onopen?: () => void; onmessage?: (m: { data: string }) => void; onerror?: () => void;
  private stop = new AbortController();
  constructor(url: string) { void this.read(origin + url); }
  private async read(url: string) {
    try {
      const res = await realFetch(url, { signal: this.stop.signal });
      this.onopen?.();
      const reader = res.body!.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          for (const line of buf.slice(0, i).split('\n')) if (line.startsWith('data: ')) this.onmessage?.({ data: line.slice(6) });
          buf = buf.slice(i + 2);
        }
      }
    } catch { /* closed */ }
  }
  close() { this.stop.abort(); }
}

let asked = '7';
Object.assign(w, { innerHeight: 780, devicePixelRatio: 2 });
Object.assign(globalThis, {
  window: w, document: w.document, HTMLElement: w.HTMLElement, Node: w.Node, location: w.location, localStorage: w.localStorage,
  ImageData: FakeImageData, EventSource: FakeEventSource,
  requestAnimationFrame: (f: (t: number) => void) => { const t = setTimeout(() => f(performance.now()), 40); t.unref(); return 1; },
  confirm: () => true, prompt: () => asked,
  fetch: (url: string, init?: RequestInit) => realFetch(url.startsWith('/') ? origin + url : url, init),
});

const { boot } = await import('../shell/boot.ts');
const app = (await boot(() => import('../games/gnome-garden/page.ts')))!;

const $ = (sel: string, root: ParentNode = w.document) => root.querySelector(sel) as HTMLElement;
const all = (sel: string, root: ParentNode = w.document) => [...root.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const button = (text: string | RegExp, root: ParentNode = $('#t-sheet')) => {
  const b = all('button', root).find((x) => (typeof text === 'string' ? x.textContent === text : text.test(x.textContent ?? '')));
  assert.ok(b, `there is a button that says ${text}`);
  return b;
};
const tab = (name: string) => click(all('.t-tab').find((t) => t.textContent === name)!);
const type = (el: HTMLElement, value: string) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

async function until(what: () => unknown, says = 'it', ms = 8000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for ${says}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the game runs in the page and the tools lie over it, shut', async () => {
  assert.ok($('#garden'), 'the game drew its own page');
  assert.ok($('#drawer'), 'with its own drawer');
  assert.ok($('#t-fab'));
  assert.ok($('#t-sheet').classList.contains('shut'));
  assert.deepEqual(all('.t-tab').map((t) => t.textContent), ['Chat', 'Concepts', 'Content', 'Art', 'Inspect', 'Playtest']);
  const clock = (app.page.world.game as { s: { clock: number } }).s.clock;
  await until(() => (app.page.world.game as { s: { clock: number } }).s.clock > clock, 'the game to move');
  // The page shares its world with the host, where the agent can read it.
  await until(() => String((host.world().game as { s: { stats: { tapped: number } } }).s.stats.tapped) === '0', 'the mirror');
});

test('chat: a message goes out, the agent answers with a proposal, and it is played and accepted from its card', async () => {
  click($('#t-fab'));
  assert.ok(!$('#t-sheet').classList.contains('shut'));
  assert.ok($('.t-tab.on').textContent === 'Chat');
  assert.match($('.chat .empty').textContent!, /Nothing said yet/);

  type($('.composer textarea'), 'make the tulips worth a bit more');
  click(button('Send'));
  await until(() => $('.msg.me'), 'my message');
  assert.match($('.msg.me').textContent!, /make the tulips worth a bit more/);
  assert.equal(($('.composer textarea') as HTMLTextAreaElement).value, '');
  await until(() => $('.card.prop'), 'the proposal');
  await until(() => $('.msg.agent'), 'the answer');
  assert.match($('.msg.agent').textContent!, /I proposed it \(ok\)/);
  await until(() => /34k \/ 800k tokens/.test($('.usage').textContent!), 'the context counter');
  assert.equal(($('.usage .bar i') as HTMLElement).style.width, '4.3%');

  const card = $('.card.prop');
  assert.equal(card.dataset.status, 'pending');
  assert.match($('.change .path', card).textContent!, /record flowers\/tulip/);
  assert.equal($('.field .was', card).textContent, '6');
  assert.equal($('.field .now', card).textContent, '8');
  assert.match($('.note', card).textContent!, /a little more/);

  // Play it: the page lays the proposed content over the running game, and takes it off again.
  click(button('Play it', card));
  await until(() => app.playing, 'the proposal to be played');
  assert.equal(app.game.exportRecords()['flowers/tulip'].value, 8);
  assert.equal($('#t-banner').hidden, false);
  assert.ok($('#t-sheet').classList.contains('shut'), 'the sheet gets out of the way');
  click(button('Back to how it is', $('#t-banner')));
  await until(() => !app.playing, 'play to stop');
  assert.equal(app.game.exportRecords()['flowers/tulip'].value, 6);
  assert.equal($('#t-banner').hidden, true);

  click($('#t-fab'));
  click(button('Accept', card));
  await until(() => card.dataset.status === 'accepted', 'the card to say accepted');
  assert.equal(host.records.get('flowers/tulip')!.value, 8);
  assert.equal(all('button', card).length, 0, 'a decided proposal has no buttons');
  await until(() => !app.agent.busy, 'the agent to be done');
});

test('concepts: add one, work on it, and hand it to the agent', async () => {
  tab('Concepts');
  await until(() => $('#t-body .empty'), 'the empty list');
  type($('.adder input'), 'Night roses');
  click(button('Add'));
  await until(() => $('input.title'), 'the concept to open');
  assert.equal(($('input.title') as HTMLInputElement).value, 'Night roses');
  assert.ok($('.segments button.on').textContent === 'loose');

  click(all('.segments button').find((b) => b.textContent === 'worked')!);
  type($('textarea.words'), 'A rose that only opens after dark.');
  assert.ok(!all('#t-body h3').some((x) => /promise/i.test(x.textContent!)), 'a concept has no timings to fill in');
  type($('textarea[aria-label="What makes it real"]'), 'flowers/rose\nabilities/nap');
  click(button('Save'));
  await until(() => host.concepts.get('night-roses')?.firmness === 'worked', 'the concept to be saved');
  const c = host.concepts.get('night-roses')!;
  assert.equal(c.text, 'A rose that only opens after dark.');
  assert.deepEqual(c.realised, ['flowers/rose', 'abilities/nap']);

  click(button('Talk about this'));
  assert.equal($('.t-tab.on').textContent, 'Chat');
  assert.deepEqual(app.refs, ['concept:night-roses']);
  assert.match($('#t-foot .t-chip.ref').textContent!, /concept night-roses/);
  click($('#t-foot .t-chip.ref button'));
  assert.deepEqual(app.refs, []);

  // What the agent proposes about a concept shows up, and accepting it rewrites the concept.
  await host.run('concepts.update', { id: 'night-roses', text: 'A rose that only opens after dark, and closes if you look.' }, AGENT, 'r900');
  await until(() => all('.card.prop').length === 2, 'the second proposal');
  click(button('Accept', all('.card.prop')[1]));
  await until(() => host.concepts.get('night-roses')!.text.endsWith('if you look.'), 'the concept to change');

  tab('Concepts');
  await until(() => $('textarea.words') && ($('textarea.words') as HTMLTextAreaElement).value.endsWith('if you look.'), 'the open concept to follow');
  click(button('‹ Concepts'));
  await until(() => $('#t-body .item'), 'the list');
  assert.match($('#t-body .item').textContent!, /Night roses.*worked/);
});

test('content: a record is changed by hand, and the game in the page follows', async () => {
  tab('Content');
  await until(() => all('#t-body .item').length >= 6, 'the kinds');
  click(all('#t-body .item').find((i) => /^flowers/.test(i.textContent!))!);
  await until(() => all('#t-body .item').some((i) => /Tulips/.test(i.textContent!)), 'the flowers');
  click(all('#t-body .item').find((i) => /Tulips/.test(i.textContent!))!);
  await until(() => $('.field-edit'), 'the tulip');
  const value = all('.field-edit').find((f) => $('.k', f).textContent === 'value')!;
  assert.equal(($('input', value) as HTMLInputElement).value, '8');
  type($('input', value), '11');
  const cost = all('.field-edit').find((f) => $('.k', f).textContent === 'cost')!;
  type($('textarea', cost), '{"blooms": 150');
  assert.ok($('textarea', cost).classList.contains('bad'), 'half-typed JSON is marked');
  type($('textarea', cost), '{"blooms": 150}');
  click(button('Save'));
  await until(() => host.records.get('flowers/tulip')!.value === 11, 'the record to be saved');
  assert.deepEqual(host.records.get('flowers/tulip')!.cost, { blooms: 150 });
  assert.equal(app.game.exportRecords()['flowers/tulip'].value, 11);
  assert.equal(host.events.since(0).at(-1)!.type, 'record.changed');
  click(button('Talk about this'));
  assert.deepEqual(app.refs.splice(0), ['record:flowers/tulip']);
});

test('art: the drawings are listed, one is looked at, and it can be handed to the agent', async () => {
  tab('Art');
  await until(() => all('#t-body .item').length === 7, 'the drawings');
  assert.match(all('#t-body .item')[0].textContent!, /gnome.*32×32/);
  assert.ok(button('Bring drawings into the game') && button('Ask a worker'));
  click(all('#t-body .item')[0]);
  await until(() => $('.sheet img'), 'the sheet', 15000);
  assert.match(($('.sheet img') as HTMLImageElement).src, /\/api\/file\/looks\/look-/);
  assert.match($('.sheet .t-hint').textContent!, /stand · walk/);
  click(all('.chips .t-chip').find((c) => c.textContent === 'walk ×2')!);
  await until(() => /walk 1 · walk 2/.test($('.sheet .t-hint')?.textContent ?? ''), 'the walk', 15000);
  // Asking for a change needs words.
  click(button('Ask a worker'));
  assert.equal($('#t-toast').textContent, 'Say what should change.');
  click(button('Talk about this'));
  assert.deepEqual(app.refs.splice(0), ['drawing:gnome']);
});

test('inspect: the entities of the world being played, one of them live, and a finger that asks instead of plays', async () => {
  tab('Inspect');
  await until(() => all('#t-body h3').some((x) => /entities/.test(x.textContent!)), 'the summary');
  assert.match(all('#t-body h3')[0].textContent!, /^4 entities/);
  assert.deepEqual(all('.sys-row b').map((b) => b.textContent).slice(0, 3), ['1. grow', '2. ripe', '3. brain']);
  assert.match($('.sys-row .t-chip.mode').textContent!, /kernel/);

  click(all('#t-body .item').find((i) => /Flower/.test(i.textContent!))!);
  await until(() => /4 with/.test($('#t-body .bar b')?.textContent ?? ''), 'the flowers');
  click($('#t-body .item'));
  await until(() => $('.comp'), 'one flower');
  // The values on the screen follow the running game: set the flower back and watch it show.
  const growth = all('.kv').find((k) => $('.k', k).textContent === 'growth')!;
  const id = Number($('#t-body .bar b').textContent!.match(/#(\d+)/)![1]);
  await app.act('ecs.set', { id, component: 'Flower', field: 'growth', value: 0.25 });
  await until(() => Number($('.v', growth).textContent) >= 0.25 && Number($('.v', growth).textContent) < 0.6, 'the value on the screen to follow the game');

  // Touch a value to change it in the running game.
  const kind = all('.kv').find((k) => $('.k', k).textContent === 'kind')!;
  asked = '2';
  click(kind);
  await until(() => $('.v', kind).textContent === '2', 'the poke to land');

  click(button('Talk about this'));
  assert.match(app.refs.splice(0)[0], /^entity:\d+$/);
  tab('Inspect');
  await until(() => $('.comp'), 'the entity again');

  // Pick: the next finger on the garden asks what is there.
  click(button(/Pick in the game/));
  assert.ok(app.page.intercept, 'the stage hands its fingers over');
  const picked = (app.page.world.game as { s: { stats: { tapped: number } } }).s.stats.tapped;
  const down = new w.Event('pointerdown', { bubbles: true }) as Event & { clientX: number; clientY: number; pointerId: number };
  Object.assign(down, { clientX: 180, clientY: 300, pointerId: 1 });
  $('#garden').dispatchEvent(down);
  await until(() => !$('#t-ring').hidden, 'the ring');
  assert.equal((app.page.world.game as { s: { stats: { tapped: number } } }).s.stats.tapped, picked, 'and nothing was picked');
  tab('Chat');
  assert.equal(app.page.intercept, null, 'leaving the inspector gives the garden its fingers back');
});

test('playtest: the buttons are there, and a look at a minute comes back as a picture', async () => {
  tab('Playtest');
  assert.ok(button('Play it: eager') && button('Play it: casual') && button('Compare with proposals'));
  assert.match($('.results .empty').textContent!, /Nothing played yet/);
  type($('.look-at input'), '0');
  click(button('Look'));
  await until(() => $('.working'), 'it to say it is working');
  await until(() => !$('#t-zoom').hidden, 'the picture', 20000);
  assert.match(($('#t-zoom img') as HTMLImageElement).src, /\/api\/file\/looks\/look-/);
  click($('#t-zoom'));
  assert.equal($('#t-zoom').hidden, true);
  tab('Chat');
  assert.ok($('figure.card.look img'), 'and it is in the conversation too');
});

test('the agent shows things on the person\'s screen', async () => {
  app.close();
  await host.run('stage.point', { x: 72, y: 150, text: 'this bed' }, AGENT);
  await until(() => $('#t-ring span').textContent === 'this bed', 'the ring');
  assert.equal($('#t-ring').style.left, '180px', 'in the middle of a garden 144 wide on a canvas 360 wide');
  await host.run('stage.open', { tab: 'concepts', id: 'night-roses' }, AGENT);
  await until(() => $('input.title'), 'the concept to be opened');
  assert.ok(!$('#t-sheet').classList.contains('shut'));
  assert.equal(($('input.title') as HTMLInputElement).value, 'Night roses');
  // Something said while the person is elsewhere is news on the chat tab and on the button.
  assert.ok(!$('#t-fab').classList.contains('news'));
  await host.run('chat.send', { text: 'Have a look at this one.' }, AGENT);
  await until(() => $('#t-fab').classList.contains('news'), 'the news');
  assert.ok(all('.t-tab').find((t) => t.textContent === 'Chat')!.classList.contains('news'));
  tab('Chat');
  assert.ok(!$('#t-fab').classList.contains('news'), 'read is read');
  assert.match(all('.msg.agent').at(-1)!.textContent!, /Have a look at this one/);
});

test('a new conversation clears the chat and keeps what is still to be decided', async () => {
  tab('Chat');
  await host.run('records.set', { path: 'flowers/daisy', value: { value: 2 }, note: 'still open' }, AGENT, 'r950');
  await until(() => all('.card.prop').some((c) => c.dataset.status === 'pending'), 'a pending proposal');
  assert.ok(all('.msg').length >= 3 && all('.card.prop').length >= 3);
  click($('.composer .new-chat'));
  await until(() => all('.msg').length === 0, 'the chat to be cleared');
  assert.equal(all('.card.prop').length, 1, 'the pending proposal is still there');
  assert.equal(all('figure.card.look').length, 0);
  assert.equal(app.agent.session, false, 'and the agent has forgotten');
  assert.match($('.usage').textContent!, /nothing in context yet/);
  click(button('Reject', $('.card.prop')));
  await until(() => $('.card.prop').dataset.status === 'rejected', 'the rejection');
  type($('.composer textarea'), 'hello again');
  click(button('Send'));
  await until(() => $('.msg.agent'), 'an answer in the new conversation');
  assert.doesNotMatch($('.msg.agent').textContent!, /^Again: /);
  await until(() => !app.agent.busy, 'the agent to be done');
});

test('the game\'s stylesheet and the shell\'s do not style each other', () => {
  // Both are on one page. A class name they share makes the game's rules land on the engine's tools.
  const classes = (css: string) => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const game = classes(readFileSync(new URL('../games/gnome-garden/src/ui/style.css', import.meta.url), 'utf8'));
  const shell = classes(readFileSync(new URL('../shell/style.css', import.meta.url), 'utf8'));
  // These the game only styles inside its own parts (.meter .bar, .job .count, .tab .dot, .set.danger, .tab.on).
  const harmless = new Set(['bar', 'count', 'dot', 'danger', 'on']);
  assert.deepEqual([...shell].filter((c) => game.has(c) && !harmless.has(c)), []);
});

test('parity: everything the shell does is a command the agent could name', async () => {
  const known = new Set((await host.run('commands.list', {}, 'me') as { name: string }[]).map((c) => c.name));
  for (const c of s.runner!.commands) known.add(c.name);
  const used = new Set<string>();
  const dir = new URL('../shell/', import.meta.url);
  const files = [...readdirSync(dir), ...readdirSync(new URL('panels/', dir)).map((f) => `panels/${f}`)].filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\b(?:run|act)(?:<[^>(]*>)?\(\s*'([a-z]+\.[a-zA-Z]+)'/g)) used.add(m[1]);
    if (f !== 'api.ts') {
      assert.doesNotMatch(src, /\bfetch\(/, `${f} talks to the network only through api.ts`);
      assert.doesNotMatch(src, /XMLHttpRequest|WebSocket|EventSource/, `${f} talks to the network only through api.ts`);
    }
  }
  assert.ok(used.size >= 20, `the shell uses ${used.size} commands`);
  for (const name of used) assert.ok(known.has(name), `${name}, which the shell uses, is a command`);
});
