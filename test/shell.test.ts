// The shell, started in jsdom against a real core: a project's page in a frame,
// the tools over it, and a walk through every tab the way a thumb would. The
// project's page itself is not loaded here; what it would tell tandem through
// the bridge is said for it. No pixels are checked, only that everything is
// there, pressed, and ends in a command.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { startServer } from '../core/server.ts';
import { AGENT, fixture } from './helpers.ts';

// A stylesheet is nothing to node.
registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});

process.env.CLAUDE_BIN = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const { host, dir, cleanup } = await fixture({ code: false, page: true });
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
    } catch (e) {
      // A closed stream is how it ends; anything else is the page failing on an event, which must not pass silently.
      if (!(e instanceof Error && e.name === 'AbortError')) console.log('THE PAGE FAILED ON AN EVENT', e);
    }
  }
  close() { this.stop.abort(); }
}

let asked = '7';
let pagesUp = false;
Object.assign(w, { innerHeight: 780, devicePixelRatio: 2 });
Object.assign(globalThis, {
  window: w, document: w.document, HTMLElement: w.HTMLElement, Node: w.Node, location: w.location, localStorage: w.localStorage,
  ImageData: FakeImageData, EventSource: FakeEventSource, FileReader: w.FileReader,
  requestAnimationFrame: (f: (t: number) => void) => { const t = setTimeout(() => f(performance.now()), 40); t.unref(); return 1; },
  confirm: () => true, prompt: () => asked,
  // The project's own page and the working copy's are not really running here: whether they answer yet is the test's to say.
  fetch: (url: string, init?: RequestInit) => (/^http:\/\/localhost:521[01]\//.test(url) ? (pagesUp ? Promise.resolve(new Response('')) : Promise.reject(new Error('refused'))) : realFetch(url.startsWith('/') ? origin + url : url, init)),
});

const { boot } = await import('../shell/boot.ts');
const app = (await boot())!;

// The project's page, in its frame: what tandem says to it is caught here, and what it would say is said for it.
const frame = w.document.querySelector('#t-frame') as HTMLIFrameElement;
const toFrame: any[] = [];
frame.getBoundingClientRect = () => ({ left: 10, top: 20, width: 360, height: 620, right: 370, bottom: 640, x: 10, y: 20, toJSON() {} });
// (The frame gets a new window whenever it is pointed somewhere else, so the catching is put on it each time.)
const listen = () => { frame.contentWindow!.postMessage = ((m: unknown) => { toFrame.push(m); }) as never; };
listen();
const fromFrame = (data: Record<string, unknown>) => { listen(); w.dispatchEvent(new w.MessageEvent('message', { data: { tandem: 1, ...data }, source: frame.contentWindow })); };
/** Every command the page ran, by name: to see what it asks of the core. */
const ran: string[] = [];
const fetchNow = globalThis.fetch;
/** Answers given here instead of by the core, for what this fixture does not have (a working copy). */
const canned = new Map<string, unknown>();
globalThis.fetch = ((url: string, init?: RequestInit) => {
  const m = String(url).match(/\/api\/run\/([\w.]+)/);
  if (m) ran.push(m[1]);
  if (m && canned.has(m[1])) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: canned.get(m[1]) }), { headers: { 'content-type': 'application/json' } }));
  return fetchNow(url, init);
}) as typeof fetch;

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

// Patient: a phone under memory pressure can stall for seconds when a process starts.
async function until(what: () => unknown, says = 'it', ms = 30000) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for ${says}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the project\'s page is in a frame and the tools lie over it, shut', async () => {
  assert.equal(w.document.title, 'Fixture · tandem');
  // The project's page is started when tandem is and takes a moment: until it answers, the frame is not pointed
  // at it (it would show an error and stay that way), and the space says what is happening.
  assert.ok(frame.hidden);
  assert.equal(frame.src, '');
  assert.match($('#t-nopage').textContent!, /Starting Fixture…/);
  pagesUp = true;
  assert.ok($('#t-fab'));
  assert.ok($('#t-sheet').classList.contains('shut'));
  assert.deepEqual(all('.t-tab').map((t) => t.textContent), ['Chat', 'Concepts', 'Art']);
  await until(() => frame.src === 'http://localhost:5210/', 'the frame to show the project\'s own page');
  assert.ok(!frame.hidden && $('#t-nopage').hidden);
  assert.deepEqual(app.stage.can, { snapshot: false, point: false, find: false }, 'a page that says nothing is simply shown');
});

test('a page that uses the bridge tells tandem its world, and where things are', async () => {
  fromFrame({ type: 'hello', loaded: false, can: { snapshot: true, point: true } });
  assert.deepEqual(app.stage.can, { snapshot: true, point: true, find: false });
  // Its world is passed on to the core, for a project that can be seen inside (this one cannot: nothing is sent).
  fromFrame({ type: 'snapshot', snapshot: { blooms: 2 } });
  assert.ok(!ran.includes('world.push'));
  (app.info as { senses: boolean }).senses = true;
  fromFrame({ type: 'snapshot', snapshot: { blooms: 3 } });
  await until(() => ran.includes('world.push'), 'the world to be passed on');
  (app.info as { senses: boolean }).senses = false;
  // A message from anywhere else is not the page's.
  w.dispatchEvent(new w.MessageEvent('message', { data: { tandem: 1, type: 'hello', can: { snapshot: false, point: false } }, source: w }));
  assert.equal(app.stage.can.point, true);
});

test('chat: a message goes out, the agent answers with a proposal, and it is accepted from its card', async () => {
  click($('#t-fab'));
  assert.ok(!$('#t-sheet').classList.contains('shut'));
  assert.ok($('.t-tab.on').textContent === 'Chat');
  assert.match($('.chat .empty').textContent!, /Nothing said yet/);

  type($('.composer textarea'), 'make the tulips worth a bit more');
  // What is pressed says so at once, before the core has answered: the button works, and the agent is shown at work.
  const sendBtn = button('Send') as HTMLButtonElement;
  click(sendBtn);
  assert.ok(sendBtn.classList.contains('working') && sendBtn.disabled, 'the button says it was pressed');
  assert.deepEqual([app.agent.busy, app.agent.doing], [true, 'starting'], 'and the agent is at work, as far as the screen is concerned');
  assert.ok($('#t-fab').classList.contains('busy'));
  await until(() => $('.msg.me'), 'my message');
  await until(() => !sendBtn.classList.contains('working') && !sendBtn.disabled, 'the button to be itself again');
  assert.match($('.msg.me').textContent!, /make the tulips worth a bit more/);
  assert.equal(($('.composer textarea') as HTMLTextAreaElement).value, '');
  await until(() => $('.card.prop'), 'the proposal');
  await until(() => $('.msg.agent'), 'the answer');
  assert.match($('.msg.agent').textContent!, /I proposed it \(ok\)/);
  await until(() => /34k \/ 800k tokens/.test($('.usage').textContent!), 'the context counter');
  assert.equal(($('.usage .bar i') as HTMLElement).style.width, '4.3%');

  const card = $('.card.prop');
  assert.equal(card.dataset.status, 'pending');
  // A proposed concept is read like a concept: its name, where it stands, and what it says in full.
  assert.match($('.change .path', card).dataset.id!, /^tulips-r\d+$/);
  assert.match($('.change .path b', card).textContent!, /^Tulips r\d+$/);
  assert.equal($('.change .path .t-chip.stage', card).textContent, 'idea');
  assert.equal($('.change .ctext', card).textContent, 'Tulips are worth a bit more.', 'what it would say, all of it');
  assert.deepEqual(all('button', card).map((b) => b.textContent), ['Accept', 'Reject'], 'a proposal is decided; there is nothing else to press');

  click(button('Accept', card));
  await until(() => card.dataset.status === 'accepted', 'the card to say accepted');
  const id = $('.change .path', card).dataset.id!;
  assert.equal(host.concepts.get(id)!.text, 'Tulips are worth a bit more.');
  assert.equal(all('button', card).length, 0, 'a decided proposal has no buttons');
  await until(() => !app.agent.busy, 'the agent to be done');
  // (It is out of the way of the tests that follow.)
  await host.run('concepts.remove', { id }, 'me');
  await until(() => !app.agent.busy, 'the agent to be done');
});

test('chat: a round of several is one card, decided as one or piece by piece', async () => {
  for (const name of ['Poppies', 'Thistles', 'Clover']) await host.run('concepts.create', { name, text: `${name} grow.` }, AGENT, 'r950');
  await until(() => all('.card.prop').at(-1)?.querySelectorAll('.change').length === 3, 'the three in one card');
  const card = all('.card.prop').at(-1)!;
  assert.match($('.t-head', card).textContent!, /A proposal, 3 changes.*pending/);
  assert.deepEqual(all('button', card).map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ['Accept poppies', 'Reject poppies', 'Accept thistles', 'Reject thistles', 'Accept clover', 'Reject clover', 'Accept all', 'Reject all']);
  const piece = (path: string) => all('.change', card).find((c) => $('.path', c).dataset.id === path)!;

  // One is taken: it is real now, and the others still wait.
  click($('button[aria-label="Accept poppies"]', card));
  await until(() => piece('poppies').dataset.status === 'accepted', 'the piece to say accepted');
  assert.equal(host.concepts.get('poppies')!.text, 'Poppies grow.');
  assert.equal(host.concepts.get('thistles'), undefined);
  assert.equal(card.dataset.status, 'pending');
  assert.match($('.t-head .state', card).textContent!, /2 of 3 waiting/);
  assert.equal(all('button', piece('poppies')).length, 0, 'a decided piece has no buttons');

  // One is refused, and what is left is taken with the button for the rest.
  click($('button[aria-label="Reject thistles"]', card));
  await until(() => piece('thistles').dataset.status === 'rejected', 'the piece to say rejected');
  assert.deepEqual(all('.t-row button', card).map((b) => b.textContent), ['Accept the rest', 'Reject the rest']);
  click(button('Accept the rest', card));
  await until(() => card.dataset.status === 'decided', 'the card to be decided');
  assert.match($('.t-head .state', card).textContent!, /2 accepted · 1 rejected/);
  assert.equal(all('button', card).length, 0);
  assert.equal(host.concepts.get('clover')!.text, 'Clover grow.');
  assert.equal(host.concepts.get('thistles'), undefined, 'the refused one never came to be');
  for (const id of ['poppies', 'clover']) await host.run('concepts.remove', { id }, 'me');
});

