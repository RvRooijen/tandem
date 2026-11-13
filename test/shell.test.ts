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
globalThis.fetch = ((url: string, init?: RequestInit) => { const m = String(url).match(/\/api\/run\/([\w.]+)/); if (m) ran.push(m[1]); return fetchNow(url, init); }) as typeof fetch;

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
  assert.deepEqual(app.stage.can, { snapshot: false, point: false }, 'a page that says nothing is simply shown');
});

test('a page that uses the bridge tells tandem its world, and where things are', async () => {
  fromFrame({ type: 'hello', loaded: false, can: { snapshot: true, point: true } });
  assert.deepEqual(app.stage.can, { snapshot: true, point: true });
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
  assert.match($('.change .path', card).textContent!, /concept tulips-r\d+/);
  assert.ok(all('.field', card).some((f) => /text.*new.*Tulips are worth a bit more\./.test(f.textContent!)), 'what it would be, spelled out');
  assert.match($('.note', card).textContent!, /a new concept/);
  assert.deepEqual(all('button', card).map((b) => b.textContent), ['Accept', 'Reject'], 'a proposal is decided; there is nothing else to press');

  click(button('Accept', card));
  await until(() => card.dataset.status === 'accepted', 'the card to say accepted');
  const id = $('.change .path', card).textContent!.split(' ')[1];
  assert.equal(host.concepts.get(id)!.text, 'Tulips are worth a bit more.');
  assert.equal(all('button', card).length, 0, 'a decided proposal has no buttons');
  await until(() => !app.agent.busy, 'the agent to be done');
  // (It is out of the way of the tests that follow.)
  await host.run('concepts.remove', { id }, 'me');
  await until(() => !app.agent.busy, 'the agent to be done');
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

  click(all('.segments button').find((b) => b.textContent === 'design')!);
  type($('textarea.words'), 'A rose that only opens after dark.');
  assert.ok(!all('#t-body h3').some((x) => /promise/i.test(x.textContent!)), 'a concept has no timings to fill in');
  type($('textarea[aria-label="What makes it real"]'), 'a new flower\nthe nap');
  click(button('Save'));
  await until(() => host.concepts.get('night-roses')?.stage === 'design', 'the concept to be saved');
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
  const about = () => all('.card.prop').find((c) => /concept night-roses/.test(c.textContent!) && c.dataset.status === 'pending');
  await until(about, 'the proposal about it');
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
  await until(() => all('.card.prop').at(-1)!.dataset.status === 'rejected', 'the rejection');
});

test('a new conversation clears the chat and keeps what is still to be decided', async () => {
  tab('Chat');
  // (The engine's message in the test before this one set the agent to work, as it should; let it finish.)
  await until(() => !app.agent.busy, 'the agent to be done');
  await host.run('concepts.create', { name: 'Daisies everywhere' }, AGENT, 'r950');
  await until(() => all('.card.prop').some((c) => /daisies-everywhere/.test(c.textContent!)), 'a pending proposal');
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
  const daisy = all('.card.prop').find((c) => /daisies-everywhere/.test(c.textContent!))!;
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
  assert.match($('.bubble.waits b').textContent!, /A proposal · concept later-roses, new/);
  assert.deepEqual(all('.bubble.waits button').map((b) => b.textContent), ['Approve', 'Decline']);
  tab('Concepts');
  assert.ok($('#t-bubbles').hidden);
  app.close();
  assert.ok($('.bubble.waits'), 'still there when the tools are shut again: it waits for an answer');
  click(button('Approve', $('.bubble.waits')));
  await until(() => host.concepts.get('later-roses'), 'the concept to be accepted');
  await until(() => !$('.bubble.waits'), 'the bubble to go');

  await host.run('concepts.update', { id: 'later-roses', text: 'Roses come much later.' }, AGENT, 'r971');
  await until(() => $('.bubble.waits'), 'another proposal');
  assert.match($('.bubble.waits b').textContent!, /A proposal · concept later-roses$/);
  click(button('Decline', $('.bubble.waits')));
  await until(() => !$('.bubble.waits'), 'the bubble to go');
  assert.equal(host.concepts.get('later-roses')!.text, 'Roses come later.', 'declined: nothing changed');

  // A change to the project says how many files; a drawing worker's round says what it waits for.
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc9', kind: 'code', path: 'working copy', files: [{ path: 'a.ts' }, { path: 'b.ts' }], note: 'Seasons.' });
  await until(() => /A change to the project · 2 files/.test($('.bubble.waits b')?.textContent ?? ''), 'the change');
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
