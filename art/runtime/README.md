# pixeldraw runtime

Draws a character exported from pixeldraw (Export → Game in the viewer, or `node scripts/export-game.js <base>`) in a JS game: items swappable per slot, animations to play. One file, no dependencies, draws on a 2D canvas.

The export is two files next to each other: `<base>.png` (the atlas) and `<base>.json` (the manifest). Copy them and `pixeldraw.js` into your game.

## Example

```js
import { Character } from './pixeldraw.js';

const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');

// Load once per character; the PNG is found next to the JSON
const testman = await Character.load('assets/testman.json');
console.log(testman.animations); // ['idle', 'walk', 'run', 'jump', ...]
console.log(testman.items);      // { torso: { 'heavy-torso': ['iron-plate-body', ...] }, ... }

// An actor is one character in the game: its own outfit, animation and time
const hero = testman.actor();
hero.wear('male', 'black-male-1')            // a skin is an item too (slot skin)
    .wear('heavy-torso', 'iron-plate-body')  // item, look
    .wear('heavy-legs')                      // without a look: its first one
    .wear('sword');                          // pinned items follow their anchor by themselves
hero.play('idle');

let facingLeft = false;
let last = performance.now();
function frame(now) {
  hero.update(now - last); // milliseconds
  last = now;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hero.draw(ctx, 100, 80, { scale: 4, flipX: facingLeft });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Gameplay
function onInput(keys) {
  if (keys.left || keys.right) {
    facingLeft = keys.left;
    hero.play('walk'); // already playing: keeps going
  } else hero.play('idle');
  if (keys.attack) hero.play('slash-attack', { loop: false, restart: true, onEnd: () => hero.play('idle') });
}

// Swap gear at any time
hero.wear('heavy-torso', 'azurite-dragon'); // another look of the same item
hero.wear('medium-torso');                  // another item in the same slot replaces it
hero.takeOff('right-hand');
```

## API

- `Character.load(url)` loads a manifest and its atlas. `new Character(manifest, image)` if you load them yourself.
- `character.animations`: the animation names. `character.items`: per slot the items and their looks.
- `character.actor()`: a new actor.
- `actor.wear(item, look?)`: puts an item on in its slot; another item in that slot comes off.
- `actor.takeOff(slot)`
- `actor.play(anim, { loop = true, restart = false, speed = 1, onEnd })`: plays an animation; calling it again for the animation that is playing does nothing unless `restart`. With `loop: false` it stops on its last frame (`actor.done`) and calls `onEnd`.
- `actor.update(dtMs)`: moves the animation on by the frame durations of the drawing.
- `actor.draw(ctx, x, y, { scale = 1, flipX = false })`: draws the current frame with (x, y) the top-left of the base's canvas. Pinned items can stick out of it. `flipX` mirrors around the middle of the base, so the character turns on the spot.
- `actor.anim`, `actor.frame`: what is shown now.

## How it works

Every item can be in front of the body in one frame and behind it in the next (a sleeve, a cape, a sword swinging round), so there is no fixed drawing order per item. Instead, the export splits every frame of the base and of every item into its five depths, from 1 (farthest) to 5 (nearest). `draw` draws depth 1 of the base and of everything worn, then depth 2, and so on, each depth in slot order. That gives exactly what the viewer shows, for any outfit.
