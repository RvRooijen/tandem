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
/** And what each was given, for the ones a test wants to read. */
const gave: [name: string, input: any][] = [];
const fetchNow = globalThis.fetch;
/** Answers given here instead of by the core, for what this fixture does not have (a working copy). */
const canned = new Map<string, unknown>();
globalThis.fetch = ((url: string, init?: RequestInit) => {
  const m = String(url).match(/\/api\/run\/([\w.]+)/);
  if (m) { ran.push(m[1]); try { gave.push([m[1], JSON.parse(String(init?.body ?? '{}'))]); } catch { /* not ours to read */ } }
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
/** In the document a piece is read first; from there it is opened up to work on. */
async function edit(id: string) {
  const piece = () => $(`#t-body .piece[data-id="${id}"]`);
  await until(piece, `the piece ${id}`);
  if (piece().dataset.open !== 'true') click($('.head', piece()));
  await until(() => piece()?.dataset.open === 'true', `${id} to open`);
  click(button('Edit', piece()));
}
const type = (el: HTMLElement, value: string) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

/**
 * What waits is one set, on one card: what an earlier step left undecided (the stand-in agent proposes a concept at
 * every message) is put away, so the card that comes next holds only what the test is about.
 */
async function settle() {
  await until(() => !app.agent.busy, 'the agent to be done');
  if ((await host.run('proposals.list', { status: 'pending' }, 'me') as unknown[]).length) await host.run('proposals.decide', { accept: false }, 'me');
}

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
  assert.deepEqual(all('.t-tab').map((t) => t.textContent), ['Chat', 'Concepts', 'Art', 'Git', 'Projects']);
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
  const id = $('.change .path', card).dataset.id!;
  assert.deepEqual(all('button', card).map((b) => b.getAttribute('aria-label') ?? b.textContent), [`Edit ${id}`, 'Add a concept', 'Accept', 'Reject'], 'a proposed concept is changed, added to, or decided');

  click(button('Accept', card));
  await until(() => card.dataset.status === 'accepted', 'the card to say accepted');
  assert.equal(host.concepts.get(id)!.text, 'Tulips are worth a bit more.');
  assert.equal(all('button', card).length, 0, 'a decided proposal has no buttons');
  // The agent hears that it was taken, and says so.
  await until(() => all('.sys.engine').some((x) => /The agent was told what you accepted\.$/.test(x.textContent!)), 'the line that says the agent was told');
  await until(() => all('.msg.agent').some((x) => x.textContent!.includes(`Seen: Tulips ${id.slice(7)} (${id}): as you proposed it.`)), 'the agent to have heard it');
  await until(() => !app.agent.busy, 'the agent to be done');
  // (It is out of the way of the tests that follow.)
  await host.run('concepts.remove', { id }, 'me');
  await until(() => !app.agent.busy, 'the agent to be done');
});

test('chat: what waits is one card, whichever turn of the agent it came from, and it is decided as one', async () => {
  for (const name of ['Poppies', 'Thistles']) await host.run('concepts.create', { name, text: `${name} grow.` }, AGENT, 'r950');
  await host.run('concepts.create', { name: 'Clover', text: 'Clover grow.' }, AGENT, 'r951');
  await until(() => all('.card.prop').at(-1)?.querySelectorAll('.change').length === 3, 'the three in one card');
  const card = all('.card.prop').at(-1)!;
  assert.match($('.t-head', card).textContent!, /A proposal, 3 changes.*pending/);
  // A piece is changed on the card; there is no yes or no for a piece on its own.
  assert.deepEqual(all('button', card).map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ['Edit poppies', 'Edit thistles', 'Edit clover', 'Add a concept', 'Accept all', 'Reject all']);
  click(button('Accept all', card));
  await until(() => card.dataset.status === 'accepted', 'the card to be accepted');
  assert.equal(all('button', card).length, 0);
  for (const id of ['poppies', 'thistles', 'clover']) assert.equal(host.concepts.get(id)!.text, `${id[0].toUpperCase()}${id.slice(1)} grow.`);
  await until(() => !app.agent.busy, 'the agent to be done');
  for (const id of ['poppies', 'thistles', 'clover']) await host.run('concepts.remove', { id }, 'me');
  await until(() => !app.agent.busy, 'the agent to be done');
});

test('chat: a proposed concept is typed in on its card before it is accepted, and one of the person\'s own is added to it', async () => {
  await host.run('concepts.create', { name: 'Hedges', text: 'A hedge along the path.' }, 'me');
  await host.run('concepts.create', { name: 'Ponds', text: 'A pond with frogs.' }, AGENT, 'r955');
  await host.run('concepts.update', { id: 'hedges', text: 'A hedge along the path, clipped square.' }, AGENT, 'r955');
  const card = () => all('.card.prop').find((c) => $('.path[data-id=ponds]', c))!;
  await until(() => card()?.querySelectorAll('.change').length === 2, 'the round');
  const piece = (path: string) => all('.change', card()).find((c) => $('.path', c)?.dataset.id === path)!;

  // Opened, it has the fields a concept has, filled with what is proposed.
  click($('button[aria-label="Edit ponds"]', card()));
  await until(() => $('.cedit', piece('ponds')), 'the fields');
  const field = (label: string, path: string) => $(`.cedit [aria-label="${label}"]`, piece(path)) as HTMLInputElement;
  assert.deepEqual([field('Name', 'ponds').value, field('Description', 'ponds').value, $('.cedit .segments .on', piece('ponds')).textContent], ['Ponds', 'A pond with frogs.', 'idea']);
  assert.equal($('button[aria-label="Edit ponds"]', card()), null, 'it is open already');
  // It can be linked to what is in the document.
  assert.deepEqual(all('option', field('Linked concept', 'ponds')).map((o) => o.textContent), ['another concept…', 'Hedges']);
  type(field('Description', 'ponds'), 'A pond with frogs and one heron.');
  // What is typed stays when the card is drawn again (the agent adds to the round meanwhile).
  await host.run('concepts.create', { name: 'Reeds bed', text: 'Reeds.' }, AGENT, 'r955');
  await until(() => card().querySelectorAll('.change').length === 3, 'the card to follow');
  assert.equal(field('Description', 'ponds').value, 'A pond with frogs and one heron.');
  click(all('.cedit .segments button', piece('ponds')).find((b) => b.textContent === 'design')!);
  click(button('Save', piece('ponds')));
  await until(() => !$('.cedit', piece('ponds')) && $('.ctext', piece('ponds'))?.textContent === 'A pond with frogs and one heron.', 'the card to say what was typed');
  assert.equal($('.path .t-chip.stage', piece('ponds')).textContent, 'design');
  assert.equal($('.note.yours', piece('ponds')).textContent, 'You changed its text, stage.');
  assert.equal(host.concepts.get('ponds'), undefined, 'it is still a proposal');
  // Cancel leaves it as it was.
  click($('button[aria-label="Edit ponds"]', card()));
  await until(() => $('.cedit', piece('ponds')), 'the fields again');
  type(field('Name', 'ponds'), 'Lakes');
  click(button('Cancel', piece('ponds')));
  assert.equal($('.path b', piece('ponds')).textContent, 'Ponds');

  // A change to a concept that is there opens with the whole concept, and only what was typed is changed.
  click($('button[aria-label="Edit hedges"]', card()));
  await until(() => $('.cedit', piece('hedges')), 'the fields of the hedge');
  assert.deepEqual([field('Name', 'hedges').value, field('Description', 'hedges').value], ['Hedges', 'A hedge along the path, clipped square.']);
  type(field('Description', 'hedges'), 'A hedge along the path, clipped round.');

  // One of their own: it has to have a name, and can be linked to what else is new in the round.
  click(button('Add a concept', card()));
  await until(() => $('.change.adding .cedit', card()), 'the fields of a new one');
  const adding = () => $('.change.adding', card());
  click(button('Add to the proposal', adding()));
  assert.match($('#t-toast').textContent!, /Name it first/);
  type($('[aria-label="Name"]', adding()), 'Stepping stones');
  type($('[aria-label="Description"]', adding()), 'Flat stones across the pond.');
  const to = $('[aria-label="Linked concept"]', adding()) as HTMLSelectElement;
  assert.deepEqual(all('option', to).map((o) => o.textContent), ['another concept…', 'Hedges', 'Ponds', 'Reeds bed']);
  to.value = 'ponds';
  to.dispatchEvent(new w.Event('change'));
  click(button('Add to the proposal', adding()));
  await until(() => piece('stepping-stones'), 'it to be a piece of the round');
  assert.equal(adding(), null);
  assert.match($('.pathline', piece('stepping-stones')).textContent!, /Stepping stones.*idea.*added by you/);
  assert.match($('.t-head', card()).textContent!, /A proposal, 4 changes/);

  // Accepting takes what is still being typed with it; the agent is told what was made different.
  const before = host.events.last();
  click(button('Accept all', card()));
  await until(() => card().dataset.status === 'accepted', 'the round to be accepted');
  assert.equal(host.concepts.get('hedges')!.text, 'A hedge along the path, clipped round.', 'what was open was kept first');
  assert.deepEqual((({ text, stage }) => [text, stage])(host.concepts.get('ponds')!), ['A pond with frogs and one heron.', 'design']);
  assert.deepEqual(host.concepts.get('stepping-stones')!.links, [{ to: 'ponds', kind: 'part-of' }]);
  assert.equal($('.cedit', card()), null);
  await until(() => all('.sys.engine').some((x) => /The agent was told what you accepted, and what you made different in it\.$/.test(x.textContent!)), 'the line that says so');
  await until(() => host.events.since(before).some((e) => e.type === 'message' && e.by === 'agent' && /Ponds \(ponds\): the person changed it before accepting: its text, stage "idea" → "design"\. \| .*Stepping stones \(stepping-stones\): the person added it.*With what they say now/.test(String(e.text))), 'the agent to have heard it');
  await until(() => !app.agent.busy, 'the agent to be done');
  for (const id of ['hedges', 'ponds', 'reeds-bed', 'stepping-stones']) await host.run('concepts.remove', { id }, 'me');
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
  // The agent changes a question after that: it is asked anew, with a field, and what was said to the one that
  // still reads the same stays said. Only the new answer is sent.
  await host.run('concepts.update', { id: 'wells', questions: ['Is there water in it?', 'Who dug it, and when?'] }, AGENT, 'r960');
  await until(() => all('.questions .qtext', card).some((q) => q.textContent === 'Who dug it, and when?'), 'the changed question');
  assert.equal($('.questions.done', card), null);
  assert.deepEqual(all('.questions .q', card).map((q) => [$('.qtext', q).textContent, $('.qanswer', q)?.textContent ?? null, all('textarea', q).length]),
    [['Is there water in it?', 'Yes, cold and clear.', 0], ['Who dug it, and when?', null, 1]]);
  type(fields()[0], 'The first gnomes, long ago.');
  const again = host.events.last();
  click(button('Send answer', card));
  await until(() => $('.questions.done', card), 'both to stand answered');
  assert.deepEqual(all('.questions .qanswer', card).map((x) => x.textContent), ['Yes, cold and clear.', 'The first gnomes, long ago.']);
  assert.match(String(host.events.since(again).find((e) => e.type === 'message' && e.by === 'me')!.text), /Wells:\n- Who dug it, and when\?\n  The first gnomes, long ago\.$/);
  await until(() => !app.agent.busy && host.events.since(again).some((e) => e.type === 'message' && e.by === 'agent'), 'the agent to have heard it');
  await until(() => !app.agent.busy, 'the agent to be done');
  // (With what the agent proposed when it was answered: it waits on the same card.)
  click(button(/^Reject/, card));
  await until(() => card.dataset.status === 'rejected', 'the card to be put away');
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
  if ((await host.run('proposals.list', { status: 'pending' }, 'me') as unknown[]).length) await host.run('proposals.decide', { accept: false }, 'me');
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
  if ((await host.run('proposals.list', { status: 'pending' }, 'me') as unknown[]).length) await host.run('proposals.decide', { accept: false }, 'me');
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
  await settle();
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
  click($('#t-body .bar button.link'));
  await until(() => $('#t-body .piece'), 'the document');
  assert.match($('#t-body .piece').textContent!, /Night roses.*design/);

  // A lock: from then on the agent is refused, whatever it is asked.
  await edit('night-roses');
  await until(() => $('button.lock'), 'the concept, with its lock');
  assert.equal($('button.lock').getAttribute('aria-pressed'), 'false');
  click($('button.lock'));
  await until(() => host.locks.has('concept:night-roses'), 'the lock');
  assert.equal($('button.lock').getAttribute('aria-pressed'), 'true');
  assert.match($('#t-toast').textContent!, /even if you ask it to/);
  await assert.rejects(host.run('concepts.update', { id: 'night-roses', text: 'x' }, AGENT, 'r901'), /locked/);
  click($('#t-body .bar button.link'));
  await until(() => $('#t-body .piece'), 'the document');
  assert.match($('#t-body .piece b').textContent!, /^ Night roses/);
  assert.ok($('#t-body .piece b svg.t-ic.i-lock'), 'with a lock before its name');
  await edit('night-roses');
  await until(() => $('button.lock'), 'the concept again');
  click($('button.lock'));
  await until(() => !host.locks.has('concept:night-roses'), 'the lock to come off');
});