test('chat: what the agent asks has a field for the answer, on the concept it is about or on a card of its own', async () => {
  await host.run('concepts.create', { name: 'Wells', text: 'A well by the gate.', questions: ['Is there water in it?', 'Who dug it?'] }, AGENT, 'r960');
  await until(() => all('.card.prop').some((c) => $('.path[data-id=wells]', c)), 'the proposal');
  const card = all('.card.prop').find((c) => $('.path[data-id=wells]', c))!;
  assert.deepEqual(all('.questions .qtext', card).map((q) => q.textContent), ['Is there water in it?', 'Who dug it?']);
  const fields = () => all('.questions textarea', card) as HTMLTextAreaElement[];
  assert.equal(fields().length, 2);
  type(fields()[0], 'Yes, cold and clear.');
  // What is being typed is kept when the card is drawn again (the agent adds to its proposal meanwhile).
  await host.run('concepts.update', { id: 'wells', stage: 'design' }, AGENT, 'r960');
  await until(() => $('.path .t-chip.stage', card)?.textContent === 'design', 'the card to follow');
  assert.equal(fields()[0].value, 'Yes, cold and clear.');
  const before = host.events.last();
  click(button('Send answers', card));
  await until(() => $('.questions.done', card), 'the answers to stand where the fields were');
  assert.deepEqual(all('.questions .qanswer', card).map((a) => a.textContent), ['Yes, cold and clear.', '(not answered)']);
  assert.equal(all('.questions textarea', card).length, 0);
  const sent = host.events.since(before).find((e) => e.type === 'message' && e.by === 'me')!;
  assert.match(String(sent.text), /about the concept Wells:\n- Is there water in it\?\n  Yes, cold and clear\.$/);
  await until(() => !app.agent.busy && host.events.since(before).some((e) => e.type === 'message' && e.by === 'agent'), 'the agent to have heard it');
  await until(() => !app.agent.busy, 'the agent to be done');
  click(button('Reject', card));
  await until(() => card.dataset.status === 'rejected', 'the round to be put away');
  assert.equal($('.questions', card), null, 'what was asked about a thing that was refused goes with it');

  // Questions that come on their own are a card of their own.
  await host.run('chat.ask', { questions: ['Which gate?'], about: 'drawing:gnome' }, AGENT, 'r961');
  await until(() => $('.card.ask'), 'the question');
  const ask = all('.card.ask').at(-1)!;
  assert.match(ask.textContent!, /A question for you.*drawing gnome.*Which gate\?/);
  type($('textarea', ask), 'The north one.');
  click(button('Send answer', ask));
  await until(() => /answered/.test($('.t-head', ask).textContent!) && $('.qanswer', ask)?.textContent === 'The north one.', 'it to say what was answered');
  await until(() => !app.agent.busy, 'the agent to be done');
  await new Promise((r) => setTimeout(r, 200));
  await until(() => !app.agent.busy, 'the agent to be done');
  for (const round of new Set((await host.run('proposals.list', { status: 'pending' }, 'me') as { round: string }[]).map((p) => p.round))) await host.run('proposals.decide', { round, accept: false }, 'me');
});

test('chat: @ points at a concept or a drawing, and a photo or a file goes along with a message', async () => {
  await until(() => !app.agent.busy, 'the agent to be done');
  await host.run('concepts.create', { name: 'Garden gate' }, 'me');
  tab('Chat');
  const box = $('.composer textarea') as HTMLTextAreaElement;
  const write = (text: string) => { box.value = text; box.setSelectionRange(text.length, text.length); box.dispatchEvent(new w.Event('input', { bubbles: true })); };

  // Typing @ offers what there is, by name; picking one writes it into the message and hangs it on it.
  write('the hat of @gn');
  await until(() => all('.offer button').length > 0, 'the offer');
  assert.deepEqual(all('.offer button').map((b) => b.textContent), ['drawing gnome']);
  write('about the @ga');
  await until(() => all('.offer button').length === 7, 'more of them: the concept and the six garden drawings');
  assert.equal(all('.offer button')[0].textContent, 'concept Garden gate', 'concepts and drawings both');
  click(all('.offer button')[0]);
  assert.equal(box.value, 'about the @garden-gate ');
  assert.ok($('.offer').hidden);
  assert.deepEqual(app.refs, ['concept:garden-gate']);
  write('about the @garden-gate and nothing like @zzz');
  await until(() => /No concept or drawing by that name/.test($('.offer').textContent!), 'nothing by that name');

  // A photo, picked with the paperclip: it is kept by the core, shown as it will go, and can be taken off.
  const pick = (name: string, type: string, bytes: number[]) => {
    Object.defineProperty($('input[type=file]'), 'files', { value: [new w.File([new Uint8Array(bytes)], name, { type })], configurable: true });
    $('input[type=file]').dispatchEvent(new w.Event('change'));
  };
  pick('gate.png', 'image/png', [137, 80, 78, 71]);
  await until(() => all('#t-foot .shared .file').length === 1, 'the photo');
  assert.match(($('#t-foot .shared .file.image img') as HTMLImageElement).src, /\/api\/file\/files\/[a-z0-9]+-gate\.png$/);
  pick('junk.bin', 'application/octet-stream', [1, 2, 3]);
  await until(() => all('#t-foot .shared .file').length === 2, 'a file too');
  click($('#t-foot .shared .file:not(.image) button'));
  assert.equal(all('#t-foot .shared .file').length, 1);

  // Sent: what it is about and what was shared go with it, a name typed by hand counts too, and the agent is told.
  write('make the @garden-gate like this, next to the @gnome');
  const before = host.events.last();
  click(button('Send'));
  await until(() => host.events.since(before).some((e) => e.type === 'message' && e.by === 'me'), 'the message');
  const sent = host.events.since(before).find((e) => e.by === 'me')!;
  assert.deepEqual(sent.refs, ['concept:garden-gate', 'drawing:gnome']);
  assert.deepEqual((sent.files as { label: string; image: boolean }[]).map((f) => [f.label, f.image]), [['gate.png', true]]);
  assert.equal(all('#t-foot .shared .file').length, 0, 'and the composer is empty again');
  await until(() => all('.msg.me').at(-1)!.querySelector('.shared .file.image img'), 'the photo in the conversation');
  await until(() => /Shared: gate\.png is a picture, there: true\./.test(all('.msg.agent').at(-1)?.textContent ?? ''), 'the agent to have been given the photo');
  await until(() => !app.agent.busy, 'the agent to be done');
  // A photo can go without words.
  pick('door.jpg', 'image/jpeg', [255, 216, 255]);
  await until(() => all('#t-foot .shared .file').length === 1, 'another photo');
  click(button('Send'));
  await until(() => /Have a look at this\./.test(all('.msg.me').at(-1)!.textContent!), 'it to be sent with a line of its own');
  await until(() => !app.agent.busy && /Shared: door\.jpg/.test(all('.msg.agent').at(-1)?.textContent ?? ''), 'the agent to be done');
  for (const round of new Set((await host.run('proposals.list', { status: 'pending' }, 'me') as { round: string }[]).map((p) => p.round))) await host.run('proposals.decide', { round, accept: false }, 'me');
  await host.run('concepts.remove', { id: 'garden-gate' }, 'me');
});

