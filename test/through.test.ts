// A project's page goes through tandem: as it is, with tandem's few lines
// added, and those lines find something on a page by the words on it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startThrough, withTandem } from '../core/through.ts';

const PAGE = '<!doctype html><html><head><title>A page</title></head><body><h1>Lots</h1></body></html>';
const inner: Server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"abc"', 'content-length': String(Buffer.byteLength(PAGE)) }); return void res.end(PAGE); }
  if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', etag: '"js"' }); return void res.end('export const a = "</head>";\n'); }
  if (req.url === '/save' && req.method === 'POST') { let body = ''; req.on('data', (d) => { body += d; }); return void req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: body, enc: req.headers['accept-encoding'] ?? null })); }); }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<p>nothing here</p>');
});
// A live connection (a page's reload socket): what comes is sent back.
inner.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (d) => socket.write(`echo:${d}`));
});
await new Promise<void>((r) => inner.listen(0, '127.0.0.1', r));
const to = (inner.address() as AddressInfo).port;
const through = await startThrough({ port: 0, to });
const port = (through.address() as AddressInfo).port;
const at = `http://127.0.0.1:${port}`;
after(() => { through.close(); inner.close(); inner.closeAllConnections(); through.closeAllConnections(); });

test('a page of HTML gets tandem\'s line, once; everything else passes as it is', async () => {
  const page = await fetch(`${at}/`);
  const html = await page.text();
  assert.equal(html, PAGE.replace('</head>', '<script src="/__tandem/page.js"></script></head>'));
  assert.equal(page.headers.get('content-length'), String(Buffer.byteLength(html)));
  assert.equal(page.headers.get('etag'), null, 'the page is not what its tag says any more');
  const js = await fetch(`${at}/app.js`);
  assert.equal(await js.text(), 'export const a = "</head>";\n', 'what is not a page is not touched');
  assert.equal(js.headers.get('etag'), '"js"');
  const missing = await fetch(`${at}/nowhere`);
  assert.equal(missing.status, 404);
  const saved = await (await fetch(`${at}/save`, { method: 'POST', body: 'x=1', headers: { 'accept-encoding': 'gzip' } })).json();
  assert.deepEqual(saved, { got: 'x=1', enc: null }, 'a body goes along, and the answer is asked for as it is');
  assert.equal(await (await fetch(`${at}/__tandem/page.js`)).text(), readFileSync(new URL('../bridge/page.js', import.meta.url), 'utf8'));
  assert.equal(withTandem(html), html, 'never twice');
  assert.equal(withTandem('<p>bare</p>'), '<p>bare</p><script src="/__tandem/page.js"></script>');
});

