// pixeldraw runtime: draws a character exported with "Game" (an atlas PNG and its manifest JSON, see
// src/gamekit.js) in a game, with swappable items per slot and animations to play. No dependencies; drawing goes
// through a 2D canvas context.
//
//   import { Character } from './pixeldraw.js';
//   const hero = await Character.load('testman.json');      // the PNG is next to it
//   const actor = hero.actor();
//   actor.wear('male').wear('heavy-torso', 'iron-plate-body').wear('sword');
//   actor.play('walk');
//   // every tick:
//   actor.update(dtMs);
//   actor.draw(ctx, x, y, { scale: 3, flipX: facingLeft });
//
// (x, y) is where the base's top-left (0, 0) goes; pinned items can stick out of it (see manifest.origin).

export class Character {
  constructor(manifest, image) {
    if (manifest.format !== 'pixeldraw-character') throw new Error('Not a pixeldraw character manifest');
    this.manifest = manifest;
    this.image = image;
    this.base = manifest.name;
  }

  // Loads the manifest and the atlas next to it
  static async load(url) {
    const manifest = await (await fetch(url)).json();
    const image = new Image();
    image.src = new URL(manifest.image, new URL(url, location.href)).href;
    await image.decode();
    return new Character(manifest, image);
  }

  get animations() {
    return Object.keys(this.manifest.animations);
  }
  // The items per slot, with their looks: { torso: { 'heavy-torso': ['iron-plate-body', ...] }, ... }
  get items() {
    const out = {};
    for (const [name, { slot, looks }] of Object.entries(this.manifest.layers)) if (slot !== 'base') (out[slot] ??= {})[name] = Object.keys(looks);
    return out;
  }

  actor() {
    return new Actor(this);
  }
}

export class Actor {
  constructor(character) {
    this.character = character;
    this.worn = {}; // slot → { item, look }
    this.anim = character.animations[0];
    this.frame = 0;
    this.time = 0;
    this.loop = true;
    this.speed = 1;
    this.done = false;
    this.onEnd = null;
  }

  // Puts an item on, in its slot (another item there comes off); without a look its first one
  wear(item, look) {
    const layer = this.character.manifest.layers[item];
    if (!layer || layer.slot === 'base') throw new Error(`No item ${item}`);
    look ??= Object.keys(layer.looks)[0];
    if (!layer.looks[look]) throw new Error(`${item} has no look ${look}: ${Object.keys(layer.looks).join(', ')}`);
    this.worn[layer.slot] = { item, look };
    return this;
  }
  takeOff(slot) {
    delete this.worn[slot];
    return this;
  }

  // Plays an animation from its start, unless it is already playing (restart: true starts it over). With
  // loop: false it stops on its last frame and calls onEnd.
  play(anim, { loop = true, restart = false, speed = 1, onEnd = null } = {}) {
    if (!this.character.manifest.animations[anim]) throw new Error(`No animation ${anim}: ${this.character.animations.join(', ')}`);
    Object.assign(this, { loop, speed, onEnd });
    if (anim === this.anim && !restart && !this.done) return this;
    Object.assign(this, { anim, frame: 0, time: 0, done: false });
    return this;
  }

  // Moves the animation on by dt milliseconds
  update(dt) {
    const durations = this.character.manifest.animations[this.anim].durations;
    if (this.done) return this;
    this.time += dt * this.speed;
    while (this.time >= durations[this.frame]) {
      this.time -= durations[this.frame];
      if (this.frame + 1 < durations.length) this.frame++;
      else if (this.loop) this.frame = 0;
      else {
        this.done = true;
        this.time = 0;
        this.onEnd?.(this);
        break;
      }
    }
    return this;
  }

  // Draws the current frame: depth 1 of the base and everything worn (in slot order), then depth 2, and so on.
  // flipX mirrors it around the middle of the base's canvas, so it turns around on the spot.
  draw(ctx, x, y, { scale = 1, flipX = false } = {}) {
    const { manifest, image } = this.character;
    const [ox, oy] = manifest.origin;
    const looks = [manifest.layers[manifest.name].looks.default, ...manifest.slots.filter((s) => this.worn[s]).map((s) => manifest.layers[this.worn[s].item].looks[this.worn[s].look])];
    const lists = looks.map((look) => look[this.anim]?.[this.frame] ?? []);
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    for (let d = 1; d <= 5; d++)
      for (const slices of lists)
        for (const [sd, ax, ay, w, h, fx, fy] of slices) {
          if (sd !== d) continue;
          const top = y + (fy - oy) * scale;
          if (!flipX) {
            ctx.drawImage(image, ax, ay, w, h, x + (fx - ox) * scale, top, w * scale, h * scale);
            continue;
          }
          ctx.save();
          ctx.translate(x + (manifest.baseWidth - (fx - ox)) * scale, top);
          ctx.scale(-1, 1);
          ctx.drawImage(image, ax, ay, w, h, 0, 0, w * scale, h * scale);
          ctx.restore();
        }
    ctx.imageSmoothingEnabled = smooth;
    return this;
  }
}