test('concepts: add one, work on it, and hand it to the agent', async () => {
  tab('Concepts');
  await until(() => $('#t-body .empty'), 'the empty list');
  // A project that exists already: the agent can be asked to read it and write its ideas down.
  click(button('Let the agent read the project'));
  await until(() => ran.includes('project.init'), 'the agent to be asked');
  await until(() => $('.t-tab.on').textContent === 'Chat' && all('.sys.engine').some((x) => /asked to read this project/.test(x.textContent!)), 'the chat to say so');
  await until(() => !app.agent.busy && all('.msg.agent').length >= 2, 'the agent to have answered');
  tab('Concepts');
  await until(() => $('#t-body .empty'), 'the empty list again');
  type($('.adder input'), 'Night roses');
  click(button('Add'));
  await until(() => $('input.title'), 'the concept to open');
  assert.equal(($('input.title') as HTMLInputElement).value, 'Night roses');
  assert.ok($('.segments button.on').textContent === 'idea');
  assert.deepEqual(all('.segments button').map((b) => b.textContent), ['idea', 'design', 'build', 'playtest']);

  // What is changed is the person's to keep or to throw away: the two buttons come when something is different.
  assert.ok($('#t-foot .unsaved').hidden, 'nothing changed, nothing to save');
  type($('textarea.words'), 'A thought I do not want after all.');
  assert.equal($('#t-foot .unsaved').hidden, false);
  assert.deepEqual(all('#t-foot .unsaved button').map((b) => b.textContent), ['Discard', 'Save']);
  click(button('Discard'));
  await until(() => $('textarea.words') && ($('textarea.words') as HTMLTextAreaElement).value === '' && $('#t-foot .unsaved').hidden, 'the concept as it was');
  assert.equal(host.concepts.get('night-roses')!.text, '', 'nothing of it was kept');

  click(all('.segments button').find((b) => b.textContent === 'design')!);
  type($('textarea.words'), 'A rose that only opens after dark.');
  assert.ok(!all('#t-body h3').some((x) => /promise/i.test(x.textContent!)), 'a concept has no timings to fill in');
  type($('textarea[aria-label="What makes it real"]'), 'a new flower\nthe nap');
  click(button('Save'));
  await until(() => host.concepts.get('night-roses')?.stage === 'design', 'the concept to be saved');
  await until(() => $('#t-foot .unsaved').hidden, 'the buttons to go when it is saved');
  const c = host.concepts.get('night-roses')!;
  assert.equal(c.text, 'A rose that only opens after dark.');
  assert.deepEqual(c.realised, ['a new flower', 'the nap']);

  click(button('Talk about this'));
  assert.equal($('.t-tab.on').textContent, 'Chat');
  assert.deepEqual(app.refs, ['concept:night-roses']);
  assert.match($('#t-foot .t-chip.ref').textContent!, /concept night-roses/);
  click($('#t-foot .t-chip.ref button'));
  assert.deepEqual(app.refs, []);

  // What the agent proposes about a concept shows up, and accepting it rewrites the concept.
  await host.run('concepts.update', { id: 'night-roses', text: 'A rose that only opens after dark, and closes if you look.' }, AGENT, 'r900');
  const about = () => all('.card.prop').find((c) => $('.path[data-id=night-roses]', c) && c.dataset.status === 'pending');
  await until(about, 'the proposal about it');
  // A change to a concept that is there: what it would say in full, and what it says now one tap away.
  assert.equal($('.path b', about()!).textContent, 'Night roses');
  assert.equal($('.ctext', about()!).textContent, 'A rose that only opens after dark, and closes if you look.');
  assert.match($('details.cwas', about()!).textContent!, /What it says now.*A rose that only opens after dark\.$/);
  click(button('Accept', about()!));
  await until(() => host.concepts.get('night-roses')!.text.endsWith('if you look.'), 'the concept to change');

  tab('Concepts');
  await until(() => $('textarea.words') && ($('textarea.words') as HTMLTextAreaElement).value.endsWith('if you look.'), 'the open concept to follow');
  click(button('‹ Concepts'));
  await until(() => $('#t-body .item'), 'the list');
  assert.match($('#t-body .item').textContent!, /Night roses.*design/);

  // A lock: from then on the agent is refused, whatever it is asked.
  click($('#t-body .item'));
  await until(() => $('button.lock'), 'the concept, with its lock');
  assert.equal($('button.lock').getAttribute('aria-pressed'), 'false');
  click($('button.lock'));
  await until(() => host.locks.has('concept:night-roses'), 'the lock');
  assert.equal($('button.lock').getAttribute('aria-pressed'), 'true');
  assert.match($('#t-toast').textContent!, /even if you ask it to/);
  await assert.rejects(host.run('concepts.update', { id: 'night-roses', text: 'x' }, AGENT, 'r901'), /locked/);
  click(button('‹ Concepts'));
  await until(() => $('#t-body .item'), 'the list');
  assert.match($('#t-body .item b').textContent!, /^🔒 Night roses/);
  click($('#t-body .item'));
  await until(() => $('button.lock'), 'the concept again');
  click($('button.lock'));
  await until(() => !host.locks.has('concept:night-roses'), 'the lock to come off');
});

test('art: the drawings are listed, one is looked at and locked, and a worker\'s drawing comes back as a card with pictures', async () => {
  tab('Art');
  await until(() => all('#t-body .item.drawing').length === 7, 'the drawings');
  assert.match(all('#t-body .item.drawing').at(-1)!.textContent!, /gnome.*32×32.*2 animations · 3 looks · depth map/);
  await until(() => /No worker is drawing/.test($('.workers').textContent!), 'the workers, none');
  click(all('#t-body .item.drawing').at(-1)!);
  await until(() => $('.sheet img'), 'the picture', 90000);
  assert.match(($('.sheet img') as HTMLImageElement).src, /\/api\/file\/looks\/look-/);
  assert.deepEqual(all('.chips .t-chip').map((c) => c.textContent), ['all', 'stand', 'walk ×2', 'depth map', 'cozy', 'odd', 'hollow']);
  const first = ($('.sheet img') as HTMLImageElement).src;
  click(all('.chips .t-chip').find((c) => c.textContent === 'walk ×2')!);
  await until(() => $('.sheet img') && ($('.sheet img') as HTMLImageElement).src !== first, 'the walk', 90000);

  // Drawing work is asked for in the chat, not here: this tab is for looking. When a worker draws (here it was
  // asked for the way the agent would), it is watched here: the drawing as it is typed, then its round with a
  // picture before and after, to decide right there.
  assert.ok(!all('#t-body button').some((b) => /worker/i.test(b.textContent!)) && !$('#t-body textarea'), 'no form to ask for art');
  await host.run('art.ask', { name: 'gnome', message: 'a taller hat' }, AGENT);
  click(button('‹ Art'));
  await until(() => $('.workers .item'), 'the worker, in the list');
  assert.match($('.workers .item').textContent!, /gnome/);
  click($('.workers .item'));
  await until(() => $('canvas.live'), 'the worker, watched');
  assert.equal($('#t-body .bar b').textContent, 'gnome');
  // Every look of it: three looks, each two rows (stand, walk), the widest two frames of 32 across, a pixel between.
  await until(() => ($('canvas.live') as HTMLCanvasElement).width === 67 && ($('canvas.live') as HTMLCanvasElement).height === 199, 'the drawing, live', 90000);
  assert.equal($('.t-hint.looks').textContent, 'Every look, top to bottom: cozy · odd · hollow');
  await until(() => all('.worker-rest button').some((b) => b.textContent === 'Accept'), 'its round', 60000);
  assert.deepEqual(all('.worker-rest button').map((b) => b.textContent), ['Send feedback', 'Accept', 'Reject']);
  assert.deepEqual(all('.pictures figcaption').map((f) => f.textContent), ['cozy, as it is', 'cozy, as proposed', 'odd, as it is', 'odd, as proposed', 'hollow, as it is', 'hollow, as proposed']);
  assert.match($('.worker-rest .said').textContent!, /Changed gnome\. Render ok/);
  assert.match($('.worker-rest').textContent!, /Asked.*a taller hat/);
  assert.equal($('#t-body .bar .t-chip').textContent, 'to accept');

  // Feedback sends it round again, from the same place.
  type($('textarea[aria-label="Feedback for the worker"]'), 'taller still');
  click(button('Send feedback'));
  await until(() => host.events.since(0).filter((e) => e.type === 'art.round').length === 2, 'the second round', 60000);
  await until(() => all('.worker-rest button').some((b) => b.textContent === 'Accept'), 'its buttons again', 90000);
  assert.match($('.worker-rest').textContent!, /taller still/);
  click(button('Reject'));
  await until(() => /Rejected: the game was left as it is/.test($('.worker-rest').textContent!), 'the rejection');
  assert.deepEqual(all('.worker-rest button').map((b) => b.textContent), [], 'a decided round has nothing left to press');
  assert.deepEqual(await host.run('art.workers', {}, 'me'), []);

  // The conversation is not a feed of drawing work: no card, only a line that leads back to the Art tab.
  tab('Chat');
  assert.ok(!all('.card.prop').some((c) => /drawing gnome/.test(c.textContent!)));
  assert.equal(all('figure.card.look').length, 0, 'and looking at a drawing put nothing in the chat');
  const lines = all('.chat .sys').map((x) => x.textContent!).filter((t) => t.startsWith('🖌'));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /the agent asked a worker to change gnome: a taller hat/);
  assert.match(lines[1], /gnome: a drawing to accept\. Look in Art/);
  click(all('.chat .sys').find((x) => x.textContent!.startsWith('🖌'))!);
  await until(() => $('canvas.live'), 'the line to lead to the worker');
  assert.match($('.worker-rest').textContent!, /Rejected/);
  click(button('‹ Art'));
  await until(() => all('#t-body .item.drawing').length === 7, 'the drawings again');
  await until(() => /No worker is drawing/.test($('.workers').textContent!), 'the workers, none');
  click(all('#t-body .item.drawing').at(-1)!);

  // A lock on a drawing: no worker gets it.
  await until(() => $('button.lock'), 'the drawing, with its lock');
  click($('button.lock'));
  await until(() => host.locks.has('drawing:gnome'), 'the lock');
  await assert.rejects(host.run('art.ask', { name: 'gnome', message: 'a taller hat' }, AGENT), /locked/);
  await until(() => $('button.lock').getAttribute('aria-pressed') === 'true', 'the button to show it is locked');
  click($('button.lock'));
  await until(() => !host.locks.has('drawing:gnome'), 'the lock to come off');
  click(button('Talk about this'));
  assert.deepEqual(app.refs.splice(0), ['drawing:gnome']);
});