test('a concept shows what was changed in the project for it, and what waits for it', async () => {
  // (This fixture has no working copy, so no history of its own: what the core would say is answered here.)
  const list = await host.run('concepts.list', {}, 'me') as { id: string }[];
  canned.set('concepts.list', list.map((c) => (c.id === 'night-roses' ? { ...c, changes: 2, waiting: true } : c)));
  canned.set('concepts.history', { waiting: { says: 'Roses close at dawn.', files: 2 }, changes: [
    { hash: 'abc1234567', ts: Date.now() - 3 * 3600_000, says: 'Roses open after dark' },
    { hash: 'def1234567', ts: Date.now() - 2 * 86400_000, says: 'A rose bed by the gate' },
  ] });
  try {
    click($('#t-body .bar button.link'));
    await until(() => $('#t-body .piece small.made'), 'the document, with what was made');
    assert.equal($('#t-body .piece small.made').textContent, 'a change waits · 2 changes made');
    await edit('night-roses');
    await until(() => $('.rows.made'), 'the concept, with its changes');
    assert.deepEqual(all('.rows.made .check').map((r) => r.textContent), ['Roses close at dawn.waiting', 'Roses open after dark3h', 'A rose bed by the gate2d'], 'what waits first, then the newest');
    // What waits is decided in the conversation: tapped, that is where it goes.
    click($('.rows.made .check.waits'));
    await until(() => $('.t-tab.on').textContent === 'Chat', 'the chat');
  } finally { canned.delete('concepts.list'); canned.delete('concepts.history'); }
  // A concept nothing was made for says nothing about it.
  tab('Concepts');
  await until(() => $('input.title'), 'the concept again');
  assert.equal($('.rows.made'), null);
});

