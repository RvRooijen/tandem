// A project's page goes through tandem: as it is, with tandem's few lines
// added, and those lines find something on a page by the words on it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { innerPort, startThrough, withTandem } from '../core/through.ts';

const PAGE = '<!doctype html><html><head><title>A page</title></head><body><h1>Lots</h1></body></html>';
const inner: Server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"abc"', 'content-length': String(Buffer.byteLength(PAGE)) }); return void res.end(PAGE); }
  if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', etag: '"js"' }); return void res.end('export const a = "</head>";\n'); }
  if (req.url === '/save' && req.method === 'POST') { let body = ''; req.on('data', (d) => { body += d; }); return void req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: body, enc: req.headers['accept-encoding'] ?? null })); }); }
  // A page that forbids being shown in another page's frame, the way ASP.NET does by itself.
  if (req.url === '/strict') { res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }); return void res.end(PAGE); }
  if (req.url === '/strict.json') { res.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }); return void res.end('{}'); }
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
  assert.equal(await (await fetch(`${at}/__tandem/page.js`)).text(), ['scene.js', 'page.js'].map((f) => readFileSync(new URL(`../bridge/${f}`, import.meta.url), 'utf8')).join(''), 'tandem\'s lines: those for a scene first, then those for the page');
  assert.equal(withTandem(html), html, 'never twice');
  assert.equal(withTandem('<p>bare</p>'), '<p>bare</p><script src="/__tandem/page.js"></script>');
});

test('a page that forbids being shown in a frame can be shown in tandem\'s; the rest of its policy stays', async () => {
  const page = await fetch(`${at}/strict`);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.equal(page.headers.get('content-security-policy'), "default-src 'self'");
  const other = await fetch(`${at}/strict.json`);
  assert.equal(other.headers.get('x-frame-options'), null);
  assert.equal(other.headers.get('content-security-policy'), null, 'a policy that said nothing else is gone');
});