test('the agent shows things on the person\'s screen', async () => {
  app.close();
  // Pointing: tandem asks the page where that is, and puts the ring there, on its own screen.
  toFrame.length = 0;
  await host.run('stage.point', { x: 72, y: 150, text: 'this bed' }, AGENT);
  await until(() => toFrame.some((m) => m.type === 'where'), 'the page to be asked where that is');
  const asking = toFrame.find((m) => m.type === 'where');
  assert.deepEqual([asking.x, asking.y], [72, 150]);
  fromFrame({ type: 'screen', id: asking.id, x: 180, y: 300 });
  await until(() => $('#t-ring span').textContent === 'this bed', 'the ring');
  assert.deepEqual([$('#t-ring').style.left, $('#t-ring').style.top], ['190px', '320px'], 'where the page said, moved by where the frame is');
  // A page that does not say where things are: the words still arrive.
  fromFrame({ type: 'hello', loaded: false, can: { snapshot: false, point: false } });
  await host.run('stage.point', { x: 1, y: 1, text: 'over here' }, AGENT);
  await until(() => /The agent points at something: over here/.test($('#t-toast').textContent!), 'the words');
  // Something on an ordinary page is pointed at by the words on it: tandem's own lines in the page find it, and
  // the ring goes around it.
  await assert.rejects(host.run('stage.point', { text: 'nothing to point at' }, AGENT), /what to point at/);
  fromFrame({ type: 'page', can: { find: true } });
  toFrame.length = 0;
  await host.run('stage.point', { at: 'Make a group', text: 'start here' }, AGENT);
  await until(() => toFrame.some((m) => m.type === 'find'), 'the page to be asked for it');
  const finding = toFrame.find((m) => m.type === 'find');
  assert.equal(finding.at, 'Make a group');
  fromFrame({ type: 'found', id: finding.id, x: 40, y: 500, w: 200, h: 44 });
  await until(() => $('#t-ring').classList.contains('box') && $('#t-ring span').textContent === 'start here', 'the ring around it');
  assert.deepEqual([$('#t-ring').style.left, $('#t-ring').style.top], ['150px', '542px'], 'its middle, moved by where the frame is');
  assert.deepEqual([$('#t-ring i').style.width, $('#t-ring i').style.height], ['214px', '58px'], 'as large as the thing, and a little more');
  // What is not on the page now is said, not shown somewhere.
  toFrame.length = 0;
  await host.run('stage.point', { at: 'Draw the names' }, AGENT);
  await until(() => toFrame.some((m) => m.type === 'find'), 'the page to be asked again');
  fromFrame({ type: 'found', id: toFrame.find((m) => m.type === 'find').id, missing: true });
  await until(() => /points at "Draw the names", but that is not on the page now/.test($('#t-toast').textContent!), 'it to be said');
  // With the tools open they cover the page: the pointing waits until they are shut.
  app.open('chat');
  toFrame.length = 0;
  await host.run('stage.point', { at: 'Make a group' }, AGENT);
  await until(() => /Shut the tools to see it/.test($('#t-toast').textContent!), 'it to wait');
  assert.equal(toFrame.length, 0);
  app.close();
  await until(() => toFrame.some((m) => m.type === 'find'), 'the page to be asked once it is in view');

  // And the person points: the round button is dragged onto something on the page. What is under it is marked
  // while it is dragged; let go, that thing goes with the next message, and the button is where it was.
  const fab = $('#t-fab');
  const pointer = (type: string, x: number, y: number) => { const ev = new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }); Object.defineProperty(ev, 'pointerId', { value: 1 }); fab.dispatchEvent(ev); };
  const answer = async (what: Record<string, unknown>) => {
    await until(() => toFrame.some((m) => m.type === 'pick'), 'the page to be asked what is there');
    const asked = toFrame.filter((m) => m.type === 'pick');
    toFrame.length = 0;
    for (const m of asked) fromFrame({ type: 'picked', id: m.id, ...what });
    return asked.at(-1);
  };
  toFrame.length = 0;
  app.refs.length = 0;
  pointer('pointerdown', 340, 60);
  pointer('pointermove', 343, 62);
  assert.equal(fab.classList.contains('drag'), false, 'a finger that hardly moved is a tap');
  pointer('pointermove', 200, 400);
  assert.ok(fab.classList.contains('drag'));
  assert.equal(fab.style.transform, 'translate(-140px, 340px)', 'it follows the finger');
  const there = { x: 40, y: 380, w: 200, h: 44, words: 'Make a group', tag: 'button', selector: 'main > button.go', path: '/' };
  assert.deepEqual([(await answer(there)).x, (await Promise.resolve(190))], [190, 190], 'asked in the page\'s own measure: where the finger is, less where the frame is');
  await until(() => !$('#t-ring').hidden && $('#t-ring span').textContent === '"Make a group"', 'the thing to be marked');
  pointer('pointerup', 200, 400);
  assert.equal(fab.classList.contains('drag'), false);
  assert.equal(fab.style.transform, '', 'the button is back where it was');
  await answer(there);
  await until(() => app.refs.length === 1, 'the thing to go with the next message');
  assert.deepEqual(JSON.parse(app.refs[0].slice('page:'.length)), { words: 'Make a group', tag: 'button', selector: 'main > button.go', path: '/' });
  assert.ok(!$('#t-sheet').classList.contains('shut'), 'the chat is opened on it');
  assert.match($('.t-chip.ref[data-kind=page]').textContent!, /on the page: "Make a group"/);
  assert.ok($('#t-ring').hidden);
  // The click that follows a drag does not shut the tools again; and a tap is still a tap.
  click(fab);
  assert.ok(!$('#t-sheet').classList.contains('shut'));
  app.refs.length = 0;
  app.close();
  // A picture says nothing itself: it is named by what is written around it, and that goes with the message.
  const picture = { x: 40, y: 380, w: 90, h: 90, words: '', near: 'Skin Haunted Manor', tag: 'canvas', selector: 'button.pane > canvas', path: '/' };
  toFrame.length = 0;
  pointer('pointerdown', 340, 60);
  pointer('pointermove', 200, 400);
  await answer(picture);
  await until(() => !$('#t-ring').hidden && $('#t-ring span').textContent === 'canvas by "Skin Haunted Manor"', 'the picture to be marked by the name beside it');
  pointer('pointerup', 200, 400);
  await answer(picture);
  await until(() => app.refs.length === 1, 'the picture to go with the next message');
  assert.deepEqual(JSON.parse(app.refs[0].slice('page:'.length)), { words: '', near: 'Skin Haunted Manor', tag: 'canvas', selector: 'button.pane > canvas', path: '/' });
  assert.match($('.t-chip.ref[data-kind=page]').textContent!, /on the page: canvas by "Skin Haunted Manor"/);
  app.refs.length = 0;
  app.close();
  // A thing in a scene three.js draws is pointed at the same way: what the page says of it goes with the message,
  // and so does a picture of it, kept by the core like a photo the person shares.
  const die = { x: 180, y: 300, w: 60, h: 60, words: 'Mesh, IcosahedronGeometry 0.8, 2 of 5', tag: 'canvas', selector: '#app > canvas', path: '/',
    three: { uuid: 'abc', type: 'Mesh', geometry: { type: 'IcosahedronGeometry', made: { radius: 0.8, detail: 0 }, points: 60 }, material: { type: 'ShaderMaterial' }, position: [1, 0.8, -2], size: [1.5, 1.5, 1.5], point: [1.1, 1.2, -1.8], index: 2, of: 5, graph: 'Scene > Mesh' } };
  toFrame.length = 0;
  ran.length = 0;
  pointer('pointerdown', 340, 60);
  pointer('pointermove', 200, 400);
  await answer(die);
  await until(() => !$('#t-ring').hidden && $('#t-ring span').textContent === '"Mesh, IcosahedronGeometry 0.8, 2 of…"', 'the thing in the scene to be marked');
  pointer('pointerup', 200, 400);
  assert.equal((await answer({ ...die, image: 'data:image/jpeg;base64,/9j/AAAA' })).image, true, 'let go on it, a picture of it is asked for');
  await until(() => app.refs.length === 1 && app.pictures.size === 1, 'the thing and its picture to go with the next message');
  assert.deepEqual(JSON.parse(app.refs[0].slice('page:'.length)).three, die.three);
  assert.ok(ran.includes('chat.attach'));
  assert.match($('.t-chip.ref[data-kind=page]').textContent!, /in the scene: Mesh, IcosahedronGeometry 0.8, 2 of 5/);
  assert.match(($('.t-chip.ref[data-kind=page] img') as HTMLImageElement).src, /\/api\/file\/files\/.*pointed%20at%20Mesh%20IcosahedronGeometry/);
  type($('#t-foot textarea'), 'Make this one glow.');
  click(button('Send'));
  await until(() => host.events.since(0).some((e) => e.type === 'message' && e.text === 'Make this one glow.'), 'the message');
  const glow = host.events.since(0).find((e) => e.type === 'message' && e.text === 'Make this one glow.')!;
  assert.equal((glow.refs as string[]).length, 1);
  assert.match((glow.files as { label: string; image: boolean }[])[0].label, /^pointed at Mesh IcosahedronGeometry/);
  assert.equal((glow.files as { image: boolean }[])[0].image, true);
  assert.equal(app.pictures.size, 0);
  app.close();

  // The agent uses the page as a person would: asked of this screen, done in the frame, and answered to it.
  const doing = async (what: string, says: Record<string, unknown>) => {
    await until(() => toFrame.some((m) => m.type === 'do' && m.do === what), `the page to be asked to ${what}`, 20000);
    const m = toFrame.find((x) => x.type === 'do' && x.do === what);
    toFrame.splice(toFrame.indexOf(m), 1);
    fromFrame({ type: 'did', id: m.id, ...says });
    return m;
  };
  const onPage = { ok: true, path: '/', title: 'Lots', lines: ['# Lots to draw', '[button] Make a group'] };
  toFrame.length = 0;
  const looking = host.run('page.look', {}, AGENT) as Promise<any>;
  await doing('look', onPage);
  assert.deepEqual(await looking, { showing: 'project', path: '/', title: 'Lots', page: '# Lots to draw\n[button] Make a group' });
  // A tap: the thing is marked on the person's screen, and the agent is told what the page is like afterwards.
  const tapping = host.run('page.tap', { at: 'Make a group' }, AGENT) as Promise<any>;
  const tap = await doing('tap', { ok: true, did: 'tapped button "Make a group"', x: 40, y: 500, w: 200, h: 44 });
  assert.equal(tap.at, 'Make a group');
  await until(() => $('#t-ring span').textContent === 'the agent taps this', 'the mark on what it taps');
  await doing('look', { ...onPage, path: '/group/abc', lines: ['# Gran and all'] });
  assert.deepEqual(await tapping, { did: 'tapped button "Make a group"', showing: 'project', path: '/group/abc', title: 'Lots', page: '# Gran and all' });
  const did = host.events.since(0).filter((e) => e.type === 'page.did').at(-1)!;
  assert.deepEqual([did.what, did.at, did.did, did.by], ['tap', 'Make a group', 'tapped button "Make a group"', AGENT]);
  tab('Chat');
  await until(() => all('.chat .sys').some((x) => /the agent tapped button "Make a group"/.test(x.textContent!)), 'what it did, in the conversation');
  // What it does one thing after another is one group, which opens to show them all; something said ends the group.
  const before = all('.chat .acts').length;
  for (const did of ['read src/main.js', 'searched for "shadow"', 'ran `npm test`']) host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did });
  await until(() => /the agent did 4 things · ran `npm test`/.test(all('.chat .acts').at(-1)?.textContent ?? ''), 'the group, with the tap before it');
  assert.equal(all('.chat .acts').length, before, 'they joined what it did just before');
  assert.deepEqual(all('.sys', all('.chat .acts').at(-1)!).map((x) => x.textContent), ['tapped button "Make a group"', 'read src/main.js', 'searched for "shadow"', 'ran `npm test`']);
  host.events.add({ type: 'message', by: 'agent', text: 'The tests pass.', round: 'r9' });
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'changed src/main.js' });
  await until(() => all('.chat .acts').length === before + 1, 'a new one after it spoke');
  assert.equal(all('.chat .acts').at(-1)!.textContent, '◎ the agent changed src/main.js');
  app.close();

  // The agent asks for the page, to try what it made itself: the person is asked over the page, and says yes.
  const taking = host.run('page.take', { why: 'to see the dice roll' }, AGENT) as Promise<any>;
  await until(() => !$('#t-take').hidden, 'the asking, over the page');
  assert.match($('#t-take').textContent!, /to see the dice roll/);
  assert.equal($('#t-held').hidden, true);
  click(button('Let it', $('#t-take')));
  assert.deepEqual(await taking, { taken: true });
  await until(() => !$('#t-held').hidden && $('#t-take').hidden && document.body.classList.contains('t-held'), 'the mark that the agent has the page');
  // From then on a picture of the page goes along with what it does there, kept where it can read it.
  toFrame.length = 0;
  const seeing = host.run('page.look', {}, AGENT) as Promise<any>;
  await doing('look', onPage);
  await doing('picture', { ok: true, image: 'data:image/jpeg;base64,/9j/AAAA', size: [360, 620] });
  const saw = await seeing;
  assert.match(saw.picture, /page-[\w-]+\.jpg$/);
  assert.ok(existsSync(saw.picture) && saw.picture.startsWith(host.dirs.looks));
  assert.deepEqual([saw.size, saw.page], [[360, 620], '# Lots to draw\n[button] Make a group']);
  // A place in that picture is tapped; a browser that hands no picture back leaves it the lines.
  const placing = host.run('page.tap', { x: 100, y: 200 }, AGENT) as Promise<any>;
  const place = await doing('tap', { ok: true, did: 'tapped at 100, 200, on a canvas', x: 84, y: 184, w: 32, h: 32 });
  assert.deepEqual([place.x, place.y, place.at], [100, 200, undefined]);
  await doing('look', onPage);
  await doing('picture', { ok: false, error: 'this browser does not hand a picture of the page back' });
  assert.match((await placing).picture, /^none/);
  assert.equal(host.events.since(0).filter((e) => e.type === 'page.did').at(-1)!.at, '100, 200');
  await assert.rejects(host.run('page.tap', {}, AGENT) as Promise<any>, /needs at/);
  // The person takes it back: the agent leaves the page alone for the rest of its turn.
  click(button('Take it back', $('#t-held')));
  await until(() => $('#t-held').hidden && !document.body.classList.contains('t-held'), 'the mark to go');
  await assert.rejects(host.run('page.look', {}, AGENT) as Promise<any>, /took the page back/);
  host.turnOver();
  // Not now: the agent is told, and nothing is marked. And it is the person's to answer, not the agent's.
  const refusing = host.run('page.take', { why: 'to try the shop' }, AGENT) as Promise<any>;
  await until(() => !$('#t-take').hidden, 'the asking');
  const takeId = String(host.events.since(0).filter((e) => e.type === 'page.take').at(-1)!.id);
  await assert.rejects(host.run('page.let', { id: takeId, allow: true }, AGENT) as Promise<any>, /the person's to do/);
  click(button('Not now', $('#t-take')));
  await assert.rejects(refusing, /not now/);
  await until(() => $('#t-take').hidden, 'the asking to go');
  assert.equal($('#t-held').hidden, true);
  // Given back by the agent, and at the end of its turn, the page is the person's again.
  const again_ = host.run('page.take', { why: 'once more' }, AGENT) as Promise<any>;
  await until(() => !$('#t-take').hidden, 'the asking');
  click(button('Let it', $('#t-take')));
  await again_;
  assert.deepEqual(await host.run('page.release', {}, AGENT), { released: true });
  await until(() => $('#t-held').hidden, 'the mark to go');
  assert.deepEqual(host.events.since(0).filter((e) => e.type.startsWith('page.t') || e.type === 'page.released').slice(-3).map((e) => [e.type, e.by, e.allow]), [['page.take', AGENT, undefined], ['page.taken', 'me', true], ['page.released', AGENT, undefined]]);
  toFrame.length = 0;
  // What the page refuses, the agent is told as it is.
  const typing = assert.rejects(host.run('page.type', { at: 'Surname', text: 'x' }, AGENT), /there is no field on the page called "Surname"/);
  await doing('type', { ok: false, error: 'there is no field on the page called "Surname"' });
  await typing;

  await host.run('stage.open', { tab: 'concepts', id: 'night-roses' }, AGENT);
  await until(() => $('input.title'), 'the concept to be opened');
  assert.ok(!$('#t-sheet').classList.contains('shut'));
  assert.equal(($('input.title') as HTMLInputElement).value, 'Night roses');
  // The ECS and the playtests are the agent's instruments: there is no tab for them. What it looks at and plays
  // shows up in the conversation.
  tab('Chat');
  await host.run('art.look', { name: 'gnome' }, AGENT);
  host.events.add({ type: 'playtest', by: AGENT, kind: 'run', profile: 'eager', proposed: false, length: 598.9, minutes: { start: 0 } });
  await until(() => $('figure.card.look img') && all('.card.test').length === 1, 'the look and the playtest in the conversation');
  assert.match($('.card.test').textContent!, /Playtest.*eager player.*whole game.*9h59/);
  assert.equal(all('button', $('.card.test')).length, 0);
  tab('Concepts');

  // Something said while the person is elsewhere is news on the chat tab and on the button.
  assert.ok(!$('#t-fab').classList.contains('news'));
  await host.run('chat.send', { text: 'Have a look at this one.' }, AGENT);
  await until(() => $('#t-fab').classList.contains('news'), 'the news');
  assert.ok(all('.t-tab').find((t) => t.textContent === 'Chat')!.classList.contains('news'));
  tab('Chat');
  assert.ok(!$('#t-fab').classList.contains('news'), 'read is read');
  assert.match(all('.msg.agent').at(-1)!.textContent!, /Have a look at this one/);
});