test('the concepts read as one document, and above it a thought is typed as it comes', async () => {
  // A chapter is a concept that is part of nothing; what is part of it stands under it. All of it is open to read.
  await host.run('concepts.create', { name: 'The garden at night', text: 'After dark the garden is another place.\n\nThings open that were shut.' }, 'me');
  await host.run('concepts.update', { id: 'night-roses', links: [{ to: 'the-garden-at-night', kind: 'part-of' }] }, 'me');
  click($('#t-body .bar button.link'));
  await until(() => all('#t-body .piece.chapter').length === 1, 'the document');
  const chapter = () => $('#t-body .piece.chapter');
  assert.equal($('.doc-head h3').textContent, 'The document');
  assert.equal($('.head b', chapter()).textContent, 'The garden at night');
  // A piece is read where it stands: all of its words, and from there it is worked on or talked about.
  assert.equal(chapter().dataset.open, 'true');
  assert.match($('.read .prose', chapter()).textContent!, /another place\.Things open that were shut\.$/);
  assert.deepEqual(all('.read button', chapter()).slice(0, 2).map((b) => b.textContent), ['Edit', 'Talk about this']);
  // And its parts stand under it, open too.
  assert.equal($('.rail', chapter()).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(all('.piece.part').map((p) => [$('.head b', p).textContent, p.dataset.open]), [['Night roses', 'true']]);
  // Tapped, a piece folds to the one sentence that says what it is, and a chapter's parts are put away; tapped again, they are back.
  click($(':scope > .head', chapter()));
  assert.equal(chapter().dataset.open, 'false');
  assert.equal($(':scope > .head p.core', chapter()).textContent, 'After dark the garden is another place.', 'what it is, in a sentence');
  // The line down the left of the parts is what puts them away, and what is left of it brings them back.
  click($('.rail', chapter()));
  assert.deepEqual([$('.rail', chapter()).getAttribute('aria-expanded'), $('.away', chapter()).textContent], ['false', '1 part']);
  assert.equal(all('.piece.part').length, 0);
  click($('.rail', chapter()));
  click($(':scope > .head', chapter()));
  await until(() => chapter().dataset.open === 'true' && all('.piece.part').length === 1, 'the chapter and its part, open again');
  click($(':scope > .head', chapter()));
  assert.equal(chapter().dataset.open, 'false');

  // A loose thought: no name, no place. It is kept as it was typed, above the document.
  const mind = () => $('.adder.mind textarea') as HTMLTextAreaElement;
  type(mind(), 'Moths around the lamp?');
  click(button('Keep'));
  await until(() => all('#t-body .thought').length === 1, 'the thought');
  assert.equal($('.thought p').textContent, 'Moths around the lamp?');
  assert.equal(mind().value, '', 'and the field is empty again');
  const [moths] = host.thoughts.list();
  assert.equal(moths.text, 'Moths around the lamp?');
  assert.equal(all('#t-body .piece').length, 2, 'it is not in the document');
  // What is being typed is not lost when the list is drawn again for something that happened.
  type(mind(), 'half a th');
  await host.run('concepts.update', { id: 'the-garden-at-night', stage: 'design' }, AGENT, 'r930');
  await host.run('proposals.decide', { accept: true }, 'me');
  await until(() => /design/.test(chapter().textContent!), 'the document to follow');
  assert.equal(mind().value, 'half a th');
  type(mind(), '');

  // It can be talked about with the agent, which is told what it says.
  click(button('Talk about this', $('.thought')));
  assert.equal($('.t-tab.on').textContent, 'Chat');
  assert.deepEqual(app.refs, [`thought:${moths.id}`]);
  assert.equal($('#t-foot .t-chip.ref span').textContent, 'a loose thought');
  click($('#t-foot .t-chip.ref button'));
  // The agent says where it belongs: the card names the thought, and accepted, the thought is no longer loose.
  await host.run('concepts.update', { id: 'night-roses', text: 'A rose that only opens after dark, and closes if you look. Moths come to it.', thought: moths.id }, AGENT, 'r931');
  const card = () => all('.card.prop').find((c) => c.dataset.status === 'pending' && /From your thought/.test(c.textContent!));
  await until(card, 'the proposal that takes the thought in');
  assert.match($('.note.from', card()!).textContent!, /^From your thought: Moths around the lamp\?$/);
  click(button('Accept', card()!));
  await until(() => !host.thoughts.list().length, 'the thought to be placed');
  tab('Concepts');
  await until(() => $('#t-body .doc') && !$('#t-body .thought'), 'the document without the thought');

  // Or the person gives it a name themselves: then it is a piece of the document, with the thought as its words.
  type(mind(), 'A pond that freezes over.');
  click(button('Keep'));
  await until(() => $('#t-body .thought'), 'another thought');
  click(button('Make it a piece', $('.thought')));
  type($('.thought.naming input'), 'The pond');
  click(button('Add to the document'));
  await until(() => host.concepts.get('the-pond'), 'the piece');
  assert.equal(host.concepts.get('the-pond')!.text, 'A pond that freezes over.');
  assert.deepEqual(host.thoughts.list(), []);
  await until(() => $('#t-body .piece[data-id=the-pond]')?.dataset.open === 'true' && !$('#t-body .thought'), 'the new piece, open to read');
  // And one that leads nowhere is thrown away.
  type(mind(), 'Never mind.');
  click(button('Keep'));
  await until(() => $('#t-body .thought'), 'a third thought');
  click($('.thought button[aria-label="Throw this thought away"]'));
  await until(() => !$('#t-body .thought') && !host.thoughts.list().length, 'the thought to go');

  // A piece with a name is added from the head of the document.
  assert.equal($('.adder input[aria-label="Name of a new concept"]'), null);
  click(button('Add a piece'));
  assert.ok($('.adder input[aria-label="Name of a new concept"]'));
  click(button('Not now'));
  for (const id of ['the-pond', 'the-garden-at-night']) await host.run('concepts.remove', { id }, 'me');
  await host.run('concepts.update', { id: 'night-roses', links: [] }, 'me');
  await edit('night-roses');
  await until(() => $('input.title'), 'the concept, as the tests after this one expect it');
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
  // picture before and after. Deciding about it is the agent's: it is told when the round ends, and takes it.
  assert.ok(!all('#t-body button').some((b) => /worker/i.test(b.textContent!)) && !$('#t-body textarea'), 'no form to ask for art');
  await host.run('art.ask', { name: 'gnome', message: 'a taller hat' }, AGENT);
  click($('#t-body .bar button.link'));
  await until(() => $('.workers .item'), 'the worker, in the list');
  assert.match($('.workers .item').textContent!, /gnome/);
  click($('.workers .item'));
  await until(() => $('canvas.live'), 'the worker, watched');
  assert.equal($('#t-body .bar b').textContent, 'gnome');
  // Every look of it: three looks, each two rows (stand, walk), the widest two frames of 32 across, a pixel between.
  await until(() => ($('canvas.live') as HTMLCanvasElement).width === 67 && ($('canvas.live') as HTMLCanvasElement).height === 199, 'the drawing, live', 90000);
  assert.equal($('.t-hint.looks').textContent, 'Every look, top to bottom: cozy · odd · hollow');
  assert.deepEqual(all('.worker-rest button').map((b) => b.textContent), ['Stop'], 'while it draws it can be stopped; nothing else is the person\'s to press');
  const was = (await host.run('art.get', { name: 'gnome' }, 'me') as { text: string }).text;
  await until(() => all('.pictures figcaption').length === 6, 'its round', 60000);
  assert.deepEqual(all('.pictures figcaption').map((f) => f.textContent), ['cozy, as it is', 'cozy, as proposed', 'odd, as it is', 'odd, as proposed', 'hollow, as it is', 'hollow, as proposed']);
  assert.match($('.worker-rest .said').textContent!, /Changed gnome\. Render ok/);
  assert.match($('.worker-rest').textContent!, /Asked.*a taller hat/);
  assert.equal(all('.worker-rest button, .worker-rest textarea').length, 0, 'a round that ended has no approve, feedback or accept for the person');

  // The agent was told, looked at it and took it: it is in the project without the person doing anything.
  await until(() => /Accepted: it is in the game/.test($('.worker-rest').textContent!), 'the agent to have taken it', 90000);
  assert.equal($('#t-body .bar .t-chip').textContent, 'accepted');
  assert.equal(all('.worker-rest button').length, 0);
  assert.equal((await host.run('art.get', { name: 'gnome' }, 'me') as { text: string }).text, `${was.trimEnd()}\n@rect 0 0 1 1 ${was.match(/^(\S) = #/m)![1]}\n`, 'the drawing is the worker\'s now');
  assert.deepEqual(await host.run('art.workers', {}, 'me'), []);
  await until(() => !app.agent.busy, 'the agent to be done');

  // The conversation is not a feed of drawing work: no card, only a line that leads back to the Art tab.
  tab('Chat');
  assert.ok(!all('.card.prop').some((c) => /drawing gnome/.test(c.textContent!)));
  const lines = all('.chat .sys').filter((x) => x.querySelector('.t-ic.i-art')).map((x) => x.textContent!);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /the agent asked a worker to change gnome: a taller hat/);
  assert.match(lines[1], /gnome: the drawing is ready; the agent looks at it/);
  assert.ok(!all('.chat .sys').some((x) => /The drawing worker/.test(x.textContent!)), 'what the engine told the agent about it is not spelled out');
  // What the agent looked at to judge it is in the conversation, and what it did with it.
  assert.equal(all('figure.card.look').length, 1);
  assert.ok(all('.msg.agent').some((x) => /Worker w[a-z0-9]+: looked \(ok\), art\.accept \(ok\)\./.test(x.textContent!)));
  assert.ok(all('.chat .sys').some((x) => /gnome: in the game now/.test(x.textContent!)));
  click(all('.chat .sys').find((x) => x.querySelector('.t-ic.i-art'))!);
  await until(() => $('canvas.live'), 'the line to lead to the worker');
  assert.match($('.worker-rest').textContent!, /Accepted/);
  click($('#t-body .bar button.link'));
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
  // (The first time something is pointed at, this tab is asked to be shared, when the finger lets go; said no to,
  // the page draws the picture itself, and it is not asked again.)
  const shareAsked: unknown[] = [];
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: (o: unknown) => { shareAsked.push(o); return Promise.reject(new Error('NotAllowedError')); } } });
  pointer('pointerdown', 340, 60);
  pointer('pointermove', 200, 400);
  await answer(die);
  await until(() => !$('#t-ring').hidden && $('#t-ring span').textContent === '"Mesh, IcosahedronGeometry 0.8, 2 of…"', 'the thing in the scene to be marked');
  pointer('pointerup', 200, 400);
  assert.equal(shareAsked.length, 1, 'sharing the tab is asked for as the finger lets go');
  assert.equal((await answer({ ...die, image: 'data:image/jpeg;base64,/9j/AAAA' })).image, true, 'let go on it, a picture of it is asked for');
  assert.equal((await import('../shell/capture.ts')).refused(), true, 'said no to: not asked again by itself');
  delete (globalThis.navigator as unknown as Record<string, unknown>).mediaDevices;
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
  // (A thing the agent did is a row: what it did, and to what.)
  const said = (row: Element) => `${$('.verb', row).textContent} ${$('.what', row).textContent}`;
  await until(() => all('.chat .act').some((x) => said(x) === 'tapped button "Make a group"' && x.dataset.kind === 'page'), 'what it did, in the conversation');
  // What it does one thing after another is one group, which opens to show them all; something said ends the group.
  const before = all('.chat .acts').length;
  for (const did of ['read src/main.js', 'searched for "shadow"', 'ran `npm test`']) host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did });
  await until(() => $('summary b', all('.chat .acts').at(-1)!)?.textContent === '4 things done', 'the group, with the tap before it');
  assert.deepEqual([$('summary .kinds', all('.chat .acts').at(-1)!).textContent, $('summary .last', all('.chat .acts').at(-1)!).textContent], ['1 tapped · 1 read · 1 searched for · 1 ran', 'ran `npm test`']);
  assert.equal(all('.chat .acts').length, before, 'they joined what it did just before');
  assert.deepEqual(all('.act', all('.chat .acts').at(-1)!).map((x) => [said(x), x.dataset.kind]), [['tapped button "Make a group"', 'page'], ['read src/main.js', 'read'], ['searched for "shadow"', 'read'], ['ran npm test', 'run']]);
  assert.equal($('.act .what.path i', all('.chat .acts').at(-1)!).textContent, 'src/', 'the folders before a file\'s name stand back');
  host.events.add({ type: 'message', by: 'agent', text: 'The tests pass.', round: 'r9' });
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'changed src/main.js' });
  await until(() => all('.chat .acts').length === before + 1, 'a new one after it spoke');
  assert.deepEqual(all('.act', all('.chat .acts').at(-1)!).map(said), ['changed src/main.js']);
  assert.ok(all('.chat .acts').at(-1)!.classList.contains('latest') && !all('.chat .acts').at(-2)!.classList.contains('latest'));
  // The last group stands open, with what its last thing answered under it; the one before it is folded.
  const groups = () => all('.chat .acts').slice(-2);
  assert.equal(groups()[0].querySelector('details')!.open, false);
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'ran `npm test`', id: 'call-1' });
  await until(() => groups()[1].querySelector('details')?.open, 'the last group, open');
  assert.equal(all('pre.out', groups()[1]).length, 0, 'nothing answered yet');
  host.events.add({ type: 'agent.out', by: 'agent', round: 'r9', id: 'call-1', out: '# pass 3\n# fail 0' });
  await until(() => all('pre.out', groups()[1]).length === 1, 'what the command printed');
  assert.equal($('pre.out', groups()[1]).textContent, '# pass 3\n# fail 0');
  // One more thing: its answer is the one shown; the earlier one shows its own when tapped. A picture is shown as one.
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'looked at a picture', id: 'call-2', picture: '/api/file/looks/page-1.jpg' });
  host.events.add({ type: 'agent.out', by: 'agent', round: 'r9', id: 'call-2', out: '(a picture)' });
  await until(() => groups()[1].querySelector('img.seen'), 'the picture it looked at');
  assert.equal(all('pre.out', groups()[1]).length, 0);
  click(all('.act', groups()[1])[1]);
  assert.ok(all('.act', groups()[1])[1].classList.contains('open'));
  assert.equal($('pre.out', groups()[1]).textContent, '# pass 3\n# fail 0');
  // A change to a file shows the lines that went and came.
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'changed src/main.js', id: 'call-2a', added: 1, removed: 1 });
  await until(() => all('.act', groups()[1]).at(-1)?.querySelector('.count'), 'how much it changed, beside the line');
  assert.deepEqual([said(all('.act', groups()[1]).at(-1)!), $('.count', all('.act', groups()[1]).at(-1)!).textContent], ['changed src/main.js', '+1−1']);
  host.events.add({ type: 'agent.out', by: 'agent', round: 'r9', id: 'call-2a', out: '-bias = 2\n+bias = 1', change: true });
  await until(() => $('.answer pre.diff', groups()[1]), 'the change, as lines');
  assert.deepEqual(all('.answer pre.diff span', groups()[1]).map((x) => [x.dataset.how, x.textContent]), [['out', '- bias = 2'], ['in', '+ bias = 1']]);
  assert.equal($('.answer .of', groups()[1]).textContent, 'changed src/main.js', 'and which thing that is the answer of');
  assert.ok(all('.act', groups()[1]).at(-1)!.classList.contains('inbox'));
  // The same file changed again right after is the same row, counted; a thing it is still at says for how long.
  const rowsBefore = all('.act', groups()[1]).length;
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'changed src/main.js', id: 'call-2a2', added: 2, removed: 0 });
  await until(() => $('.times', all('.act', groups()[1]).at(-1)!)?.textContent === '×2', 'the two as one row');
  assert.deepEqual([all('.act', groups()[1]).length, $('.count', all('.act', groups()[1]).at(-1)!).textContent], [rowsBefore, '+3−1']);
  assert.ok($('.answer', groups()[1]).classList.contains('stale'), 'until it answers, the place shows the one before, as that');
  host.events.add({ type: 'agent.out', by: 'agent', round: 'r9', id: 'call-2a2', out: '+one\n+two', change: true });
  await until(() => !$('.answer', groups()[1]).classList.contains('stale'), 'its own answer');
  // A picture from anywhere else is known once the tool has answered with it.
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'looked at /tmp/crop.png', id: 'call-2b' });
  host.events.add({ type: 'agent.out', by: 'agent', round: 'r9', id: 'call-2b', out: '(a picture)', picture: '/api/file/looks/seen-1.png' });
  await until(() => $('.answer img.seen', groups()[1])?.getAttribute('src') === '/api/file/looks/seen-1.png', 'the picture it was given');
  host.events.add({ type: 'agent.did', by: 'agent', round: 'r9', did: 'ran `npm run build`', id: 'call-3' });
  host.events.add({ type: 'agent.out', by: 'agent', round: 'r9', id: 'call-3', out: 'it broke', error: true });
  await until(() => $('pre.out.fail', groups()[1]), 'what went wrong, said as that');
  app.close();

  // The agent asks for the page, to try what it made itself: the person is asked over the page, and says yes.
  const taking = host.run('page.take', { why: 'to see the dice roll' }, AGENT) as Promise<any>;
  await until(() => !$('#t-take').hidden, 'the asking, over the page');
  assert.match($('#t-take').textContent!, /to see the dice roll/);
  assert.equal($('#t-held').hidden, true);
  // Let it, and this tab is asked to be shared, in the same click; said no to, the page draws its pictures itself.
  const tabAsked: unknown[] = [];
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: (o: unknown) => { tabAsked.push(o); return Promise.reject(new Error('NotAllowedError')); } } });
  click(button('Let it', $('#t-take')));
  assert.equal(tabAsked.length, 1, 'asked in the click itself');
  assert.equal((tabAsked[0] as { preferCurrentTab?: boolean }).preferCurrentTab, true, 'this tab');
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
  delete (globalThis.navigator as unknown as Record<string, unknown>).mediaDevices;
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
  // With tandem's extension in the browser nothing is shared: the picture of the page is asked of the extension
  // (here it has none to give, and the page draws it itself).
  const extAsked: number[] = [];
  const extension = (ev: MessageEvent) => { if (ev.data?.tandemPictures === 'ask') { extAsked.push(ev.data.id); w.postMessage({ tandemPictures: 'shot', id: ev.data.id, ok: false, error: 'not here' }, '*'); } };
  document.documentElement.dataset.tandemPictures = '1';
  w.addEventListener('message', extension);
  const sharedNow = tabAsked.length;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: (o: unknown) => { tabAsked.push(o); return Promise.reject(new Error('NotAllowedError')); } } });
  const frameEl = $('#t-frame') as HTMLIFrameElement;
  const frameHidden = frameEl.hidden;
  frameEl.hidden = false;
  frameEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 620, right: 360, bottom: 620, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const again_ = host.run('page.take', { why: 'once more' }, AGENT) as Promise<any>;
  await until(() => !$('#t-take').hidden, 'the asking');
  click(button('Let it', $('#t-take')));
  await again_;
  assert.equal(tabAsked.length, sharedNow, 'the tab is not asked to be shared');
  toFrame.length = 0;
  const lookingExt = host.run('page.look', {}, AGENT) as Promise<any>;
  await doing('look', onPage);
  await until(() => extAsked.length === 1, 'the extension to be asked for a picture');
  await doing('picture', { ok: true, image: 'data:image/jpeg;base64,/9j/AAAA', size: [360, 620] });
  assert.deepEqual((await lookingExt).size, [360, 620]);
  w.removeEventListener('message', extension);
  delete document.documentElement.dataset.tandemPictures;
  delete (globalThis.navigator as unknown as Record<string, unknown>).mediaDevices;
  delete (frameEl as unknown as Record<string, unknown>).getBoundingClientRect;
  frameEl.hidden = frameHidden;
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
  await settle();
  tab('Chat');
  const files = [{ path: 'src/seasons.ts', added: 40, removed: 0, status: 'new' }, { path: 'src/game.ts', added: 12, removed: 3, status: 'changed' }];
  // What the engine tells the agent is shown, small; then what the agent's working copy changed.
  const heard = all('.msg.agent').length;
  host.events.add({ type: 'message', by: 'engine', text: 'Art was accepted into the project: garden-cottage. Bring it in.' });
  // (The agent is set to work by it, and what it proposes then would be on the same card: that is put away first.)
  await until(() => all('.msg.agent').length > heard, 'the agent to have answered');
  await settle();
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc1', kind: 'code', path: 'working copy', files, note: 'The cottage follows the season.' });
  await until(() => all('.card.prop').some((c) => /A change to the project/.test(c.textContent!)), 'the card');
  assert.match(all('.sys.engine').at(-1)!.textContent!, /to the agent: Art was accepted/);
  const card = all('.card.prop').find((c) => /A change to the project/.test(c.textContent!))!;
  assert.deepEqual(all('.field .k', card).map((k) => k.textContent), ['src/seasons.ts', 'src/game.ts']);
  assert.match(card.textContent!, /new\+40/);
  // While it waits and its card is out of view, it is pinned at the top of the conversation; in view, it is not.
  const pin = () => all('#t-body .pins .pin').find((x) => /A change to the project waits/.test(x.textContent!));
  await until(pin, 'the pin');
  assert.match(pin()!.textContent!, /The cottage follows the season\./);
  assert.deepEqual(all('button', pin()!).map((x) => x.textContent), ['Play', 'Accept']);
  const body_ = $('#t-body');
  const [bodyRect, cardRect] = [body_.getBoundingClientRect, card.getBoundingClientRect];
  body_.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  card.getBoundingClientRect = () => ({ top: 200, bottom: 400 }) as DOMRect;
  body_.dispatchEvent(new w.Event('scroll'));
  assert.equal(pin(), undefined, 'the card itself is there to see');
  body_.getBoundingClientRect = bodyRect; card.getBoundingClientRect = cardRect;
  body_.dispatchEvent(new w.Event('scroll'));
  assert.ok(pin());
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
  await until(() => !pin(), 'decided, it is no longer pinned');
  assert.match(all('.chat .sys').at(-1)!.textContent!, /the working copy is the project now: 1 file changed/);
  await until(() => frame.src === 'http://localhost:5210/', 'the frame to show the project again');
  assert.equal($('#t-copy').hidden, true);
  // A page that was once asked to start from a world is told it is its own again.
  toFrame.length = 0;
  fromFrame({ type: 'hello', loaded: true, can: { snapshot: true, point: true } });
  assert.deepEqual(toFrame, [{ tandem: 1, type: 'unload' }]);

  // Once decided, what the working copy proposes next is a card of its own.
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc2', kind: 'code', path: 'working copy', files, note: 'Bulbs.' });
  await until(() => all('.card.prop').filter((c) => /A change to the project/.test(c.textContent!)).length === 2, 'a second card');
  assert.equal(card.dataset.status, 'accepted');
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
  // (The agent, set to work by the engine's message above, may have put a card of its own after it.)
  await until(() => all('.card.prop').filter((c) => /A change to the project/.test(c.textContent!)).at(-1)!.dataset.status === 'rejected', 'the rejection');
});

