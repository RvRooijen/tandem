import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArt } from '../src/parse.js';
import { attachmentsOf, compose, dress, layerOf, recolor, uncolored, splitItem } from '../src/attach.js';
import { art, depthArt } from './helpers.js';

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];

// A 3x1 body (red) and a shirt (green) over its middle, with depth maps
const body = parseArt(art('aaa'));
const bodyDepth = parseArt(depthArt('333'));
const shirt = parseArt(art('@base body', '@slot torso', '.b.'));

describe('compose by depth', () => {
  test('on equal depth the attachment lies on top', () => {
    const out = compose(body, [{ art: body, depth: bodyDepth }, { art: shirt, depth: parseArt(depthArt('.3.')) }]);
    assert.deepEqual(out.pixels[0], [RED, GREEN, RED]);
  });

  test('a farther attachment stays behind', () => {
    const out = compose(body, [{ art: body, depth: bodyDepth }, { art: shirt, depth: parseArt(depthArt('.1.')) }]);
    assert.deepEqual(out.pixels[0], [RED, RED, RED]);
  });

  test('a hidden base still hides what is behind it', () => {
    const out = compose(body, [{ art: body, depth: parseArt(depthArt('353')), hidden: true }, { art: shirt, depth: parseArt(depthArt('.3.')) }]);
    assert.deepEqual(out.pixels[0], [null, null, null]);
  });

  test('a half transparent layer blends', () => {
    const glass = parseArt('g = #0000ff80\n\n.g.\n');
    const out = compose(body, [{ art: body, depth: bodyDepth }, { art: glass, depth: parseArt(depthArt('.3.')) }]);
    const [r, g, b, a] = out.pixels[0][1];
    assert.ok(r > 100 && r < 160 && g === 0 && b > 100 && a === 255);
  });
});

describe('pinned attachments', () => {
  const base = parseArt(art('@size 5 5', '@anchor right-hand 2 2', '@rect 0 0 5 5 a'));
  const sword = parseArt(art('@base base', '@slot right-hand', '@pin 0 0', 'c'));

  test('the pin lands on the anchor', () => {
    const out = dress('sword', sword, { arts: { base }, depths: {} });
    const [ox, oy] = out.offset;
    assert.deepEqual(out.frames[0].pixels[2 + oy][2 + ox], BLUE);
  });

  test('the canvas grows where the image sticks out', () => {
    const edge = parseArt(art('@size 2 2', '@anchor right-hand 1 1', '@rect 0 0 2 2 a'));
    const long = parseArt(art('@base edge', '@slot right-hand', '@pin 0 0', 'ccc'));
    const out = dress('long', long, { arts: { edge }, depths: {} });
    assert.ok(out.width > 2);
    assert.ok(out.offset.every((v) => v === 0)); // may be -0
    assert.equal(out.width, 4);
  });
});

describe('dress and items', () => {
  const arts = { body, shirt };
  test('attachmentsOf skips drafts', () => {
    assert.deepEqual(attachmentsOf('body', { ...arts, 'shirt--run': shirt }), ['shirt']);
  });

  test('a base without items is itself', () => {
    assert.equal(dress('body', body, { arts, depths: {} }), body);
  });

  test('a base dressed with an item', () => {
    const out = dress('body', body, { arts, depths: { body: bodyDepth } }, ['shirt']);
    assert.deepEqual(out.pixels[0], [RED, GREEN, RED]);
  });

  test('only some animations, renumbered', () => {
    const two = parseArt(art('@size 2 1', '=== idle', 'aa', '---', 'a.', '=== run', '.a', '---', '..', '---', 'aa'));
    const full = dress('two', two, { arts: { two, shirt }, depths: {} }, ['shirt']);
    const out = dress('two', two, { arts: { two, shirt }, depths: {} }, ['shirt'], { anims: [1] });
    assert.deepEqual(out.anims.map((a) => [a.name, a.frames]), [['run', [0, 1, 2]]]);
    assert.deepEqual(out.frames.map((f) => [f.anim, f.pixels]), full.frames.slice(2).map((f) => [0, f.pixels]));
  });

  test('splitItem', () => {
    assert.deepEqual(splitItem('shirt:blue'), { name: 'shirt', colors: 'blue' });
    assert.deepEqual(splitItem('shirt'), { name: 'shirt', colors: null });
  });
});