test('a change to the project is a card: which files, the copy played in the frame, and a decision', async () => {
  tab('Chat');
  const files = [{ path: 'src/seasons.ts', added: 40, removed: 0, status: 'new' }, { path: 'src/game.ts', added: 12, removed: 3, status: 'changed' }];
  // What the engine tells the agent is shown, small; then what the agent's working copy changed.
  host.events.add({ type: 'message', by: 'engine', text: 'Art was accepted into the project: garden-cottage. Bring it in.' });
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc1', kind: 'code', path: 'working copy', files, note: 'The cottage follows the season.' });
  await until(() => all('.card.prop').some((c) => /A change to the project/.test(c.textContent!)), 'the card');
  assert.match(all('.sys.engine').at(-1)!.textContent!, /to the agent: Art was accepted/);
  const card = all('.card.prop').find((c) => /A change to the project/.test(c.textContent!))!;
  assert.deepEqual(all('.field .k', card).map((k) => k.textContent), ['src/seasons.ts', 'src/game.ts']);
  assert.match(card.textContent!, /new\+40/);
  assert.match(card.textContent!, /\+12−3/);
  assert.match($('.note', card).textContent!, /The cottage follows the season/);
  assert.deepEqual(all('button', card).map((b) => b.textContent), ['Play the copy', 'Accept', 'Reject']);

  // What changed in a file is read by tapping it: what came in and what went, without what git says about the file.
  canned.set('code.changes', { path: 'src/game.ts', diff: 'diff --git a/src/game.ts b/src/game.ts\nindex 1..2 100644\n--- a/src/game.ts\n+++ b/src/game.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const season = 0;\n+const season = seasonOf(day);\n' });
  const file = () => all('.field.file', card).find((f) => /src\/game\.ts/.test(f.textContent!))!;
  click(file());
  await until(() => $('pre.diff', card), 'what changed in it');
  assert.deepEqual(all('pre.diff span', card).map((l) => [l.dataset.how, l.textContent!.trimEnd()]).filter(([, t]) => t),
    [['at', '⋯'], ['same', ' const a = 1;'], ['out', '-const season = 0;'], ['in', '+const season = seasonOf(day);']]);
  assert.equal(file().getAttribute('aria-expanded'), 'true');
  click(file());
  await until(() => !$('pre.diff', card), 'it to fold away again');
  canned.delete('code.changes');

  // Playing the copy: the frame shows the working copy's page instead, started from the world the person is in,
  // and says so. (Here there is no working copy to start, so the frame is switched by hand.)
  fromFrame({ type: 'hello', loaded: false, can: { snapshot: true, point: true } });
  fromFrame({ type: 'snapshot', snapshot: { blooms: 7 } });
  click(button('Play the copy', card));
  await until(() => ran.includes('code.play'), 'the copy to be asked for');
  await until(() => /no working copy/.test($('#t-toast').textContent!), 'the answer that there is none here');
  app.stage.showCopy('http://localhost:5211/');
  await until(() => frame.src === 'http://localhost:5211/', 'the frame to show the copy');
  assert.equal($('#t-copy').hidden, false);
  assert.match($('#t-copy').textContent!, /The working copy/);
  toFrame.length = 0;
  fromFrame({ type: 'hello', loaded: false, can: { snapshot: true, point: false } });
  assert.deepEqual(toFrame, [{ tandem: 1, type: 'load', snapshot: { blooms: 7 } }], 'the copy is asked to start from the person\'s world');
  // What happens in the copy is a try-out: its world is not passed on as the person's.
  const pushed = ran.filter((n) => n === 'world.push').length;
  (app.info as { senses: boolean }).senses = true;
  fromFrame({ type: 'snapshot', snapshot: { blooms: 99 } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran.filter((n) => n === 'world.push').length, pushed);
  (app.info as { senses: boolean }).senses = false;

  // The agent works on: the same card, with what the copy changes now. Decided, the frame is the project again.
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc1', kind: 'code', path: 'working copy', files: files.slice(0, 1), note: 'Only the seasons.' });
  await until(() => all('.field .k', card).length === 1, 'the card to follow');
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'accepted', count: 1, paths: ['code:working copy'] });
  host.events.add({ type: 'code.changed', by: 'me', files: [files[0].path] });
  await until(() => card.dataset.status === 'accepted', 'the decision');
  assert.match(all('.chat .sys').at(-1)!.textContent!, /the working copy is the project now: 1 file changed/);
  await until(() => frame.src === 'http://localhost:5210/', 'the frame to show the project again');
  assert.equal($('#t-copy').hidden, true);
  // A page that was once asked to start from a world is told it is its own again.
  toFrame.length = 0;
  fromFrame({ type: 'hello', loaded: true, can: { snapshot: true, point: true } });
  assert.deepEqual(toFrame, [{ tandem: 1, type: 'unload' }]);

  // The working copy is one round that comes back: what it proposes next is a card of its own.
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc2', kind: 'code', path: 'working copy', files, note: 'Bulbs.' });
  await until(() => all('.card.prop').filter((c) => /A change to the project/.test(c.textContent!)).length === 2, 'a second card');
  assert.equal(card.dataset.status, 'accepted');
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
  // (The agent, set to work by the engine's message above, may have put a card of its own after it.)
  await until(() => all('.card.prop').filter((c) => /A change to the project/.test(c.textContent!)).at(-1)!.dataset.status === 'rejected', 'the rejection');
});