test('an accepted change loads the project\'s page anew, also when the project was what the frame showed', async () => {
  app.playProject();
  await until(() => frame.src === 'http://localhost:5210/' && !frame.hidden, 'the frame to show the project');
  // (Pointing the frame at a page starts with asking whether that page answers: that is what is counted.)
  let asked = 0;
  const before = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => { if (String(url) === 'http://localhost:5210/') asked++; return before(url, init); }) as typeof fetch;
  try {
    // Rejected, nothing changed in the project: the page stays as it is.
    host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(asked, 0);
    host.events.add({ type: 'code.changed', by: 'me', files: ['src/seasons.js'] });
    await until(() => asked === 1 && !frame.hidden, 'the project\'s page to be loaded again');
    assert.equal(frame.src, 'http://localhost:5210/');
    assert.equal(app.stage.showing, 'project');
  } finally { globalThis.fetch = before; }
});

test('playing the copy starts it from what the browser keeps of the project, goes to where the change is and marks it', async () => {
  await settle();
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

test('values the agent exposed are turned on the card, and over the copy\'s page while it is shown; the card is not drawn again for it', async () => {
  await settle();
  tab('Chat');
  app.playProject();
  const file = 'src/shop.js';
  const files = [{ path: file, added: 2, removed: 1, status: 'changed' }];
  const tweaks = [
    { label: 'Lamp glow', file, name: 'GLOW', kind: 'number', value: 4, min: 0, max: 10, step: 1 },
    { label: 'Price', file, name: 'PRICE', kind: 'number', value: 2.5 },
    { label: 'Flicker', file, name: 'FLICKER', kind: 'boolean', value: false },
    { label: 'Light', file, name: 'LIGHT', kind: 'colour', value: '#fc8' },
    { label: 'Name', file, name: 'NAME', kind: 'text', value: 'Lamplight' },
  ];
  const propose = (more: Record<string, unknown> = {}, list: Record<string, unknown>[] = tweaks) => host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc8', kind: 'code', path: 'working copy', files, note: 'The lamp glows.', tweaks: list, ...more });
  propose();
  await until(() => all('.card.prop').some((c) => c.dataset.status === 'pending' && /The lamp glows/.test(c.textContent!)), 'the card');
  const card = all('.card.prop').find((c) => c.dataset.status === 'pending' && /The lamp glows/.test(c.textContent!))!;
  const rows = (root: ParentNode = card) => all('.tweak', root);
  const field = (label: string, sel = 'input', root: ParentNode = card) => rows(root).find((r) => $('.tlabel', r).textContent === label)!.querySelector(sel) as HTMLInputElement;
  // Each is what its value asks for: a slider with a number, a number, a switch, a colour, a text.
  assert.deepEqual(rows().map((r) => [r.dataset.kind, $('.tlabel', r).textContent, all('input', r).map((i) => (i as HTMLInputElement).type).join('+')]),
    [['number', 'Lamp glow', 'number+range'], ['number', 'Price', 'number'], ['boolean', 'Flicker', 'checkbox'], ['colour', 'Light', 'color'], ['text', 'Name', 'text']]);
  assert.deepEqual([field('Lamp glow', '.slide').value, field('Lamp glow', '.slide').max, field('Price').value, field('Flicker').checked, field('Light').value, field('Name').value], ['4', '10', '2.5', false, '#ffcc88', 'Lamplight']);
  assert.ok(rows().every((r) => $('.back', r).hidden), 'nothing was turned yet');
  assert.ok($('#t-tweaks').hidden, 'over the page they are only while the copy is shown');

  // Turning one sends it at once; what is set while that is on its way is sent after it, the last only.
  canned.set('code.tweak', { changed: true });
  gave.length = 0;
  const slide = field('Lamp glow', '.slide');
  for (const v of ['5', '6', '7']) type(slide, v);
  assert.equal(field('Lamp glow', '.n').value, '7', 'the number beside the slider follows it');
  const sent = () => gave.filter(([name]) => name === 'code.tweak').map(([, input]) => input);
  await until(() => sent().length === 2, 'the first and the last to be sent');
  assert.deepEqual(sent(), [{ file, name: 'GLOW', value: 5 }, { file, name: 'GLOW', value: 7 }]);
  // The core says what it is now: the same card, the same slider, and the way back to what the agent had.
  propose({ tweaked: { file, name: 'GLOW' } }, tweaks.map((t) => (t.name === 'GLOW' ? { ...t, value: 7, was: 4 } : t)));
  await until(() => !$('.back', rows()[0]).hidden, 'the way back');
  assert.equal(field('Lamp glow', '.slide'), slide, 'the slider is the one that was turned');
  assert.ok(all('.card.prop').includes(card) && slide.isConnected);
  assert.equal($('.back', rows()[0]).textContent, '↺ 4');
  gave.length = 0;
  click($('.back', rows()[0]));
  await until(() => sent().length === 1, 'the way back to be gone');
  assert.deepEqual([sent()[0], slide.value], [{ file, name: 'GLOW', value: 4 }, '4']);
  // A number out of its range, or half typed, is not sent; a switch, a colour and a text are.
  gave.length = 0;
  type(field('Lamp glow', '.n'), '11');
  type(field('Price'), '');
  type(field('Price'), '3.25');
  field('Flicker').checked = true;
  field('Flicker').dispatchEvent(new w.Event('change', { bubbles: true }));
  type(field('Light'), '#112233');
  field('Name').value = 'Glowworm';
  field('Name').dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => sent().length === 4, 'the four to be sent');
  assert.deepEqual(sent().map((i) => [i.name, i.value]), [['PRICE', 3.25], ['FLICKER', true], ['LIGHT', '#112233'], ['NAME', 'Glowworm']]);

  // With the copy shown they are over its page too, where it is seen to change; folded, it is one small button.
  await new Promise((r) => setTimeout(r, 150));
  canned.set('code.play', { url: 'http://localhost:5211/' });
  click(button('Play the copy', card));
  await until(() => frame.src === 'http://localhost:5211/', 'the frame to show the copy');
  await until(() => !$('#t-tweaks').hidden, 'the values over the page');
  assert.deepEqual(rows($('#t-tweaks')).map((r) => $('.tlabel', r).textContent), ['Lamp glow', 'Price', 'Flicker', 'Light', 'Name']);
  gave.length = 0;
  type(field('Lamp glow', '.slide', $('#t-tweaks')), '9');
  await until(() => sent().length === 1, 'it to be sent from there');
  assert.deepEqual(sent()[0], { file, name: 'GLOW', value: 9 });
  // What was turned there is on the card as well, and a page that does not follow its files is loaded anew.
  let loads = 0;
  const src = Object.getOwnPropertyDescriptor(w.HTMLIFrameElement.prototype, 'src')!;
  Object.defineProperty(frame, 'src', { configurable: true, get: () => src.get!.call(frame), set: (v) => { loads++; src.set!.call(frame, v); } });
  try {
    propose({ tweaked: { file, name: 'GLOW' } }, tweaks.map((t) => (t.name === 'GLOW' ? { ...t, value: 9, was: 4 } : t)));
    await until(() => field('Lamp glow', '.slide').value === '9', 'the card to follow');
    assert.equal(loads, 0, 'a page that follows its files is left to it');
    propose({ tweaked: { file, name: 'GLOW' }, anew: true }, tweaks.map((t) => (t.name === 'GLOW' ? { ...t, value: 8, was: 4 } : t)));
    await until(() => loads === 1, 'the copy\'s page to be loaded anew');
    assert.equal(frame.src, 'http://localhost:5211/');
  } finally { delete (frame as unknown as { src?: string }).src; }
  click($('#t-tweaks .fold'));
  assert.deepEqual([$('#t-tweaks .fold').textContent, $('#t-tweaks .tweaks').hidden], ['Turn · 5', true]);
  click($('#t-tweaks .fold'));
  assert.equal($('#t-tweaks .tweaks').hidden, false);
  // A value that is no longer there to turn is gone from both; back at the project, nothing is over the page.
  propose({}, [{ ...tweaks[0], value: 8, was: 4 }]);
  await until(() => rows().length === 1 && rows($('#t-tweaks')).length === 1, 'the one that is left');
  app.playProject();
  assert.ok($('#t-tweaks').hidden);
  // Decided, there is nothing to turn any more.
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'accepted', count: 1, paths: ['code:working copy'] });
  await until(() => card.dataset.status === 'accepted', 'the card to be put away');
  assert.equal(rows().length, 0);
  assert.equal($('.note.yours', card).textContent, 'You set Lamp glow to 8; the agent had 4.', 'accepted, the card says what they had set themselves');
  canned.delete('code.tweak'); canned.delete('code.play');
});