test('the project\'s page and the working copy\'s are started far enough apart for each to count up from its own port', () => {
  // (A page that needs a server beside it, or a database, takes the ports after its own: the two must not meet.)
  assert.deepEqual([innerPort(5210), innerPort(5211, true)], [7210, 7310]);
  assert.ok(innerPort(5211, true) - innerPort(5210) >= 100);
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
  // (Something that hangs up at once stands in for it: a port with nothing on it is not refused everywhere, and
  // where it is not, finding that out takes minutes.)
  const down = createNetServer((socket) => socket.destroy());
  await new Promise<void>((r) => down.listen(0, '127.0.0.1', r));
  const nowhere = await startThrough({ port: 0, to: (down.address() as AddressInfo).port });
  try { await assert.rejects(fetch(`http://127.0.0.1:${(nowhere.address() as AddressInfo).port}/`)); }
  finally { nowhere.close(); nowhere.closeAllConnections(); down.close(); }
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
    </main>
    <section>
      <div class="card"><div class="slot"><canvas></canvas></div><div class="name">Haunted Manor</div></div>
      <div class="card"><div class="slot"><canvas></canvas></div><div class="name">Coven</div></div>
      <h2>Your board</h2>
      <canvas class="board"></canvas>
      <p>Tap a stack to lift it and tap a cell to put it down; three of a colour on top of each other clear, and what was under them comes up for the next move.</p>
    </section>`;
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
  assert.deepEqual(await pick(), { x: 5, y: 7, w: 120, h: 40, words: 'Make a group', near: 'Make a group for the family, then share the link. Name of the group Make a group Make a group', tag: 'button', selector: 'main > button.go', path: 'blank' });
  under = frame.document.querySelector('h1');
  assert.deepEqual([(await pick()).words, (await pick()).selector], ['Lots to draw', 'header > h1']);
  under = frame.document.querySelector('input');
  assert.deepEqual([(await pick()).words, (await pick()).tag], ["Christmas at gran's", 'input'], 'a field is itself, named by what it shows');
  // What says nothing itself is told apart by what is written around it: the card a picture is on, or, where the
  // thing it is in says too much to be about it, what stands just before and after it.
  under = frame.document.querySelectorAll('.card canvas')[1];
  assert.deepEqual([(await pick()).words, (await pick()).near, (await pick()).tag], ['', 'Coven', 'canvas'], 'the second card\'s picture, by the name on its card');
  under = frame.document.querySelector('canvas.board');
  assert.equal((await pick()).near, 'Your board … Tap a stack to lift it and tap a cell to put it down; three of a colour on top …');
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
    'Haunted Manor',
    'Coven',
    '## Your board',
    'Tap a stack to lift it and tap a cell to put it down; three of a colour on top of each other clear, and what was under them comes up for the next move.',
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
  // While the agent has the page it taps a place in its picture of the page: what is there gets what a finger gives.
  const board = frame.document.querySelector('canvas.board')!;
  under = board;
  const got: string[] = [];
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) board.addEventListener(type, (e) => got.push(`${type} ${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`));
  const placed = await act({ do: 'tap', x: 100, y: 200 });
  assert.deepEqual([placed.ok, placed.did, placed.x, placed.y, placed.w], [true, 'tapped at 100, 200, on a canvas', 84, 184, 32]);
  await wait(() => got.length === 4);
  assert.deepEqual(got, ['pointerdown 100,200', 'mousedown 100,200', 'mouseup 100,200', 'click 100,200']);
  under = null;
  assert.equal((await act({ do: 'tap', x: 5000, y: 5000 })).ok, false, 'nothing is there');
  assert.deepEqual(await act({ do: 'go', path: 'https://elsewhere.example/' }), { ok: false, error: 'a place in this app starts with / (or ? or #)' });
  dom.window.close();
});

test('in a scene three.js draws, what is pointed at is the thing in the scene: what it is, where, and which one of those like it', async () => {
  const dom = new JSDOM('<iframe></iframe>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const frame = dom.window.document.querySelector('iframe')!.contentWindow as unknown as Window & { eval(s: string): void; __THREE_DEVTOOLS__: EventTarget };
  frame.document.body.innerHTML = '<div id="app"><canvas></canvas></div>';
  const canvas = frame.document.querySelector('canvas')!;
  (frame as unknown as { Element: { prototype: Element } }).Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
  (frame.document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => canvas;
  canvas.scrollIntoView = () => {};
  (canvas as unknown as { getContext: unknown }).getContext = () => null;
  const said: any[] = [];
  dom.window.addEventListener('message', (ev) => said.push(JSON.parse(JSON.stringify(ev.data))));
  for (const f of ['scene.js', 'page.js']) frame.eval(readFileSync(new URL(`../bridge/${f}`, import.meta.url), 'utf8'));
  const wait = async (what: () => unknown) => { for (let i = 0; i < 100 && !what(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(what(), 'the page answered'); };

  // A scene as three keeps one, as far as tandem reads it: a table, and two small things alike in front of it,
  // seen by a camera at the middle that looks down the z axis (a quarter turn wide, on a canvas of 4 by 3).
  const at = (x: number, y: number, z: number) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] });
  const quad = (half: number, type: string, made?: Record<string, number>) => {
    const array = new Float32Array([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0]);
    const index = [0, 1, 2, 0, 2, 3];
    return { type, parameters: made, attributes: { position: { array, itemSize: 3, count: 4, version: 0, getX: (i: number) => array[i * 3], getY: (i: number) => array[i * 3 + 1], getZ: (i: number) => array[i * 3 + 2] } }, index: { count: 6, getX: (i: number) => index[i] } };
  };
  const scene: any = { isScene: true, type: 'Scene', visible: true, children: [] };
  const small = quad(0.2, 'BufferGeometry'), red = { type: 'ShaderMaterial', side: 0, uniforms: { uTime: {}, uColor: {} } };
  const mesh = (uuid: string, geometry: unknown, material: unknown, matrixWorld: unknown, more = {}) => { const m = { isMesh: true, type: 'Mesh', uuid, visible: true, geometry, material, matrixWorld, parent: scene, children: [], ...more }; scene.children.push(m); return m; };
  mesh('table-1', quad(1, 'PlaneGeometry', { width: 2, height: 2 }), { type: 'MeshStandardMaterial', side: 0, color: { getHexString: () => '886644' }, map: {} }, at(0, 0, -5), { name: 'table', userData: { kind: 'furniture' } });
  mesh('die-1', small, red, at(-1, 0, -3));
  mesh('die-2', small, red, at(1, 0, -3));
  mesh('unseen', quad(1, 'PlaneGeometry'), red, at(0, 0, -1), { visible: false });
  const f = 1, near = 0.1, far = 100;
  const camera = { isCamera: true, isPerspectiveCamera: true, matrixWorld: at(0, 0, 0), matrixWorldInverse: at(0, 0, 0), projectionMatrix: { elements: [f / (4 / 3), 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0] } };
  // Three tells its devtools of a renderer when it makes one; what it draws from then on is known.
  let draws = 0;
  const renderer = { domElement: canvas, render() { draws++; } };
  frame.__THREE_DEVTOOLS__.dispatchEvent(new (frame as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent('observe', { detail: renderer }));
  renderer.render.call(renderer, ...([scene, camera] as unknown as []));

  let n = 0;
  const ask = async (type: string, answer: string, data: Record<string, unknown>) => {
    const id = ++n;
    frame.dispatchEvent(new (frame as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data: { tandem: 1, type, id, ...data }, source: dom.window as never }));
    await wait(() => said.some((m) => m.type === answer && m.id === id));
    const { tandem: _t, type: _y, id: _i, ...rest } = said.find((m) => m.type === answer && m.id === id);
    return rest;
  };
  // The middle of the canvas: the table, behind the thing that is not drawn. It has a name, and that is what it is called.
  const table = await ask('pick', 'picked', { x: 200, y: 150 });
  assert.equal(table.words, 'Mesh "table"');
  assert.deepEqual([table.tag, table.selector], ['canvas', '#app > canvas']);
  assert.deepEqual(table.three, {
    uuid: 'table-1', type: 'Mesh', name: 'table',
    geometry: { type: 'PlaneGeometry', made: { width: 2, height: 2 }, points: 4 },
    material: { type: 'MeshStandardMaterial', color: '#886644', texture: true },
    position: [0, 0, -5], size: [2, 2, 0], point: [0, 0, -5], index: 1, of: 1, graph: 'Scene > Mesh "table"', userData: '{"kind":"furniture"}',
  });
  // To the right of it, nearer: the second of the two small things. It has no name: what it is, and which one.
  const die = await ask('pick', 'picked', { x: 250, y: 150 });
  assert.equal(die.words, 'Mesh, BufferGeometry, 2 of 2');
  assert.deepEqual([die.three.uuid, die.three.point, die.three.position, die.three.index, die.three.of], ['die-2', [1, 0, -3], [1, 0, -3], 2, 2]);
  assert.deepEqual(die.three.material, { type: 'ShaderMaterial', uniforms: ['uTime', 'uColor'] });
  assert.deepEqual([die.x, die.y, die.w, die.h].map(Math.round), [240, 140, 20, 20], 'where it is on the screen: the box it fits in');
  // Beside everything: the canvas itself, as on any page.
  const none = await ask('pick', 'picked', { x: 390, y: 10 });
  assert.deepEqual([none.three, none.words, none.w], [undefined, '', 400]);
  // Found again by the id three gave it, for the ring.
  const found = await ask('find', 'found', { at: 'three:die-1' });
  assert.deepEqual([found.x, found.y, found.w, found.h].map(Math.round), [140, 140, 20, 20]);
  assert.deepEqual(await ask('find', 'found', { at: 'three:gone' }), { missing: true });
  // Let go on it, a picture of it is asked for: taken when the scene is next drawn, and the page draws it once
  // more itself when it does not by then. (This stand-in for a browser cannot draw: there is no picture, and it is said without.)
  const before = draws;
  const withPicture = await ask('pick', 'picked', { x: 250, y: 150, image: true });
  assert.equal(draws, before + 1, 'drawn once more for the picture');
  assert.deepEqual([withPicture.three.uuid, withPicture.image], ['die-2', undefined]);
});