test('playing the copy starts it from what the browser keeps of the project, goes to where the change is and marks it', async () => {
  tab('Chat');
  app.playProject();
  fromFrame({ type: 'page', can: { find: true, act: true } });
  const answer = async (what: string, says: Record<string, unknown>) => {
    await until(() => toFrame.some((m) => m.type === 'do' && m.do === what), `the page to be asked to ${what}`, 20000);
    const m = toFrame.find((x) => x.type === 'do' && x.do === what);
    toFrame.splice(toFrame.indexOf(m), 1);
    fromFrame({ type: 'did', id: m.id, ...says });
    return m;
  };
  // The agent said where its change shows: the card offers to go there.
  const show = { steps: [{ tap: 'Shop' }, { fill: 'Search', text: 'lamp' }], at: 'Lamplight', text: 'the new pack' };
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc7', kind: 'code', path: 'working copy', files: [{ path: 'src/shop.js', added: 1, removed: 1, status: 'changed' }], note: 'Lamplight is out.', show });
  await until(() => all('.card.prop').some((c) => c.dataset.status === 'pending' && /Lamplight is out/.test(c.textContent!)), 'the card');
  const card = all('.card.prop').find((c) => c.dataset.status === 'pending' && /Lamplight is out/.test(c.textContent!))!;
  assert.deepEqual(all('.t-row button', card).map((b) => b.textContent), ['Show me in the copy', 'Accept', 'Reject']);
  canned.set('code.play', { url: 'http://localhost:5211/' });
  toFrame.length = 0;
  click(button('Show me in the copy', card));
  // What the project keeps in the browser is asked of its page, and given to the copy's once that is there.
  await answer('state', { ok: true, local: { save: '{"level":12}' }, session: { tab: 'home' }, path: '/shop?x=1' });
  await until(() => frame.src === 'http://localhost:5211/', 'the frame to show the copy');
  assert.ok($('#t-sheet').classList.contains('shut'), 'the tools get out of the way');
  fromFrame({ type: 'page', can: { find: true, act: true } });
  const load = await answer('load', { ok: true });
  assert.deepEqual([load.local, load.session, load.path], [{ save: '{"level":12}' }, { tab: 'home' }, '/'], 'who they are and how far, from where the app opens: the steps start there');
  fromFrame({ type: 'page', can: { find: true, act: true } });
  // The way to the change, as a person would go it.
  assert.equal((await answer('tap', { ok: true, did: 'tapped button "Shop"', x: 1, y: 1, w: 10, h: 10 })).at, 'Shop');
  const fill = await answer('type', { ok: true, did: 'filled in "Search"' });
  assert.deepEqual([fill.at, fill.text], ['Search', 'lamp']);
  // And the thing itself, marked.
  await until(() => toFrame.some((m) => m.type === 'find'), 'the thing to be looked for', 20000);
  const finding = toFrame.find((m) => m.type === 'find');
  assert.equal(finding.at, 'Lamplight');
  fromFrame({ type: 'found', id: finding.id, x: 30, y: 200, w: 120, h: 80 });
  await until(() => !$('#t-ring').hidden && $('#t-ring span').textContent === 'the new pack', 'the ring around what changed');
  canned.delete('code.play');
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
  await until(() => card.dataset.status === 'rejected', 'the card to be put away');
  app.playProject();
});