test('an example the agent made of its change is played from the card, beside the copy itself, and from one to the other over the page', async () => {
  await settle();
  tab('Chat');
  app.playProject();
  const example = { path: '/.tandem-scratch/example.html?case=late', text: 'the lamp at dusk' };
  const propose = (more: Record<string, unknown>) => host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc9', kind: 'code', path: 'working copy', files: [{ path: 'src/shop.js', added: 1, removed: 1, status: 'changed' }], note: 'Dusk comes earlier.', ...more });
  propose({});
  await until(() => all('.card.prop').some((c) => c.dataset.status === 'pending' && /Dusk comes earlier/.test(c.textContent!)), 'the card');
  const card = all('.card.prop').find((c) => c.dataset.status === 'pending' && /Dusk comes earlier/.test(c.textContent!))!;
  assert.deepEqual(all('.t-row button', card).map((b) => b.textContent), ['Play the copy', 'Accept', 'Reject'], 'without an example there is only the copy');
  propose({ example });
  await until(() => all('.t-row button', card).length === 4, 'the example to be offered');
  assert.deepEqual(all('.t-row button', card).map((b) => b.textContent), ['Play the copy', 'Play the example', 'Accept', 'Reject']);
  assert.equal($('.note.example', card).textContent, 'An example to play: the lamp at dusk');
  canned.set('code.play', { url: 'http://localhost:5211/' });
  try {
    // The example is a page of the copy: shown in the frame, with the tools out of the way, and said to be one.
    click(button('Play the example', card));
    await until(() => frame.src === 'http://localhost:5211/.tandem-scratch/example.html?case=late', 'the frame to show the example');
    assert.ok($('#t-sheet').classList.contains('shut'));
    assert.deepEqual([$('#t-copy').hidden, $('#t-copy span').textContent, $('#t-copy .swap').textContent], [false, 'An example', 'The copy itself']);
    // From there to the copy itself and back, without opening the tools.
    click($('#t-copy .swap'));
    await until(() => frame.src === 'http://localhost:5211/', 'the frame to show the copy itself');
    assert.deepEqual([$('#t-copy span').textContent, $('#t-copy .swap').textContent], ['The working copy', 'The example']);
    click($('#t-copy .swap'));
    await until(() => frame.src === 'http://localhost:5211/.tandem-scratch/example.html?case=late', 'the example again');
    // Decided, there is no example to go to any more.
    app.stage.showCopy('http://localhost:5211/');
    host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
    await until(() => card.dataset.status === 'rejected', 'the card to be put away');
    assert.ok($('#t-copy .swap').hidden || $('#t-copy').hidden);
  } finally { canned.delete('code.play'); app.playProject(); }
  // (The project's page is back before the next test starts talking to the frame.)
  await until(() => frame.src === 'http://localhost:5210/' && !frame.hidden, 'the frame to show the project again');
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

test('a tab that has to ask the core first says it is loading in the panel, not on the tab; opened again, it is there at once', async () => {
  app.open('chat');
  // (The Git tab was not opened before: there is nothing to show yet but that it is being asked.)
  const git = all('.t-tab').find((t) => t.textContent === 'Git')!;
  click(git);
  assert.ok(!git.classList.contains('working') && !(git as HTMLButtonElement).disabled, 'the tab stays a tab');
  assert.ok($('#t-body .loading .spin'), 'the panel says it is loading');
  await until(() => !$('#t-body .loading'), 'the panel to be drawn');
  assert.ok($('#t-body').childNodes.length > 0);
  // The chat is there at once: nothing to wait for.
  tab('Chat');
  assert.ok(!$('#t-body .loading'));
  // And a tab that was shown before is there at once too, as it was: what changed since is asked behind it.
  let before = ran.length;
  tab('Git');
  assert.ok(!$('#t-body .loading') && /No repository\./.test($('#t-body').textContent!), 'the Git tab as it was');
  await until(() => ran.slice(before).includes('git.status'), 'it to be asked again all the same');
  tab('Concepts');
  await until(() => !$('#t-body .loading'), 'the concepts');
  if ($('#t-body .bar button.link')) click($('#t-body .bar button.link'));
  await until(() => $('#t-body .adder.mind'), 'the document');
  tab('Chat');
  before = ran.length;
  tab('Concepts');
  assert.ok(!$('#t-body .loading') && $('#t-body .adder.mind'), 'the document as it was');
  await until(() => ran.slice(before).includes('concepts.list'), 'it to be asked again all the same');
  tab('Art');
  await until(() => !$('#t-body .loading'), 'the art');
  if ($('#t-body .bar button.link')) click($('#t-body .bar button.link'));
  await until(() => $('#t-body .item.drawing'), 'the drawings');
  tab('Chat');
  before = ran.length;
  tab('Art');
  assert.ok(!$('#t-body .loading') && $('#t-body .item.drawing'), 'the drawings as they were');
  await until(() => ran.slice(before).includes('art.list'), 'them to be asked again all the same');
  app.close();
});

test('a new conversation clears the chat and keeps what is still to be decided', async () => {
  await settle();
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
  if ((await host.run('proposals.list', { status: 'pending' }, 'me') as unknown[]).length) await host.run('proposals.decide', { accept: false }, 'me');
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
  const three = ['Heather', 'Gorse', 'Broom'];
  for (const name of three) await host.run('concepts.create', { name }, AGENT, 'r974');
  await until(() => app.events.filter((e) => e.type === 'proposal' && three.includes(String((e.after as { name?: string } | undefined)?.name))).length === 3, 'the three to arrive');
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
  assert.deepEqual(JSON.parse(w.localStorage.getItem('tandem-hidden:fixture')!), ['proposals'], 'and kept, for when the page is opened again');
  assert.equal((await host.run('proposals.list', { status: 'pending' }, 'me') as unknown[]).length, 1, 'it still waits');
  await host.run('concepts.create', { name: 'Rushes' }, AGENT, 'r975');
  await until(() => /A proposal · 2 changes/.test($('.bubble.waits b')?.textContent ?? ''), 'it to be back with what is new');
  click(button('Decline', $('.bubble.waits')));
  await until(() => !$('.bubble.waits'), 'the bubble to go');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('tandem-hidden:fixture')!), []);

  // A change to the project says how many files; a drawing worker's round says what it waits for.
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc9', kind: 'code', path: 'working copy', files: [{ path: 'a.ts' }, { path: 'b.ts' }], note: 'Seasons.' });
  await until(() => /A change to the project · 2 files/.test($('.bubble.waits b')?.textContent ?? ''), 'the change');
  // What the agent made is played from the bubble too, before it is answered: the copy, and its example when it made one.
  const labels = () => all('.bubble.waits button').map((x) => x.getAttribute('aria-label') ?? x.textContent);
  assert.deepEqual(labels(), ['Hide', 'Play', 'Approve', 'Decline']);
  host.events.add({ type: 'proposal', by: 'agent:main', round: 'code', id: 'pc9', kind: 'code', path: 'working copy', files: [{ path: 'a.ts' }, { path: 'b.ts' }], note: 'Seasons.', example: { path: '/.tandem-scratch/example.html' } });
  await until(() => labels().length === 5, 'the example to be offered');
  assert.deepEqual(labels(), ['Hide', 'Play', 'Example', 'Approve', 'Decline']);
  canned.set('code.play', { url: 'http://localhost:5211/' });
  click(button('Example', $('.bubble.waits')));
  await until(() => frame.src === 'http://localhost:5211/.tandem-scratch/example.html', 'the frame to show the example');
  click(button('Play', $('.bubble.waits')));
  await until(() => frame.src === 'http://localhost:5211/', 'the frame to show the copy itself');
  assert.ok($('.bubble.waits'), 'and it still waits for its answer');
  canned.delete('code.play');
  app.playProject();
  // A concept that waits with it is in the same bubble, with the same two answers: they are about all of it.
  await host.run('concepts.create', { name: 'Ivy' }, AGENT, 'r973');
  await until(() => /A change to the project · 2 files · 1 more/.test($('.bubble.waits b')?.textContent ?? ''), 'both in the one bubble');
  assert.equal(all('.bubble.waits').length, 1);
  assert.equal($('.bubble.waits.many'), null);
  click(button('Decline', $('.bubble.waits')));
  await until(() => !(host.proposals.list({ status: 'pending' })).length, 'what waited to be declined');
  assert.equal(host.concepts.get('ivy'), undefined);
  // (The change set here is only said, not kept: it is said to be decided the same way.)
  host.events.add({ type: 'proposal.decided', by: 'me', round: 'code', status: 'rejected', count: 1, paths: ['code:working copy'] });
  await until(() => !$('.bubble.waits'), 'it to be gone when decided');
  // A worker's round is the agent's to judge: it does not wait for the person. That one failed is said.
  const round = host.events.add({ type: 'art.round', by: 'agent:w1', worker: 'w1', name: 'gnome', state: 'waiting', phase: 'silhouette', text: 'The silhouette is ready.' });
  await until(() => app.events.some((e) => e.n === round.n), 'the round to come by');
  assert.equal($('.bubble.waits'), null);
  host.events.add({ type: 'art.round', by: 'agent:w1', worker: 'w1', name: 'gnome', state: 'failed', phase: 'color', text: 'The worker failed: the pencil broke' });
  await until(() => all('.bubble.says').some((b) => /The worker on gnome failed/.test(b.textContent!)), 'the failure to be said');

  // The offer to read a project that is new to tandem waits too, and can be put off.
  host.events.add({ type: 'welcome', by: 'engine', existing: true, files: 3, name: 'Fixture' });
  await until(() => /Fixture is new to tandem/.test($('.bubble.waits b')?.textContent ?? ''), 'the offer');
  click(button('Not now', $('.bubble.waits')));
  assert.ok(!$('.bubble.waits'));
  host.events.add({ type: 'chat.new', by: 'me' });
});

