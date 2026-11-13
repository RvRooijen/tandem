import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { looksOf, parseGrids, parseArt, removePart, applyPaint, compareGrids, renameColors, draftOf, mentionsIn, mergeDraft, slim, inflate, removeAnchors, takeAnims, setView } from '../src/parse.js';
import { art, rows } from './helpers.js';

const RED = [255, 0, 0, 255];

describe('parseArt', () => {
  test('palette and grid rows', () => {
    const a = parseArt(art('ab.', '.ca'));
    assert.equal(a.width, 3);
    assert.equal(a.height, 2);
    assert.deepEqual(a.pixels[0], [RED, [0, 255, 0, 255], null]);
    assert.deepEqual(a.pixels[1][1], [0, 0, 255, 255]);
  });

  test('short rows are padded with transparent', () => {
    const a = parseArt(art('aaa', 'a'));
    assert.deepEqual(a.pixels[1], [RED, null, null]);
  });

  test('#rrggbbaa alpha, none and comments', () => {
    const a = parseArt('// kop\nx = #10203040\nn = none\n\nxn\n');
    assert.deepEqual(a.pixels[0], [[16, 32, 48, 64], null]);
  });

  test('frames, durations and animations', () => {
    const a = parseArt(art('=== idle', '--- 300', 'a', '--- 100', 'b', '=== jump', 'c'));
    assert.deepEqual(a.anims.map((x) => [x.name, x.frames]), [['idle', [0, 1]], ['jump', [2]]]);
    assert.deepEqual(a.frames.map((f) => f.duration), [300, 100, 150]);
  });

  test('line ranges of frames and animations cover the text', () => {
    const text = art('=== idle', 'a', '---', 'b', '=== jump', 'c');
    const a = parseArt(text);
    const lines = text.split('\n');
    assert.equal(lines[a.anims[1].lines[0]], '=== jump');
    assert.equal(lines[a.frames[1].lines[0]], '---');
  });

  test('errors name what is wrong', () => {
    assert.throws(() => parseArt('a = red\n\na\n'), /Invalid palette line/);
    assert.throws(() => parseArt(art('az')), /Unknown color "z"/);
    assert.throws(() => parseArt(art('@size 4 4', '@blob 1 1 a')), /Unknown shape "@blob"/);
    assert.throws(() => parseArt(art('@size 4 4', '@rect 0 0 x 1 a')), /"x" is not a number/);
    assert.throws(() => parseArt(PALETTE_ONLY), /No grid rows/);
    assert.throws(() => parseArt(art('@base body', 'a')), /needs `@slot/);
  });

  test('attachment, pin and anchors', () => {
    const a = parseArt(art('@base body', '@slot head', '@pin 1 0', 'aa'));
    assert.equal(a.base, 'body');
    assert.equal(a.slot, 'head');
    assert.deepEqual(a.pin, [1, 0]);
    const b = parseArt(art('@anchor right-hand 2 3 4 r-45', 'a'));
    assert.deepEqual(b.frames[0].anchors['right-hand'], { x: 2, y: 3, z: 4, r: -45 });
    assert.throws(() => parseArt(art('@anchor tail 1 1', 'a')), /@anchor needs/);
  });

  test('recolors keep char rows and swap per char', () => {
    const a = parseArt(art('@colors red', '@recolor blue a=#0000ff', 'ab'));
    assert.deepEqual(a.recolors.blue.a, [0, 0, 255, 255]);
    assert.deepEqual(a.frames[0].rows, ['ab']);
    // An older file's own colors: a recolor without swaps
    assert.deepEqual(a.recolors.red, {});
    assert.deepEqual(Object.keys(parseArt(art('@recolor blue a=#0000ff', 'a')).recolors), ['blue']);
  });

  test('a keep char shows what it covers', () => {
    const a = parseArt('a = #ff0000\nk = keep\n\n@size 2 1\n@rect 0 0 2 1 a\n@px 0 0 k\n');
    assert.deepEqual(a.pixels[0], [RED, RED]);
  });
});

const PALETTE_ONLY = 'a = #ff0000\n\n';

describe('shapes', () => {
  const draw = (...shapes) => rows(parseGrids(art('@size 5 5', ...shapes)).frames[0]);

  test('rect, clipped at the canvas edge', () => {
    assert.deepEqual(draw('@rect 3 3 4 4 a'), ['.....', '.....', '.....', '...aa', '...aa']);
  });

  test('circle is symmetric', () => {
    const g = draw('@circle 2 2 2 a');
    assert.deepEqual(g, [...g].reverse());
    assert.deepEqual(g.map((r) => [...r].reverse().join('')), g);
    assert.equal(g[2], 'aaaaa');
  });

  test('line with width', () => {
    assert.deepEqual(draw('@line 0 0 4 4 a'), ['a....', '.a...', '..a..', '...a.', '....a']);
    assert.equal(draw('@line 0 2 4 2 a 3').filter((r) => r.includes('a')).length, 3);
  });

  test('poly, also with the color glued to the first point', () => {
    const tri = draw('@poly a 0,0 5,0 0,5');
    assert.deepEqual(tri, ['aaaa.', 'aaa..', 'aa...', 'a....', '.....']);
    assert.deepEqual(draw('@poly a0,0 5,0 0,5'), tri);
    assert.throws(() => draw('@poly a 0,0 1,1'), /at least 3 points/);
  });

  test('fill stops at other chars', () => {
    assert.deepEqual(draw('@rect 0 2 5 1 b', '@fill 0 0 a'), ['aaaaa', 'aaaaa', 'bbbbb', '.....', '.....']);
  });

  test('px: _ keeps, . erases', () => {
    assert.deepEqual(draw('@rect 0 0 5 1 b', '@px 0 0 a_.c'), ['ab.cb', '.....', '.....', '.....', '.....']);
  });

  test('outline around everything solid', () => {
    assert.deepEqual(draw('@px 2 2 a', '@outline b'), ['.....', '..b..', '.bab.', '..b..', '.....']);
  });

  test('later shapes paint over earlier ones', () => {
    assert.equal(draw('@rect 0 0 5 1 a', '@rect 0 0 2 1 b')[0], 'bbaaa');
  });
});

describe('editing the text', () => {
  const text = art('=== idle', 'a', '---', 'b', '=== jump', 'c');

  test('removePart: a frame, an animation, refuses the last one', () => {
    assert.deepEqual(parseArt(removePart(text, { frame: 0 })).anims[0].frames, [0]);
    assert.deepEqual(parseArt(removePart(text, { anim: 1 })).anims.map((a) => a.name), ['idle']);
    assert.throws(() => removePart(text, { frame: 2 }), /only frame/);
  });

  test('removePart: a recolor, also an older @colors', () => {
    const t = art('@colors red', '@recolor blue a=#0000ff', 'a');
    assert.deepEqual(Object.keys(parseArt(removePart(t, { recolor: 'blue' })).recolors), ['red']);
    assert.deepEqual(Object.keys(parseArt(removePart(t, { recolor: 'red' })).recolors), ['blue']);
  });

  test('applyPaint adds @px lines to the right frame', () => {
    const out = applyPaint(text, [{ anim: 'idle', pos: 1, px: [[0, 0, 'c'], [9, 9, 'a']] }]);
    assert.match(out, /\/\/ drawn by hand\n@px 0 0 c\n/);
    const a = parseGrids(out);
    assert.deepEqual(rows(a.frames[1]), ['c']);
    assert.deepEqual(rows(a.frames[0]), ['a']);
    assert.throws(() => applyPaint(text, [{ anim: 'idle', pos: 5, px: [] }]), /no longer exists/);
    assert.throws(() => applyPaint(text, [{ anim: 'idle', pos: 0, px: [[0, 0, 'z']] }]), /Unknown color/);
  });

  test('compareGrids counts differing pixels', () => {
    const own = parseGrids(art('ab'));
    assert.equal(compareGrids(own, own).count, 0);
    const diff = compareGrids(own, parseGrids(art('aa')));
    assert.equal(diff.count, 1);
    assert.match(diff.lines[0], /1,0 is 'b', should be 'a'/);
  });

  test('@variant: layers belong to a recolor, and go back with a bare @variant', () => {
    const t = art('@colors iron', '@recolor gold', 'a..', '@variant gold', '@px 1 0 b', '@variant', '@px 2 0 c');
    const g = parseGrids(t);
    assert.deepEqual(rows(g.frames[0]), ['a.c']);
    assert.deepEqual(g.frames[0].variants.gold.chars.map((r) => r.join('')), ['abc']);
    assert.throws(() => parseArt(art('@colors iron', '@recolor gold', 'a', '@variant silver', '@px 0 0 b')), /no @recolor silver/);
    assert.throws(() => parseArt(art('@colors iron', '@recolor gold from=lead', 'a')), /no recolor lead/);
    // A new frame starts without a layer
    assert.deepEqual(rows(parseGrids(art('@colors iron', '@recolor gold', 'a', '@variant gold', '---', '@px 0 0 b')).frames[1]), ['b']);
  });

  test('a recolor others build on is a group, not a look', () => {
    assert.deepEqual(looksOf(parseArt(art('@recolor iron', '@recolor dragon', '@recolor red from=dragon a=#ff0000', 'a'))), ['iron', 'red']);
  });

  test('removePart and renameColors take the layers of a recolor along', () => {
    const t = art('@colors iron', '@recolor gold', '@recolor silver', 'a.', '@variant gold', '@px 1 0 b', '---', 'a');
    const gone = parseArt(removePart(t, { recolor: 'gold' }));
    assert.equal(gone.frames[0].variants, undefined);
    assert.throws(() => removePart(art('@colors iron', '@recolor gold', '@recolor rose from=gold', 'a'), { recolor: 'gold' }), /builds on gold/);
    const renamed = parseArt(renameColors(art('@colors iron', '@recolor gold', '@recolor rose from=gold', 'a.', '@variant gold', '@px 1 0 b'), 'gold', 'aurum'));
    assert.deepEqual(Object.keys(renamed.frames[0].variants), ['aurum', 'rose']);
    assert.equal(renamed.from.rose, 'aurum');
  });

  test('applyPaint puts strokes on a variant in its layer', () => {
    const t = art('@colors iron', '@recolor gold', 'a..', '@variant gold', '@px 1 0 b');
    const out = applyPaint(t, [{ anim: 'main', pos: 0, px: [[2, 0, 'c']] }, { anim: 'main', pos: 0, variant: 'gold', px: [[0, 0, 'b']] }]);
    const g = parseGrids(out);
    assert.deepEqual(rows(g.frames[0]), ['a.c']);
    assert.deepEqual(g.frames[0].variants.gold.chars.map((r) => r.join('')), ['bbc']);
  });

  test('renameColors', () => {
    const t = art('@colors red', '@recolor blue a=#0000ff', 'a');
    assert.equal(parseArt(renameColors(t, 'blue', 'navy')).recolors.navy.a[2], 255);
    assert.deepEqual(Object.keys(parseArt(renameColors(t, 'red', 'rood')).recolors), ['rood', 'blue']);
    assert.throws(() => renameColors(t, 'blue', 'red'), /already exists/);
  });
});

test('mentionsIn finds @name with its recolor, animation and frame, each once', () => {
  assert.deepEqual(mentionsIn('like @ox-base and @male:blue/run/3, not mail@me.com, @ox-base again'), [
    { text: 'ox-base', name: 'ox-base', recolor: undefined, anim: undefined, frame: undefined },
    { text: 'male:blue/run/3', name: 'male', recolor: 'blue', anim: 'run', frame: 3 },
  ]);
  assert.deepEqual(mentionsIn(undefined), []);
});

describe('drafts', () => {
  test('draftOf', () => {
    assert.deepEqual(draftOf('ox--run'), { project: 'ox', anim: 'run' });
    assert.equal(draftOf('ox'), null);
  });

  test('mergeDraft appends, replaces and adds palette colors', () => {
    const project = art('=== idle', 'a');
    const draft = 'a = #ff0000\nd = #ffffff\n\n@size 1 1\n=== run\nd\n';
    const merged = parseArt(mergeDraft(project, draft, 'run'));
    assert.deepEqual(merged.anims.map((a) => a.name), ['idle', 'run']);
    assert.deepEqual(merged.frames[1].pixels[0][0], [255, 255, 255, 255]);
    const again = parseArt(mergeDraft(mergeDraft(project, draft, 'run'), draft.replace('\nd\n', '\na\n'), 'run'));
    assert.equal(again.anims.length, 2);
    assert.deepEqual(again.frames[1].pixels[0][0], RED);
  });

  // The project's palette: a red, b green, c blue
  const project = art('=== idle', 'abc');
  const pixelsOf = (text, anim) => {
    const a = parseArt(text);
    return a.anims.find((x) => x.name === anim).frames.map((f) => a.frames[f].pixels);
  };

  test('a draft char with another color is renamed, the project keeps its colors', () => {
    const draft = 'a = #000000\n\n@size 3 1\n=== run\naa\n@px 2 0 a\n';
    const merged = mergeDraft(project, draft, 'run');
    assert.deepEqual(pixelsOf(merged, 'idle'), pixelsOf(project, 'idle'));
    assert.deepEqual(pixelsOf(merged, 'run')[0][0], [[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]]);
    assert.equal(merged.match(/= #000000/g).length, 1);
  });

  test('renamed in every shape, also a poly with its color glued on', () => {
    const draft = [
      'a = #000000',
      '',
      '@size 6 6',
      '=== run',
      '@rect 0 0 1 1 a',
      '@ellipse 2 2 0 0 a',
      '@circle 4 4 0 a',
      '@line 0 5 1 5 a 1',
      '@poly a5,0 6,0 6,2',
      '@fill 3 0 a',
      '@px 0 1 a_a',
      '@outline a',
    ].join('\n');
    // A draft has the project's size
    const merged = mergeDraft(art('@size 6 6', '=== idle', 'abc'), draft, 'run');
    const draftOnly = parseArt(draft);
    assert.deepEqual(pixelsOf(merged, 'run'), [draftOnly.frames[0].pixels]);
  });

  test('to the project char that already has that color', () => {
    const merged = mergeDraft(project, 'a = #0000ff\n\n=== run\na\n', 'run');
    assert.match(merged, /=== run\nc\n/);
    assert.ok(!/#0000ff[\s\S]*#0000ff/.test(merged.split('\n\n')[0]));
  });

  test('two chars that swap colors', () => {
    const merged = mergeDraft(project, 'a = #00ff00\nb = #ff0000\n\n=== run\nab\n', 'run');
    assert.match(merged, /=== run\nba\n/);
  });

  test('an unused conflicting char changes nothing', () => {
    const merged = mergeDraft(project, 'a = #000000\nc = #0000ff\n\n=== run\nc\n', 'run');
    assert.ok(!merged.includes('#000000'));
  });
});

describe('wire form', () => {
  test('slim drops the pixels, inflate makes the same ones again', () => {
    const art = parseArt('a = #ff0000\nk = keep\nb = #00ff00\n\n@size 16 8\n=== idle\n@rect 0 0 16 8 a\n@px 1 0 k\n---\n@rect 0 0 16 8 b\n@px 0 1 kk\n');
    const wire = JSON.parse(JSON.stringify(slim(art)));
    assert.ok(!('pixels' in wire) && wire.frames.every((f) => !('pixels' in f)));
    assert.ok(JSON.stringify(wire).length < JSON.stringify(art).length / 2);
    const back = inflate(wire);
    assert.deepEqual(back.frames.map((f) => f.pixels), art.frames.map((f) => f.pixels));
    assert.deepEqual(back.pixels, art.pixels);
    assert.equal(inflate(back), back);
    assert.deepEqual(inflate({ error: 'x' }), { error: 'x' });
  });
});

test('@view says per animation how the body is seen', () => {
  const { anims } = parseGrids(art('=== idle', '@view 3/4, turned to the left', '--- 300', 'a', '=== walk', 'a'));
  assert.deepEqual(anims.map((a) => a.view), ['3/4, turned to the left', undefined]);
});

test('setView changes, adds and removes the @view line of one animation', () => {
  const text = art('=== idle', '@view front', 'a', '=== walk', '--- 200', 'a');
  const views = (t) => parseGrids(t).anims.map((a) => a.view);
  assert.deepEqual(views(setView(text, 'idle', '3/4 left')), ['3/4 left', undefined]);
  assert.deepEqual(views(setView(text, 'walk', 'profile')), ['front', 'profile']);
  assert.equal(parseGrids(setView(text, 'walk', 'profile')).frames[1].duration, 200);
  assert.deepEqual(views(setView(text, 'idle', ' ')), [undefined, undefined]);
  assert.deepEqual(views(setView(art('a'), 'main', 'side')), ['side']);
  assert.throws(() => setView(text, 'fly', 'x'), /No animation fly/);
});

test('removeAnchors takes one slot out of one animation', () => {
  const text = art('=== idle', '@anchor right-hand 0 0', '@anchor head 0 0', 'a', '=== run', '@anchor right-hand 0 0', 'a');
  const out = parseArt(removeAnchors(text, 'idle', 'right-hand'));
  assert.deepEqual(Object.keys(out.frames[0].anchors), ['head']);
  assert.deepEqual(Object.keys(out.frames[1].anchors), ['right-hand']);
  assert.throws(() => removeAnchors(text, 'fly', 'head'), /No animation fly/);
});

test('takeAnims puts animations of one file into another by name, a pivot image with its @pin', () => {
  const head = (frames) => art('@base body', '@slot head', '@size 2 1', ...frames);
  const target = head(['=== idle', '@rect 0 0 2 1 a', '=== run', '@rect 0 0 2 1 a']);
  const source = head(['=== idle', '@rect 0 0 2 1 b', '=== run', '@rect 0 0 2 1 b', '=== pivot', '@pin 0 0', '@rect 0 0 1 1 c']);
  const out = parseArt(takeAnims(target, source, ['run', 'pivot']));
  assert.deepEqual(out.anims.map((a) => a.name), ['idle', 'run', 'pivot']);
  assert.deepEqual(out.frames[0].pixels[0][0], RED);
  assert.deepEqual(out.frames[1].pixels[0][0], [0, 255, 0, 255]);
  assert.deepEqual([out.pin, out.pinFrame], [[0, 0], 2]);
});

test('@tiles, @tile and @strip: named tiles of a tilesheet and strips put together from them', async () => {
  const { rectOf, stripPixels, tilesJson } = await import('../src/tiles.js');
  const text = ['a = #ff0000', 'b = #00ff00', 'c = #0000ff', '', '@size 4 6', '@tiles 2 2', '@tile top 0 0', '@tile mid 0 1', '@tile end 0 2', '@tile wide 0 0 2 1', '@strip pole v top mid end', 'aa..', 'aa..', 'bb..', 'bb..', 'cc..', 'cc..'].join('\n');
  const art = parseArt(text);
  assert.deepEqual(art.tiles.list.map((t) => t.name), ['top', 'mid', 'end', 'wide']);
  assert.deepEqual(rectOf(art.tiles, 'wide'), { x: 0, y: 0, w: 4, h: 2 });
  assert.deepEqual(art.tiles.strips, [{ name: 'pole', dir: 'v', start: 'top', middle: 'mid', end: 'end' }]);
  // Start, the middle three times, end
  const strip = stripPixels(art.tiles, art.frames[0].pixels, art.tiles.strips[0]);
  assert.equal(strip.length, 10);
  assert.deepEqual(strip.map((row) => row[0]?.[1]), [0, 0, 255, 255, 255, 255, 255, 255, 0, 0]);
  const json = tilesJson(art.tiles, 'pole.png', 4);
  assert.deepEqual(json.tiles.mid, { x: 0, y: 8, w: 8, h: 8 });
  assert.deepEqual(json.strips.pole, { direction: 'vertical', start: 'top', middle: 'mid', end: 'end' });
  // Mistakes say what is wrong
  const bad = (lines) => () => parseArt(['a = #ff0000', '', '@size 4 4', ...lines, 'a'].join('\n'));
  assert.throws(bad(['@tile x 0 0']), /needs `@tiles <w> <h>` first/);
  assert.throws(bad(['@tiles 2 2', '@tile x 2 0']), /outside the canvas/);
  assert.throws(bad(['@tiles 2 2', '@tile x 0 0', '@strip s v x y -']), /no @tile y/);
  assert.throws(bad(['@tiles 2 2', '@tile x 0 0', '@strip s d x x x']), /<v\|h>/);
  // Without tiles there are none
  assert.equal(parseArt(['a = #ff0000', '', 'a'].join('\n')).tiles, null);
});