test('on a wide screen the tools are a panel beside the page: it stays in view, so pointing does not wait and nothing has to be shut', async () => {
  (w as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
  try {
    app.open('chat');
    assert.ok(w.document.body.classList.contains('t-wide') && w.document.body.classList.contains('t-open'));
    fromFrame({ type: 'page', can: { find: true } });
    toFrame.length = 0;
    await host.run('stage.point', { at: 'Make a group' }, AGENT);
    await until(() => toFrame.some((m) => m.type === 'find'), 'the page to be asked at once');
    fromFrame({ type: 'found', id: toFrame.find((m) => m.type === 'find').id, x: 40, y: 500, w: 200, h: 44 });
    await until(() => !$('#t-ring').hidden && $('#t-ring').classList.contains('box'), 'the ring, beside the open tools');
    app.reveal();
    assert.ok(!$('#t-sheet').classList.contains('shut'), 'the page is in view already');
    app.close();
    assert.ok(!w.document.body.classList.contains('t-open'), 'shut, the page has the whole screen again');
  } finally {
    delete (w as unknown as { matchMedia?: unknown }).matchMedia;
    app.close();
  }
  assert.ok(!w.document.body.classList.contains('t-wide'));
  app.open('chat');
  app.reveal();
  assert.ok($('#t-sheet').classList.contains('shut'), 'on a narrow one the tools cover the page, and are shut for it');
});

test('a tab that has to ask the core first says it is loading in the panel, not on the tab', async () => {
  app.open('chat');
  const concepts = all('.t-tab').find((t) => t.textContent === 'Concepts')!;
  click(concepts);
  assert.ok(!concepts.classList.contains('working') && !(concepts as HTMLButtonElement).disabled, 'the tab stays a tab');
  assert.ok($('#t-body .loading .spin'), 'the panel says it is loading');
  await until(() => !$('#t-body .loading'), 'the panel to be drawn');
  assert.ok($('#t-body').childNodes.length > 0);
  // The chat is there at once: nothing to wait for.
  tab('Chat');
  assert.ok(!$('#t-body .loading'));
  app.close();
});

test('a new conversation clears the chat and keeps what is still to be decided', async () => {
  tab('Chat');
  // (The engine's message in the test before this one set the agent to work, as it should; let it finish.)
  await until(() => !app.agent.busy, 'the agent to be done');
  await host.run('concepts.create', { name: 'Daisies everywhere' }, AGENT, 'r950');
  await until(() => all('.card.prop').some((c) => $('.path[data-id=daisies-everywhere]', c)), 'a pending proposal');
  const open = all('.card.prop').filter((c) => c.dataset.status === 'pending').length;
  assert.ok(all('.msg').length >= 3 && all('.card.prop').length > open, 'there is a conversation, with decided proposals in it');
  asked = '7';
  click($('.composer .new-chat'));
  await until(() => all('.msg').length === 0, 'the chat to be cleared');
  assert.equal(all('.card.prop').length, open, 'what is still to be decided is still there, and nothing else');
  assert.ok(all('.card.prop').every((c) => c.dataset.status === 'pending'));
  assert.equal(all('figure.card.look').length + all('.card.test').length, 0);
  assert.equal(app.agent.session, false, 'and the agent has forgotten');
  assert.match($('.usage').textContent!, /nothing in context yet/);
  const daisy = all('.card.prop').find((c) => $('.path[data-id=daisies-everywhere]', c))!;
  click(button('Reject', daisy));
  await until(() => daisy.dataset.status === 'rejected', 'the rejection');
  type($('.composer textarea'), 'hello again');
  click(button('Send'));
  await until(() => $('.msg.agent'), 'an answer in the new conversation');
  assert.doesNotMatch($('.msg.agent').textContent!, /^Again: /);
  await until(() => !app.agent.busy, 'the agent to be done');

  // In a project tandem has not been in before, the chat opens with an offer: read the project, or just talk.
  host.events.add({ type: 'welcome', by: 'engine', existing: true, files: 12, name: 'Fixture' });
  await until(() => $('.msg.welcome'), 'the first line');
  assert.match($('.msg.welcome').textContent!, /Fixture is new to tandem\. Shall I read the project/);
  const before = ran.filter((n) => n === 'project.init').length;
  click(button('Yes, read the project', $('.msg.welcome')));
  await until(() => ran.filter((n) => n === 'project.init').length === before + 1, 'the agent to be asked');
  await until(() => all('button', $('.msg.welcome')).length === 0, 'the offer to be taken');
  await until(() => !app.agent.busy && all('.msg.agent:not(.welcome)').length >= 2, 'the agent to have read it');
  // A project with nothing in it yet is asked what it is going to be, and there is nothing to read.
  host.events.add({ type: 'welcome', by: 'engine', existing: false, files: 0, name: 'Blank' });
  await until(() => all('.msg.welcome').length === 2, 'the other first line');
  assert.match(all('.msg.welcome')[1].textContent!, /Blank is a fresh project\. Tell me what you want to make/);
  assert.equal(all('button', all('.msg.welcome')[1]).length, 0);
});

test('with the tools shut, tandem speaks in a bubble: what it says goes again, what waits for an answer stays', async () => {
  await until(() => !app.agent.busy, 'the agent to be done');
  // (Whatever the tests before left undecided is decided, so the bubbles here are this test's.)
  for (const round of new Set((await host.run('proposals.list', { status: 'pending' }, 'me') as { round: string }[]).map((p) => p.round))) await host.run('proposals.decide', { round, accept: false }, 'me');
  // (And what was said while they were shut before is not said again once the tools have been open.)
  app.open('chat');
  app.close();
  await until(() => all('.bubble').length === 0, 'no bubbles');
  assert.ok($('#t-bubbles').hidden);

  // Something the agent says: a bubble that leads to the chat (and goes by itself after a while).
  await host.run('chat.send', { text: 'The roses come too late, I think.' }, AGENT);
  await until(() => $('.bubble.says'), 'what it said');
  assert.equal($('.bubble.says').textContent, 'The roses come too late, I think.');
  assert.equal(all('.bubble button').length, 0);
  click($('.bubble.says'));
  assert.equal($('.t-tab.on').textContent, 'Chat');
  assert.ok($('#t-bubbles').hidden, 'with the tools open there are no bubbles: it is all in the chat');
  app.close();

  // Something it proposes: a bubble that stays, with the two answers on it.
  await host.run('concepts.create', { name: 'Later roses', text: 'Roses come later.' }, AGENT, 'r970');
  await until(() => $('.bubble.waits'), 'the proposal');
  assert.match($('.bubble.waits b').textContent!, /A new concept · Later roses/);
  assert.deepEqual(all('.bubble.waits button').map((b) => b.getAttribute('aria-label') ?? b.textContent), ['Hide', 'Approve', 'Decline']);
  tab('Concepts');
  assert.ok($('#t-bubbles').hidden);
  app.close();
  assert.ok($('.bubble.waits'), 'still there when the tools are shut again: it waits for an answer');
  click(button('Approve', $('.bubble.waits')));
  await until(() => host.concepts.get('later-roses'), 'the concept to be accepted');
  await until(() => !$('.bubble.waits'), 'the bubble to go');

  await host.run('concepts.update', { id: 'later-roses', text: 'Roses come much later.' }, AGENT, 'r971');
  await until(() => $('.bubble.waits'), 'another proposal');
  assert.match($('.bubble.waits b').textContent!, /A change to the concept Later roses$/);
  click(button('Decline', $('.bubble.waits')));
  await until(() => !$('.bubble.waits'), 'the bubble to go');
  assert.equal(host.concepts.get('later-roses')!.text, 'Roses come later.', 'declined: nothing changed');

  // While the agent is at work, what it proposes does not pop up piece by piece: it is asked about once, when it is done.
  const status = (busy: boolean) => host.events.cast({ type: 'agent.status', busy, doing: busy ? 'reads the project' : '', text: '', waiting: 0, session: true, off: false, context: 0, limit: 0 });
  status(true);
  for (const name of ['Heather', 'Gorse', 'Broom']) await host.run('concepts.create', { name }, AGENT, 'r974');
  await until(() => app.events.filter((e) => e.type === 'proposal' && e.round === 'r974').length === 3, 'the three to arrive');
  assert.ok(!$('.bubble.waits'), 'nothing is asked while it is still at it');
  status(false);
  await until(() => /A proposal · 3 changes/.test($('.bubble.waits b')?.textContent ?? ''), 'the round, once');
  // A bubble that has nothing new to say is left as it is, not put up again.
  const standing = $('.bubble.waits');
  host.events.add({ type: 'concept.changed', by: 'me', id: 'night-roses', what: 'updated', fields: [] });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal($('.bubble.waits'), standing);
  click(button('Decline', $('.bubble.waits')));
  await until(() => !$('.bubble.waits'), 'the bubble to go');

  // What waits can be put out of sight: it stays in the chat, and comes back over the page when something new comes with it.
  await host.run('concepts.create', { name: 'Reeds' }, AGENT, 'r975');
  await until(() => /A new concept · Reeds/.test($('.bubble.waits b')?.textContent ?? ''), 'the proposal');
  click($('.bubble.waits .hide'));
  assert.ok(!$('.bubble.waits'), 'hidden at once');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('tandem-hidden:fixture')!), ['r975'], 'and kept, for when the page is opened again');
  assert.equal((await host.run('proposals.list', { status: 'pending' }, 'me') as unknown[]).length, 1, 'it still waits');
  await host.run('concepts.create', { name: 'Rushes' }, AGENT, 'r975');
  await until(() => /A proposal · 2 changes/.test($('.bubble.waits b')?.textContent ?? ''), 'it to be back with what is new');
  click(button('Decline', $('.bubble.waits')));
  await until(() => !$('.bubble.waits'), 'the bubble to go');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('tandem-hidden:fixture')!), []);

  // A round of several that is decided piece by piece keeps waiting for what is left of it.
  for (const name of ['Moss', 'Ferns']) await host.run('concepts.create', { name }, AGENT, 'r972');
  await until(() => /A proposal · 2 changes/.test($('.bubble.waits b')?.textContent ?? ''), 'the two');
  const moss = (await host.run('proposals.list', { status: 'pending' }, 'me') as { id: string; path: string }[]).find((x) => x.path === 'moss')!;
  await host.run('proposals.decide', { round: 'r972', accept: false, only: [moss.id] }, 'me');
  await until(() => /A new concept · Ferns/.test($('.bubble.waits b')?.textContent ?? ''), 'the one that is left');
  click(button('Decline', $('.bubble.waits')));
  await until(() => !$('.bubble.waits'), 'the bubble to go');

  // A change to the project says how many files; a drawing worker's round says what it waits for.
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc9', kind: 'code', path: 'working copy', files: [{ path: 'a.ts' }, { path: 'b.ts' }], note: 'Seasons.' });
  await until(() => /A change to the project · 2 files/.test($('.bubble.waits b')?.textContent ?? ''), 'the change');
  // Two things waiting are one bubble, a line each with its own two answers; not two bubbles over each other.
  await host.run('concepts.create', { name: 'Ivy' }, AGENT, 'r973');
  await until(() => $('.bubble.waits.many'), 'the one bubble for both');
  assert.equal(all('.bubble.waits').length, 1);
  assert.match($('.bubble.many .count').textContent!, /2 things wait for you/);
  assert.deepEqual(all('.bubble.many .wait b').map((b) => b.textContent), ['A change to the project · 2 files', 'A new concept · Ivy']);
  click(button('Decline', all('.bubble.many .wait')[1]));
  await until(() => !$('.bubble.many') && /A change to the project/.test($('.bubble.waits b')?.textContent ?? ''), 'the one that is left, said in full again');
  assert.equal(host.concepts.get('ivy'), undefined);
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
  await until(() => !$('.bubble.waits'), 'it to be gone when decided elsewhere');
  host.events.add({ type: 'art.round', by: 'agent:w1', worker: 'w1', name: 'gnome', state: 'waiting', phase: 'silhouette', text: 'The silhouette is ready.' });
  await until(() => /gnome: a silhouette to approve/.test($('.bubble.waits b')?.textContent ?? ''), 'the silhouette');
  const before = ran.filter((n) => n === 'art.approve').length;
  click(button('Approve', $('.bubble.waits')));
  await until(() => ran.filter((n) => n === 'art.approve').length === before + 1, 'approving a silhouette to be what Approve does there');
  host.events.cast({ type: 'art.status', worker: 'w1', name: 'gnome', state: 'running', phase: 'color', doing: 'draws gnome' });
  await until(() => !$('.bubble.waits'), 'the bubble to go once it draws again');

  // The offer to read a project that is new to tandem waits too, and can be put off.
  host.events.add({ type: 'welcome', by: 'engine', existing: true, files: 3, name: 'Fixture' });
  await until(() => /Fixture is new to tandem/.test($('.bubble.waits b')?.textContent ?? ''), 'the offer');
  click(button('Not now', $('.bubble.waits')));
  assert.ok(!$('.bubble.waits'));
  host.events.add({ type: 'chat.new', by: 'me' });
});