test('git: what is not committed is read and committed, what is not pushed is pushed, and what tandem does by itself is set there', async () => {
  // (This fixture is not looked after as a repository; what the core would say of one that is, is said for it.)
  const standing = (more: Record<string, unknown> = {}) => ({
    git: true, branch: 'main', files: [], branches: [{ name: 'main', current: true, ts: 1790000000000, subject: 'The first one' }, { name: 'feature/tide', current: false, ts: 1780000000000, subject: 'Half a tide', follows: 'origin/feature/tide', ahead: 3, behind: 1 }, { name: 'feature/far', current: false, ts: 1770000000000, subject: 'Far away', remote: 'origin' }], commits: [{ hash: 'abc1234def', ts: 1790000000000, by: 'Me', subject: 'The first one', pushed: true }],
    who: { name: 'Me', email: 'me@example.com' }, commit: true, push: true, ...more,
  });
  const changed = [{ path: 'src/game.ts', added: 2, removed: 1, status: 'changed' }, { path: 'src/tide.ts', added: 5, removed: 0, status: 'new' }];
  canned.set('git.status', standing({ files: changed }));
  tab('Git');
  const file = (path: string) => all('#t-body .gfile').find((x) => $('.frow', x)?.title === path)!;
  await until(() => file('src/tide.ts'), 'the files that are not committed');
  assert.match($('#t-body').textContent!, /main.*2 changed.*It has no remote: give it one below to push\..*Changes \(2\)\+7−1/);
  assert.match(file('src/game.ts').textContent!, /^Mgame\.tssrc\+2−1/);
  assert.match(file('src/tide.ts').textContent!, /^Atide\.tssrc\+5/);
  assert.equal(file('src/tide.ts').dataset.how, 'new');
  assert.match($('#t-body').textContent!, /Committed as Me <me@example\.com>/);

  // What changed outside tandem is seen when it is asked to look again.
  canned.set('git.status', standing({ files: [...changed, { path: 'README.md', added: 1, removed: 0, status: 'changed' }] }));
  click($('#t-body button[aria-label="Refresh"]'));
  await until(() => file('README.md'), 'the file that changed meanwhile');
  canned.set('git.status', standing({ files: changed }));
  click($('#t-body button[aria-label="Refresh"]'));
  await until(() => !file('README.md'), 'it to be gone again');

  // A file is read where it stands.
  canned.set('git.diff', { path: 'src/game.ts', diff: 'diff --git a/src/game.ts b/src/game.ts\n--- a/src/game.ts\n+++ b/src/game.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const season = 0;\n+const season = seasonOf(day);\n' });
  click($('.frow', file('src/game.ts')));
  await until(() => $('#t-body pre.diff'), 'the diff');
  assert.ok($('pre.diff', file('src/game.ts')), 'under the file it is of');
  assert.deepEqual(all('#t-body pre.diff span').map((x) => (x as HTMLElement).dataset.how), ['at', 'same', 'out', 'in']);

  // A commit needs a message; a file can be left out of it.
  const commit = () => all('#t-body .adder.commit button')[0] as HTMLButtonElement;
  assert.ok(commit().disabled, 'nothing to say yet');
  const box = $('input[aria-label="Commit src/tide.ts"]') as HTMLInputElement;
  box.checked = false;
  box.dispatchEvent(new w.Event('change'));
  await until(() => commit()?.textContent === 'Commit 1 of 2', 'the file to be left out');
  type($('textarea[aria-label="Commit message"]'), 'Seasons follow the day');
  assert.ok(!commit().disabled);
  canned.set('git.commit', { hash: 'fff0000aaa', subject: 'Seasons follow the day', files: 1 });
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 1, files: [changed[1]],
    commits: [{ hash: 'fff0000aaa', ts: 1790000100000, by: 'Me', subject: 'Seasons follow the day', pushed: false }, { hash: 'abc1234def', ts: 1790000000000, by: 'Me', subject: 'The first one', pushed: true }] }));
  let before = ran.length;
  click(commit());
  await until(() => /Committed 1 file\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.commit'));
  await until(() => /1 commit is not on origin yet/.test($('#t-body').textContent!), 'how it stands now');
  assert.equal(($('textarea[aria-label="Commit message"]') as HTMLTextAreaElement).value, '', 'the message went with the commit');
  // What the remote does not have yet stands out, and where it has the rest is marked.
  const item = all('#t-body .rev');
  assert.match(item[0].textContent!, /Seasons follow the dayfff0000 · /);
  assert.deepEqual(item.map((x) => x.classList.contains('ahead')), [true, false]);
  assert.equal($('#t-body .mark-remote').textContent, 'origin/main');
  assert.equal($('#t-body .mark-remote').nextElementSibling, item[1]);
  assert.match($('#t-body .standing').textContent!, /main↑11 changed/);

  // The remote is asked what it has, and how far behind the project is shows on the button that pulls.
  canned.set('git.fetch', { fetched: true, remote: 'origin', ahead: 1, behind: 2 });
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 1, behind: 2, files: [changed[1]],
    commits: [{ hash: 'fff0000aaa', ts: 1790000100000, by: 'Me', subject: 'Seasons follow the day', pushed: false }, { hash: 'abc1234def', ts: 1790000000000, by: 'Me', subject: 'The first one', pushed: true }] }));
  before = ran.length;
  click(button('Fetch', $('#t-body')));
  await until(() => /origin has 2 commits you do not have yet\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.fetch'));
  await until(() => button('Pull 2', $('#t-body')), 'how far behind it is');
  assert.match($('#t-body .standing').textContent!, /main↑1↓2/);

  // What the remote has more is pulled from here.
  canned.set('git.pull', { pulled: true, remote: 'origin', branch: 'main', commits: 2 });
  before = ran.length;
  click(button('Pull 2', $('#t-body')));
  await until(() => /Pulled 2 commits\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.pull'));
  host.events.add({ type: 'project.pulled', by: 'me', ok: true, remote: 'origin', branch: 'main', commits: 2 });

  // What is not pushed is pushed from here.
  canned.set('git.push', { pushed: true, remote: 'origin', branch: 'main' });
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, files: [changed[1]] }));
  before = ran.length;
  click(button('Push 1 commit', $('#t-body')));
  await until(() => /Pushed\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.push'));
  await until(() => /origin has everything that is committed/.test($('#t-body').textContent!), 'how it stands now');
  assert.ok((button('Push', $('#t-body')) as HTMLButtonElement).disabled);

  // Everything that is checked is thrown away at once, after asking with how many it is.
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, files: changed }));
  tab('Chat'); tab('Git');
  await until(() => file('src/game.ts') && file('src/tide.ts'), 'two changes again');
  const leave = $('input[aria-label="Commit src/tide.ts"]') as HTMLInputElement;
  leave.checked = false;
  leave.dispatchEvent(new w.Event('change'));
  click(button('Discard 1 checked', $('#t-body')));
  assert.match($('#t-body .discard').textContent!, /Throw away 1 of 2 changes\? It cannot be brought back\.YesNo/);
  canned.set('git.discard', { discarded: ['src/game.ts'] });
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, files: [changed[1]] }));
  before = ran.length;
  click($('button[aria-label="Yes, discard what is checked"]'));
  await until(() => /1 change is thrown away\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.discard'));
  await until(() => !file('src/game.ts') && file('src/tide.ts'), 'the one that was left out to stay');

  // A change is thrown away per file, after asking.
  canned.set('git.discard', { path: 'src/tide.ts', was: 'new' });
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, behind: 0 }));
  before = ran.length;
  click($('button[aria-label="Discard src/tide.ts"]'));
  assert.match(file('src/tide.ts').textContent!, /Delete it\?YesNo$/, 'asked once more, in its row');
  assert.ok(!ran.slice(before).includes('git.discard'), 'nothing is thrown away yet');
  click($('button[aria-label="No, keep it"]'));
  assert.doesNotMatch(file('src/tide.ts').textContent!, /Delete it/);
  click($('button[aria-label="Discard src/tide.ts"]'));
  click($('button[aria-label="Yes, discard src/tide.ts"]'));
  await until(() => /It is gone\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.discard'));
  await until(() => /Everything in the project is committed\./.test($('#t-body').textContent!), 'nothing to be left');
  assert.match($('#t-body .standing').textContent!, /main.*clean/);

  // The branches: the one it is on, and the others when asked for.
  assert.deepEqual(all('#t-body .branch').map((x) => $('b', x).textContent), ['main']);
  assert.match($('#t-body').textContent!, /Branches \(3\)/);
  click(button('Show all', $('#t-body')));
  await until(() => all('#t-body .branch').length === 3, 'the other branches');
  // One that is only on the remote says so, and can be switched to all the same.
  assert.match(all('#t-body .branch')[2].textContent!, /feature\/faroriginonly on origin · .* · Far awaySwitch/);
  assert.match(all('#t-body .branch')[1].textContent!, /feature\/tide↑3↓1follows origin\/feature\/tide · .* · Half a tide/);
  assert.ok(all('#t-body .branch')[0].classList.contains('current'));
  // Another branch is switched to from here, when nothing is uncommitted.
  assert.ok(!$('.branch.current button.switch'), 'not to the one it is on');
  const sw = () => $('button[aria-label="Switch to feature/tide"]') as HTMLButtonElement;
  assert.ok(!sw().disabled);
  canned.set('git.switch', { from: 'main', branch: 'feature/tide' });
  canned.set('git.status', standing({ branch: 'feature/tide', remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 3, behind: 1,
    branches: [{ name: 'feature/tide', current: true, ts: 1780000000000, subject: 'Half a tide', follows: 'origin/feature/tide', ahead: 3, behind: 1 }, { name: 'main', current: false, ts: 1790000000000, subject: 'The first one' }] }));
  before = ran.length;
  click(sw());
  await until(() => /The project is on feature\/tide now\./.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('git.switch'));
  await until(() => /feature\/tide↑3↓1/.test($('#t-body .standing').textContent!), 'the branch it is on now');
  // With something uncommitted the button is off, and says why.
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, behind: 0, files: [changed[0]] }));
  host.events.add({ type: 'project.switched', by: 'me', branch: 'main', from: 'feature/tide' });
  await until(() => file('src/game.ts'), 'the change');
  click(button('Show all', $('#t-body')));
  assert.ok(sw().disabled);
  assert.match($('#t-body').textContent!, /To switch to another branch, commit or throw away what you changed first\./);
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, behind: 0 }));
  host.events.add({ type: 'project.committed', by: 'me', hash: 'eee', subject: 'x', files: 1 });
  await until(() => !file('src/game.ts'), 'it to be clean again');

  // Where it is pushed is set here.
  const field = () => $('.adder.remote input') as HTMLInputElement;
  assert.equal(field().value, 'https://example.com/me/fixture.git');
  assert.match($('#t-body').textContent!, /main is pushed there after every accept/);
  type(field(), 'https://example.com/me/other.git');
  canned.set('project.setRemote', { url: 'https://example.com/me/other.git', pushed: true });
  before = ran.length;
  click(button('Save', $('.adder.remote')));
  await until(() => /It is set, and the project is pushed there/.test($('#t-toast').textContent!), 'it to say so');
  assert.ok(ran.slice(before).includes('project.setRemote'));

  // And whether tandem commits and pushes by itself.
  const keep = (label: string) => $(`.keep input[aria-label="${label}"]`) as HTMLInputElement;
  await until(() => keep('Commit what is accepted'), 'the switches');
  assert.ok(keep('Commit what is accepted').checked && keep('Push after every accept').checked, 'both, unless said not to');
  canned.set('project.keep', { changed: true, commit: false, push: true });
  canned.set('git.status', standing({ remote: { name: 'origin', url: 'https://example.com/me/fixture.git' }, ahead: 0, commit: false }));
  before = ran.length;
  keep('Commit what is accepted').checked = false;
  keep('Commit what is accepted').dispatchEvent(new w.Event('change'));
  await until(() => /left uncommitted: committing and pushing are yours, here/.test($('#t-body').textContent!), 'what it means');
  assert.ok(ran.slice(before).includes('project.keep'));
  assert.ok(!keep('Commit what is accepted').checked);
  assert.ok(!keep('Push after every accept').checked && keep('Push after every accept').disabled, 'what is not committed is not pushed');
  assert.doesNotMatch($('#t-body').textContent!, /pushed there after every accept/);

  // What happened is a line in the conversation, and the panel follows what happens elsewhere.
  canned.set('git.status', standing({ files: [changed[0]], commit: false }));
  host.events.add({ type: 'project.committed', by: 'me', hash: 'fff0000aaa', subject: 'Seasons follow the day', files: 1 });
  await until(() => file('src/game.ts'), 'the panel to look again');
  host.events.add({ type: 'keep.changed', by: 'me', commit: false, push: true });
  host.events.add({ type: 'project.pushed', by: 'me', ok: true, remote: 'origin', branch: 'main' });
  host.events.add({ type: 'project.pushed', by: 'me', ok: false, remote: 'origin', branch: 'main', says: 'rejected (fetch first)' });
  host.events.add({ type: 'project.discarded', by: 'me', path: 'src/tide.ts', was: 'new' });
  tab('Chat');
  await until(() => all('.chat .sys.fail').some((x) => /committed, but could not be pushed to origin: rejected \(fetch first\)/.test(x.textContent!)), 'the push that did not go');
  assert.ok(all('.chat .sys').some((x) => /pushed to origin \(main\)/.test(x.textContent!)));
  assert.ok(all('.chat .sys').some((x) => /pulled 2 commits from origin \(main\)/.test(x.textContent!)));
  assert.ok(all('.chat .sys').some((x) => /you committed 1 file: Seasons follow the day/.test(x.textContent!)));
  assert.ok(all('.chat .sys').some((x) => /you threw away what was not committed in src\/tide\.ts/.test(x.textContent!)));
  assert.ok(all('.chat .sys').some((x) => /no longer commits in the project or pushes it/.test(x.textContent!)));

  // A project that is not in a repository says so.
  canned.set('git.status', { git: false });
  tab('Git');
  await until(() => /No repository\./.test($('#t-body').textContent!), 'it to say so');
  for (const k of ['git.status', 'git.diff', 'git.commit', 'git.push', 'git.pull', 'git.fetch', 'git.switch', 'git.discard', 'project.setRemote', 'project.keep']) canned.delete(k);
  tab('Chat');
});