test('a live connection is passed on both ways', async () => {
  const got = await new Promise<string>((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write('GET /ws?token=1 HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    let all = '';
    s.on('data', (d) => {
      all += d;
      if (/101 Switching Protocols\r\n[\s\S]*\r\n\r\n$/.test(all)) s.write('ping');
      if (all.endsWith('echo:ping')) { s.destroy(); resolve(all); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error(`no answer: ${all}`)), 5000).unref();
  });
  assert.match(got, /^HTTP\/1\.1 101 Switching Protocols/);
});

test('a page that is not up does not answer here either', async () => {
  const nowhere = await startThrough({ port: 0, to: 1 });
  try { await assert.rejects(fetch(`http://127.0.0.1:${(nowhere.address() as AddressInfo).port}/`)); }
  finally { nowhere.close(); nowhere.closeAllConnections(); }
});

test('tandem\'s lines in a page find a thing by the words on it, or by a selector', async () => {
  // The page in a frame, as tandem shows it; what it says to tandem is caught.
  const dom = new JSDOM('<iframe></iframe>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frame = dom.window.document.querySelector('iframe')!.contentWindow as unknown as Window & { eval(s: string): void };
  frame.document.body.innerHTML = `
    <header><h1>Lots to draw</h1></header>
    <main><p>Make a group for the family, then share the link.</p>
      <label>Name of the group <input placeholder="Christmas at gran's"></label>
      <button class="go"><span>Make a group</span></button>
      <button class="gone" style="display:none">Make a group</button>
      <img alt="A knitted band">
    </main>`;
  // (This stand-in for a browser lays nothing out: everything is given a size, and moving to a thing is nothing.)
  const proto = (frame as unknown as { Element: { prototype: Element } }).Element.prototype;
  proto.getBoundingClientRect = function (this: Element) { return { left: 5, top: 7, width: this.tagName === 'BUTTON' ? 120 : 300, height: 40, right: 0, bottom: 0, x: 5, y: 7, toJSON() {} }; };
  let moved: Element | undefined;
  proto.scrollIntoView = function (this: Element) { moved = this; };
  // (What the page says is made in its own world; it is taken over as plain data.)
  const said: any[] = [];
  dom.window.addEventListener('message', (ev) => said.push(JSON.parse(JSON.stringify(ev.data))));
  frame.eval(readFileSync(new URL('../bridge/page.js', import.meta.url), 'utf8'));
  const wait = async (what: () => unknown) => { for (let i = 0; i < 100 && !what(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(what(), 'the page answered'); };
  await wait(() => said.some((m) => m.type === 'page'));
  assert.deepEqual(said.find((m) => m.type === 'page'), { tandem: 1, type: 'page', can: { find: true, act: true } });

  let n = 0;
  const find = async (words: string) => {
    const id = ++n;
    frame.dispatchEvent(new (frame as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data: { tandem: 1, type: 'find', id, at: words }, source: dom.window as never }));
    await wait(() => said.some((m) => m.type === 'found' && m.id === id));
    return said.find((m) => m.type === 'found' && m.id === id);
  };
  // The words on a button, however they are cased: the button's own text, not the paragraph that also has them, and
  // not the one that cannot be seen.
  assert.deepEqual(await find('make a GROUP'), { tandem: 1, type: 'found', id: 1, x: 5, y: 7, w: 300, h: 40 });
  assert.equal(moved?.tagName, 'SPAN', 'the innermost thing that says just that; the page moved to it');
  // What a field is called when nothing is written on it, a picture by what it shows, and a selector.
  await find("Christmas at gran's");
  assert.equal(moved?.tagName, 'INPUT');
  await find('a knitted band');
  assert.equal(moved?.tagName, 'IMG');
  assert.equal((await find('button.go')).w, 120);
  assert.equal(moved?.className, 'go');
  assert.deepEqual(await find('Draw the names'), { tandem: 1, type: 'found', id: 5, missing: true });

  // The other way round: the person points, and the page says what is at that place. The thing a person would
  // name, not the bit of it under the finger; with a name the code can be searched for.
  const span = frame.document.querySelector('button.go span')!;
  let under: Element | null = span;
  (frame.document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => under;
  const pick = async () => {
    const id = ++n;
    frame.dispatchEvent(new (frame as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data: { tandem: 1, type: 'pick', id, x: 50, y: 60 }, source: dom.window as never }));
    await wait(() => said.some((m) => m.type === 'picked' && m.id === id));
    const { tandem: _t, type: _y, id: _i, ...rest } = said.find((m) => m.type === 'picked' && m.id === id);
    return rest;
  };
  assert.deepEqual(await pick(), { x: 5, y: 7, w: 120, h: 40, words: 'Make a group', tag: 'button', selector: 'main > button.go', path: 'blank' });
  under = frame.document.querySelector('h1');
  assert.deepEqual([(await pick()).words, (await pick()).selector], ['Lots to draw', 'header > h1']);
  under = frame.document.querySelector('input');
  assert.deepEqual([(await pick()).words, (await pick()).tag], ["Christmas at gran's", 'input'], 'a field is itself, named by what it shows');
  under = frame.document.body;
  assert.deepEqual(await pick(), { missing: true }, 'the bare page is nothing to point at');

  // And the agent uses the page as a person would. What is on it, as lines:
  const act = async (what: Record<string, unknown>) => {
    const id = ++n;
    frame.dispatchEvent(new (frame as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data: { tandem: 1, type: 'do', id, ...what }, source: dom.window as never }));
    await wait(() => said.some((m) => m.type === 'did' && m.id === id));
    const { tandem: _t, type: _y, id: _i, ...rest } = said.find((m) => m.type === 'did' && m.id === id);
    return rest;
  };
  const seen = await act({ do: 'look' });
  assert.equal(seen.ok, true);
  assert.deepEqual(seen.lines, [
    '# Lots to draw',
    'Make a group for the family, then share the link.',
    '[field] Name of the group: empty (shows "Christmas at gran\'s")',
    '[button] Make a group',
    '[picture] A knitted band',
  ], 'what a person would read it by; not what cannot be seen');
  // A field is filled in by what it is called, in a way the page notices.
  const input = frame.document.querySelector('input')!;
  const noticed: string[] = [];
  for (const type of ['input', 'change']) input.addEventListener(type, () => noticed.push(type));
  const typed = await act({ do: 'type', at: 'name of the group', text: 'Gran and all' });
  assert.deepEqual([typed.ok, typed.did, input.value, noticed], [true, 'filled in "Name of the group"', 'Gran and all', ['input', 'change']]);
  assert.match((await act({ do: 'look' })).lines[2], /\[field\] Name of the group: "Gran and all"/);
  assert.deepEqual(await act({ do: 'type', at: 'Surname', text: 'x' }), { ok: false, error: 'there is no field on the page called "Surname"' });
  // A button is tapped by the words on it: the button, not the letters; a moment later, so the person sees which.
  let tapped = 0;
  frame.document.querySelector('button.go')!.addEventListener('click', () => { tapped++; });
  const tap = await act({ do: 'tap', at: 'Make a group' });
  assert.deepEqual([tap.ok, tap.did, tap.w, tapped], [true, 'tapped button "Make a group"', 120, 0]);
  await wait(() => tapped === 1);
  assert.equal((await act({ do: 'tap', at: 'Draw the names' })).ok, false);
  assert.deepEqual(await act({ do: 'go', path: 'https://elsewhere.example/' }), { ok: false, error: 'a place in this app starts with / (or ? or #)' });
  dom.window.close();
});