test('projects: the folders that could be one are listed, and another is chosen from the page', async () => {
  // Next to the project there is another one, and a folder that is not a repository yet.
  const beside = join(dir, '..');
  mkdirSync(join(beside, 'other-game/.git'), { recursive: true });
  writeFileSync(join(beside, 'other-game/tandem.json'), JSON.stringify({ name: 'The Other Game', page: 'serve {port}' }));
  mkdirSync(join(beside, 'loose-notes'));
  // Not a tab: the button at the end of the tabs, where another project is opened.
  click($('button[aria-label="Open another project"]'));
  await until(() => all('.item.project').length >= 3, 'the folders');
  assert.equal(all('.t-tab.on').length, 0, 'none of the tabs is the one showing');
  const item = (name: string) => all('.item.project').find((i) => $('b', i).textContent === name)!;
  assert.equal(all('.item.project')[0], item('Fixture'), 'the one that is open comes first');
  assert.match(item('Fixture').textContent!, /open now/);
  assert.match(item('The Other Game').textContent!, /new to tandem · has a page/);
  assert.match(item('loose-notes').textContent!, /no git repository yet: tandem starts one when you open it/);
  click(item('The Other Game'));
  await until(() => ran.includes('projects.open'), 'the other project to be asked for');
  // (Nothing looks after this core, so it is only remembered; started as `tandem`, the core starts again on it and the page with it.)
  await until(() => /It is chosen/.test($('#t-toast').textContent!), 'the answer');
  assert.equal(JSON.parse(readFileSync(process.env.TANDEM_STATE!, 'utf8')).project, join(beside, 'other-game'));

  // A folder without a repository is opened too: tandem starts one there.
  click(item('loose-notes'));
  await until(() => existsSync(join(beside, 'loose-notes/.git')), 'the repository to be started');

  // Projects that are somewhere else are found by walking the folders too, not by typing a path: the folder they
  // are in is pointed at, and standing in a repository that one can be opened.
  click($('button[aria-label="Open another project"]'));
  const has = (text: string) => all('button', $('#t-sheet')).some((x) => x.textContent === text);
  await until(() => has('Find a folder'), 'the chooser');
  mkdirSync(join(beside, 'elsewhere/far-game'), { recursive: true });
  writeFileSync(process.env.TANDEM_STATE!, JSON.stringify({ ...JSON.parse(readFileSync(process.env.TANDEM_STATE!, 'utf8')), lastIn: join(beside, 'other-game') }));
  click(button('Find a folder'));
  await until(() => $('.here')?.textContent === join(beside, 'other-game'), 'the folders');
  assert.ok(has('Open this one'), 'a repository can be opened where you stand');
  click(all('.item.folder').find((f) => /up/.test(f.textContent!))!);
  await until(() => $('.here')?.textContent === beside, 'the folder above');
  assert.equal(has('Open this one'), false, 'a folder that is no repository is not offered to open');
  click(all('.item.folder').find((f) => /elsewhere/.test(f.textContent!))!);
  await until(() => $('.here')?.textContent === join(beside, 'elsewhere'), 'the folder');
  click(button('My projects are in here'));
  await until(() => item('far-game'), 'the project found there');
  app.close();

  // And a project that does not exist yet is made from here. Where it goes is the person's to choose, every time:
  // until a folder is chosen it cannot be made.
  click($('button[aria-label="Open another project"]'));
  await until(() => $('input[aria-label="Name of a new project"]'), 'the form');
  assert.match($('.where').textContent!, /Where\? Not chosen yet\./);
  assert.ok((button('Create') as HTMLButtonElement).disabled);
  type($('input[aria-label="Name of a new project"]'), 'Winter Game');
  // (The folders are walked from where a project was last made; here that is said to be beside the fixture.)
  writeFileSync(process.env.TANDEM_STATE!, JSON.stringify({ ...JSON.parse(readFileSync(process.env.TANDEM_STATE!, 'utf8')), lastIn: join(beside, 'other-game') }));
  click(button('Choose a folder'));
  await until(() => $('.here')?.textContent === join(beside, 'other-game'), 'the folders');
  click(all('.item.folder').find((f) => /up/.test(f.textContent!))!);
  await until(() => $('.here')?.textContent === beside, 'the folder above');
  assert.ok(all('.item.folder').some((f) => /loose-notes/.test(f.textContent!)));
  click(button('Here'));
  await until(() => $('.where'), 'the form again');
  assert.equal($('.where .k').textContent, `In ${beside}`);
  assert.equal(($('input[aria-label="Name of a new project"]') as HTMLInputElement).value, 'Winter Game', 'what was typed is still there');
  click(button('Create'));
  await until(() => ran.includes('projects.create'), 'the new project to be asked for');
  await until(() => /It is made/.test($('#t-toast').textContent!), 'the answer');
  assert.ok(existsSync(join(beside, 'winter-game/.git')));
  assert.equal(readFileSync(join(beside, 'winter-game/README.md'), 'utf8'), '# Winter Game\n');
});

test('while the core is starting the page waits for it, and says what is being done meanwhile', async () => {
  const { coreUp } = await import('../shell/api.ts');
  const before = globalThis.fetch;
  let asked = 0;
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  globalThis.fetch = ((url: string) => {
    if (url === '/starting') return asked < 3 ? json({ name: 'Winter Game', root: '/w', doing: 'setting up its .tandem folder', seconds: 7 }) : Promise.resolve(new Response('', { status: 500 }));
    // Away at first, then up on the project that was open, then on the one that was asked for.
    asked++;
    return asked < 3 ? Promise.reject(new Error('refused')) : json({ project: 'w', name: 'Winter Game', root: asked < 5 ? '/other' : '/w' });
  }) as typeof fetch;
  try {
    const said: [string, boolean][] = [];
    const got = await coreUp((text, running) => said.push([text, running]), '/w', 5);
    assert.equal(got.root, '/w');
    assert.deepEqual(said[0], ['Opening Winter Game: setting up its .tandem folder (7 s)', true]);
    assert.deepEqual(said.at(-1), ['', false], 'and when nobody says what is being done, that is told too');
  } finally {
    globalThis.fetch = before;
  }
});

test('an event stream that goes silent is opened again from where it was: a core that starts again does not always end it', async () => {
  const { follow } = await import('../shell/api.ts');
  const opened: { url: string; closed: boolean; readyState: number; onmessage?: (m: { data: string }) => void; close(): void }[] = [];
  const Real = (globalThis as unknown as { EventSource: unknown }).EventSource;
  (globalThis as unknown as { EventSource: unknown }).EventSource = class { url: string; closed = false; readyState = 1; onmessage?: (m: { data: string }) => void; constructor(url: string) { this.url = url; opened.push(this); } close() { this.closed = true; this.readyState = 2; } };
  const got: number[] = [], up: boolean[] = [];
  const stop = follow(5, (ev) => got.push(ev.n), (live) => up.push(live), 400);
  try {
    opened[0].onmessage!({ data: JSON.stringify({ n: 6, type: 'message' }) });
    // While the core says it is there, the stream is left alone; that it says so is not passed on.
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 150)); opened[0].onmessage!({ data: '{"n":0,"type":"beat"}' }); }
    assert.deepEqual([opened.length, got], [1, [6]]);
    await until(() => opened.length === 2, 'the stream to be opened again', 5000);
    assert.deepEqual([opened[0].closed, opened[1].url, up.at(-1)], [true, '/api/events?since=6', false]);
  } finally { stop(); (globalThis as unknown as { EventSource: unknown }).EventSource = Real; }
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
  // (world.push is there only for a project that can be seen inside, which this one cannot; the shell sends it only then.)
  known.add('world.push');
  for (const name of used) assert.ok(known.has(name), `${name}, which the shell uses, is a command`);
});