describe('recolors', () => {
  const variant = parseArt(art('@colors red', '@recolor blue a=#0000ff', 'ab'));

  test('swaps only the named chars, and is cached', () => {
    const blue = recolor(variant, 'blue');
    assert.deepEqual(blue.pixels[0], [BLUE, GREEN]);
    assert.equal(recolor(variant, 'blue'), blue);
    assert.equal(recolor(variant, null), variant);
  });

  test('a variant draws its detail layer, and one built on it (from=) too', () => {
    const plate = parseArt(art('@colors iron', '@recolor dragon', '@recolor emerald from=dragon b=#0000ff', 'aa.', '@variant dragon', '@px 1 0 b', '@px 2 0 b'));
    assert.deepEqual(plate.pixels[0], [RED, RED, null]);
    assert.deepEqual(recolor(plate, 'dragon').pixels[0], [RED, GREEN, GREEN]);
    assert.deepEqual(recolor(plate, 'emerald').pixels[0], [RED, BLUE, BLUE]);
  });

  test("a variant's detail layer takes the depth of that layer in the depth map", () => {
    const plate = parseArt(art('@base body', '@slot torso', '@colors iron', '@recolor horned', '.a.', '@variant horned', '@px 2 0 b'));
    const depths = { plate: parseArt(depthArt('.3.', '@variant horned', '@px 2 0 1')) };
    const out = compose(body, [{ art: body, depth: bodyDepth }, layerOf('plate', recolor(plate, 'horned'), depths, body)]);
    // The horn is behind the body (1), the plate itself over it
    assert.deepEqual(out.pixels[0], [RED, RED, RED]);
    const front = { plate: parseArt(depthArt('.3.', '@variant horned', '@px 2 0 5')) };
    assert.deepEqual(compose(body, [{ art: body, depth: bodyDepth }, layerOf('plate', recolor(plate, 'horned'), front, body)]).pixels[0], [RED, RED, GREEN]);
  });

  test("a recolor's drawing without color has its detail layer, in gray", () => {
    const plate = parseArt(art('@colors iron', '@recolor dragon', '@recolor emerald from=dragon b=#0000ff', 'a.', '@variant dragon', '@px 1 0 b'));
    const [r, g, b] = uncolored(plate, 'dragon').pixels[0][1];
    assert.ok(r === g && g === b);
    assert.equal(uncolored(plate).pixels[0][1], null);
  });

  test('uncolored is gray', () => {
    const [r, g, b] = uncolored(variant).pixels[0][0];
    assert.ok(r === g && g === b);
  });
});

describe('frames or pivot, per animation', () => {
  // A base with an anchor in idle; a sword with a pivot image and frames of its own for run
  const base = parseArt(art('@size 5 5', '=== idle', '@anchor right-hand 2 2', '@rect 0 0 5 5 a', '=== run', '@rect 0 0 5 5 a'));
  const sword = parseArt(art('@base base', '@slot right-hand', '@size 5 5', '=== run', '@px 0 4 b', '=== pivot', '@pin 0 0', 'c'));

  test('the pivot image is the frame with @pin', () => {
    assert.equal(sword.pinFrame, 1);
    assert.throws(() => parseArt(art('@base base', '@slot head', '@pin 0 0', 'c', '---', '@pin 0 0', 'c')), /one pivot image/);
  });

  test('an animation with frames of its own uses them, the others the pivot image on the anchor', () => {
    const out = dress('sword', sword, { arts: { base }, depths: {} });
    const [ox, oy] = out.offset;
    const at = (anim, x, y) => out.frames[out.anims.find((a) => a.name === anim).frames[0]].pixels[y + oy][x + ox];
    assert.deepEqual(at('idle', 2, 2), BLUE);
    assert.deepEqual(at('run', 0, 4), GREEN);
    assert.deepEqual(at('run', 2, 2), RED);
  });

  test('a pinned attachment of old, one image and nothing else, still follows its anchor everywhere', () => {
    const old = parseArt(art('@base base', '@slot right-hand', '@pin 0 0', 'c'));
    assert.equal(old.pinFrame, 0);
    const out = dress('old', old, { arts: { base }, depths: {} });
    const [ox, oy] = out.offset;
    assert.deepEqual(out.frames[0].pixels[2 + oy][2 + ox], BLUE);
  });
});

describe('a pivot image of its own per animation', () => {
  const base = parseArt(art('@size 5 5', '=== idle', '@anchor head 2 2', '@rect 0 0 5 5 a', '=== walk', '@anchor head 2 2', '@rect 0 0 5 5 a'));
  // A shared pivot image (blue), and walk's own (green)
  const helm = parseArt(art('@base base', '@slot head', '@size 5 5', '=== pivot', '@pin 0 0', 'c', '=== walk', '@pin 0 0', 'b'));

  test('walk shows its own, idle the shared one', () => {
    assert.equal(helm.pinFrame, 0);
    const out = dress('helm', helm, { arts: { base }, depths: {} });
    const [ox, oy] = out.offset;
    const at = (anim) => out.frames[out.anims.find((a) => a.name === anim).frames[0]].pixels[2 + oy][2 + ox];
    assert.deepEqual(at('idle'), BLUE);
    assert.deepEqual(at('walk'), GREEN);
  });

  test('without a shared one, only the animations with their own show it', () => {
    const only = parseArt(art('@base base', '@slot head', '@size 5 5', '=== walk', '@pin 0 0', 'b'));
    assert.equal(only.pinFrame, null);
    assert.ok(only.pin);
    const out = dress('only', only, { arts: { base }, depths: {} });
    const [ox, oy] = out.offset;
    const at = (anim) => out.frames[out.anims.find((a) => a.name === anim).frames[0]].pixels[2 + oy][2 + ox];
    assert.deepEqual(at('idle'), RED);
    assert.deepEqual(at('walk'), GREEN);
  });
});