test('projects: the folders that could be one are listed, and another is chosen from the page', async () => {
  // Next to the project there is another one, and a folder that is not a repository yet.
  const beside = join(dir, '..');
  mkdirSync(join(beside, 'other-game/.git'), { recursive: true });
  writeFileSync(join(beside, 'other-game/tandem.json'), JSON.stringify({ name: 'The Other Game', page: 'serve {port}' }));
  mkdirSync(join(beside, 'loose-notes'));
  // The last of the tabs is where another project is opened.
  tab('Projects');
  await until(() => all('.item.project').length >= 3, 'the folders');
  assert.equal($('.t-tab.on').textContent, 'Projects');
  // (Beside the tabs are the settings, which are not a tab: what the person sets for this browser. Sound is off.)
  click($('button[aria-label="Settings"]'));
  assert.equal(all('.t-tab.on').length, 0, 'none of the tabs is the one showing');
  assert.equal(($('input[aria-label="Sound"]') as HTMLInputElement).checked, false);
  // (And which model the agent and the workers run on, each with its own effort: for every project.)
  await until(() => all('select[aria-label="Agent model"]').length === 1, 'the models');
  const agentModel = $('select[aria-label="Agent model"]') as HTMLSelectElement;
  agentModel.value = 'claude-opus-5-5';
  agentModel.dispatchEvent(new w.Event('change'));
  const workersEffort = $('select[aria-label="Workers effort"]') as HTMLSelectElement;
  workersEffort.value = 'max';
  workersEffort.dispatchEvent(new w.Event('change'));
  await until(() => gave.filter(([n]) => n === 'models.set').length === 2, 'both to be chosen');
  assert.deepEqual(gave.filter(([n]) => n === 'models.set').map(([, i]) => i), [{ who: 'agent', model: 'claude-opus-5-5' }, { who: 'workers', effort: 'max' }]);
  await until(() => { try { return JSON.parse(readFileSync(process.env.TANDEM_STATE!, 'utf8')).models?.workers?.effort === 'max'; } catch { return false; } }, 'it to be kept');
  tab('Projects');
  await until(() => all('.item.project').length >= 3, 'the folders again');
  const item = (name: string) => all('.item.project').find((i) => $('b', i).textContent === name)!;
  assert.equal(all('.item.project')[0], item('Fixture'), 'the one that is open comes first');
  assert.match(item('Fixture').textContent!, /open now/);
  assert.match(item('The Other Game').textContent!, /new to tandem · has a page/);
  assert.match(item('loose-notes').textContent!, /no git repository yet: tandem starts one when you open it/);
  // The list is narrowed to what is typed, a part of a name or of a folder, and the field keeps it.
  const narrow = () => $('input[aria-label="Filter the projects"]') as HTMLInputElement;
  type(narrow(), 'other gam');
  assert.deepEqual(all('.item.project').map((i) => $('b', i).textContent), ['The Other Game']);
  type(narrow(), 'no such thing');
  assert.equal(all('.item.project').length, 0);
  assert.match($('#t-body').textContent!, /Nothing called that\. \d+ folders are left out\./);
  type(narrow(), 'LOOSE');
  assert.deepEqual(all('.item.project').map((i) => $('b', i).textContent), ['loose-notes']);
  type(narrow(), '');
  assert.ok(all('.item.project').length >= 3);
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
  tab('Projects');
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
  tab('Projects');
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

test('what is said in the chat is markdown, and nothing in it is taken for HTML', async () => {
  const { prose } = await import('../shell/dom.ts');
  const html = (text: string) => prose(text).innerHTML;
  assert.equal(html('One line\nand the next.\n\nA new paragraph.'), '<p>One line<br>and the next.</p><p>A new paragraph.</p>');
  assert.equal(html('**bold**, *slanted*, _also_, ~~gone~~ and `a * b` in code'), '<p><b>bold</b>, <i>slanted</i>, <i>also</i>, <s>gone</s> and <code>a * b</code> in code</p>');
  assert.equal(html('2 * 3 * 4 and snake_case_name stay as they are'), '<p>2 * 3 * 4 and snake_case_name stay as they are</p>');
  assert.equal(html('## What changed\nThe shadows.'), '<h4 class="h2">What changed</h4><p>The shadows.</p>');
  assert.equal(html('See [the docs](https://example.com/a_b) or https://example.com/x.'),
    '<p>See <a href="https://example.com/a_b" target="_blank" rel="noopener noreferrer">the docs</a> or <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.</p>');
  assert.equal(html('[not this](javascript:alert(1)) <img src=x onerror=alert(1)>'), '<p>[not this](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(html('Steps:\n- first\n- second\n  - inside it\n- third'), '<p>Steps:</p><ul><li>first</li><li>second<ul><li>inside it</li></ul></li><li>third</li></ul>');
  assert.equal(html('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(html('| dice | ms |\n|---|---|\n| 5 d6 | **2** |\n| 20 d20 |'), '<div class="table"><table><thead><tr><th>dice</th><th>ms</th></tr></thead><tbody><tr><td>5 d6</td><td><b>2</b></td></tr><tr><td>20 d20</td><td></td></tr></tbody></table></div>');
  assert.equal(html('> quoted\n> twice\n\n---\nafter'), '<blockquote><p>quoted<br>twice</p></blockquote><hr><p>after</p>');
  assert.equal(html('```js\nconst a = `**not bold**` < 2\n```\nthen'), '<pre>const a = `**not bold**` &lt; 2</pre><p>then</p>');
});

test('views: a tab over the stage for each; a view asks only for what a view may, and what is in it is pointed at', async () => {
  app.close();
  await host.run('project.configure', { views: [{ name: 'Logs', kind: 'logs' }, { name: 'Notes', kind: 'data', file: 'notes.db' }] }, 'me');
  await until(() => !$('#t-views').hidden && all('#t-views .t-vtab').length === 3, 'the tabs to be there');
  assert.deepEqual(all('#t-views .t-vtab').map((b) => b.textContent), ['Page', 'Logs', 'Notes']);
  assert.equal($('#t-views .t-vtab.on').textContent, 'Page', 'the page is what is shown');
  assert.ok(!$('iframe.t-view'), 'a view\'s frame is made when it is first shown');

  click(all('#t-views .t-vtab')[1]);
  const view = $('iframe.t-view') as HTMLIFrameElement;
  assert.equal(view.getAttribute('sandbox'), 'allow-scripts allow-forms allow-modals allow-popups', 'in a sandbox: it cannot reach tandem by itself');
  assert.match(view.getAttribute('src')!, /^\/api\/view\/Logs$/);
  assert.equal(app.stage.tab, 'Logs');
  assert.ok($('#root').classList.contains('t-on-view'));

  // It asks through tandem's page, and only for what a view may.
  const toView: any[] = [];
  view.contentWindow!.postMessage = ((m: unknown) => { toView.push(m); }) as never;
  const fromView = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data: { tandem: 1, ...data }, source: view.contentWindow }));
  ran.length = 0;
  fromView({ type: 'run', id: 1, name: 'logs.read', input: {} });
  fromView({ type: 'run', id: 2, name: 'proposals.decide', input: { accept: true } });
  await until(() => toView.filter((m) => m.type === 'ran').length === 2, 'both to be answered');
  assert.equal(toView.find((m) => m.id === 1).ok, true);
  assert.deepEqual([toView.find((m) => m.id === 2).ok, toView.find((m) => m.id === 2).code], [false, 'permission']);
  assert.deepEqual(ran, ['logs.read'], 'what a view may not ask for is not asked of the core');

  // Pointed at: what is under the finger in the view, and which view goes with it.
  fromView({ type: 'page', can: { find: true } });
  view.getBoundingClientRect = () => ({ left: 0, top: 36, width: 360, height: 600, right: 360, bottom: 636, x: 0, y: 36, toJSON() {} });
  const fab = $('#t-fab');
  const pointer = (type: string, x: number, y: number) => { const ev = new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }); Object.defineProperty(ev, 'pointerId', { value: 1 }); fab.dispatchEvent(ev); };
  const line = { x: 0, y: 64, w: 360, h: 18, words: 'fail: broke', tag: 'div', selector: 'main > div:nth-child(3)', path: '/api/view/Logs' };
  const answer = async () => {
    await until(() => toView.some((m) => m.type === 'pick'), 'the view to be asked what is there');
    const asked = toView.filter((m) => m.type === 'pick');
    toView.length = 0;
    for (const m of asked) fromView({ type: 'picked', id: m.id, ...line });
    return asked.at(-1);
  };
  app.refs.length = 0;
  pointer('pointerdown', 340, 60);
  pointer('pointermove', 100, 136);
  assert.deepEqual([(await answer()).x, 100], [100, 100]);
  pointer('pointerup', 100, 136);
  await answer();
  await until(() => app.refs.length === 1, 'the line to go with the next message');
  assert.deepEqual(JSON.parse(app.refs[0].slice('page:'.length)), { words: 'fail: broke', tag: 'div', selector: 'main > div:nth-child(3)', path: '/api/view/Logs', view: 'Logs' });
  assert.match($('.t-chip.ref[data-kind=page]').textContent!, /in Logs: "fail: broke"/);
  app.refs.length = 0;
  app.close();

  // The agent looks at a view as the person sees it: its tab is shown for that.
  const looking = host.run('page.look', { view: 'Notes' }, AGENT) as Promise<any>;
  await until(() => app.stage.tab === 'Notes', 'the view to be shown');
  const notes = all('iframe.t-view').find((f) => f.title === 'Notes') as HTMLIFrameElement;
  const toNotes: any[] = [];
  notes.contentWindow!.postMessage = ((m: unknown) => { toNotes.push(m); }) as never;
  const fromNotes = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data: { tandem: 1, ...data }, source: notes.contentWindow }));
  fromNotes({ type: 'page', can: { find: true } });
  await until(() => toNotes.some((m) => m.type === 'do'), 'the view to be asked');
  fromNotes({ type: 'did', id: toNotes.find((m) => m.type === 'do').id, path: '/api/view/Notes', title: 'Data', lines: ['notes 2'] });
  const seen = await looking;
  assert.equal(seen.view, 'Notes');
  assert.match(seen.page, /notes 2/);

  // Back to the page; and the views taken away again, the tabs go with them.
  click(all('#t-views .t-vtab')[0]);
  assert.equal(app.stage.tab, null);
  assert.ok(view.hidden);
  await host.run('project.configure', { views: [] }, 'me');
  await until(() => $('#t-views').hidden, 'the tabs to go');
  assert.ok(!$('iframe.t-view'));
  assert.ok(!w.document.body.classList.contains('t-viewed'));
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
