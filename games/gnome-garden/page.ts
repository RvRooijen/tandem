// Gnome Garden in a page: the game, the framebuffer on a canvas, input, sound,
// saving. The standalone page (src/main.ts) calls this and nothing else; the
// engine's shell calls it too and lays its own tools over the top. What a
// finger does on the garden goes through the game's commands, the same ones
// the agent has.
import './src/ui/style.css';
import type { GamePage } from '../../core/game.ts';
import { adopt, game } from './module.ts';
import { createGame, type Game } from './src/sim/game.ts';
import { ZOOM, createScene, type Scene } from './src/render/scene.ts';
import { WORLD_H, WORLD_W } from './src/sim/world.ts';
import { createUI } from './src/ui/ui.ts';
import { MARKUP } from './src/ui/markup.ts';
import { createAudio } from './src/audio/audio.ts';
import { fmt, fmtTime, mood } from './src/util.ts';
import type { Tab } from './src/sim/content.ts';

export { game };

export function mount(root: HTMLElement): GamePage {
  root.innerHTML = MARKUP;

  const SAVE_KEY = 'gnome-garden-save-v1';
  const params = new URLSearchParams(location.search);
  const speed = Math.max(1, Number(params.get('speed')) || 1);     // ?speed=20 to watch the story go by

  function readSave(): unknown {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null'); } catch { return null; }
  }

  const g: Game = createGame(params.has('new') ? undefined : readSave());
  const world = adopt(g);
  const cmd = Object.fromEntries(game.commands(() => world).map((c) => [c.name, c]));
  const me = { by: 'me' };
  const audio = createAudio();
  audio.setMuted(!!g.s.mute);

  function save() {
    try { localStorage.setItem(SAVE_KEY, g.save()); } catch { /* storage full or blocked: play on */ }
  }

  const ui = createUI(g, {
    onMute() { g.s.mute = g.s.mute ? 0 : 1; audio.unlock(); audio.setMuted(!!g.s.mute); save(); },
    onReset() {
      if (!confirm('Burn the diary? Everything is lost: the garden, the gnomes, the hats.')) return;
      g.wipe();
      save();
      ui.openTab('garden');
    },
    onBuy(kind) { audio.unlock(); audio.play(kind); },
    onAbility(id) { audio.unlock(); if ((cmd['game.use'].run(me, { id }) as { used: boolean }).used) audio.play('ability:' + id); },
  });

  // ---------------------------------------------------------------- the canvas

  const canvas = document.getElementById('garden') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  let scene: Scene;
  let image: ImageData;

  const drawerEl = document.getElementById('drawer')!;
  const panelEl = document.getElementById('panel')!;

  function resize() {
    const stage = canvas.parentElement!;
    // The garden gets everything above the shut drawer: its purse, diary line and tabs.
    const closedH = drawerEl.offsetHeight - panelEl.offsetHeight;
    if (closedH > 0) document.getElementById('app')!.style.setProperty('--closed-h', `${closedH}px`);
    const cssW = stage.clientWidth, cssH = stage.clientHeight;
    if (!cssW || !cssH) return;
    // The picture is the garden's width at ZOOM pixels a unit. Where the screen can show that at a whole
    // number of device pixels each without leaving much over, it does; otherwise the browser scales it.
    const want = WORLD_W * ZOOM;
    const dev = cssW * (window.devicePixelRatio || 1);
    const k = Math.floor(dev / want);
    let fbW = k >= 1 && dev / k <= want * 1.18 ? Math.ceil(dev / k) : want;
    let fbH = Math.ceil((fbW * cssH) / cssW);
    const least = WORLD_H * ZOOM - 24;
    if (fbH < least) {
      // A short window: zoom out until the whole garden fits, with more lawn at the sides.
      fbH = least;
      fbW = Math.min(840, Math.ceil((fbH * cssW) / cssH));
    }
    fbH = Math.min(fbH, 840);
    if (!scene || scene.fb.w !== fbW || scene.fb.h !== fbH) {
      scene = createScene(fbW, fbH);
      canvas.width = fbW;
      canvas.height = fbH;
      image = new ImageData(new Uint8ClampedArray(scene.fb.px.buffer as ArrayBuffer), fbW, fbH);
      // Draw at once: a canvas that has just changed size is blank until something is put on it.
      scene.render(g, performance.now() / 1000);
      ctx.putImageData(image, 0, 0);
    }
  }
  window.addEventListener('resize', resize);
  // The drawer's height changes as the purse fills up; the garden gets what is left.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    ro.observe(drawerEl);
  }
  resize();

  // ---------------------------------------------------------------- input

  let down = false;
  let lastX = -99, lastY = -99;

  function tapAt(ev: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    const { x, y } = scene.toWorld(((ev.clientX - r.left) / r.width) * scene.fb.w, ((ev.clientY - r.top) / r.height) * scene.fb.h);
    if (Math.abs(x - lastX) < 1.5 && Math.abs(y - lastY) < 1.5) return;
    lastX = x; lastY = y;
    const { did } = cmd['game.tap'].run(me, { x, y }) as { did: string };
    if (did !== 'none') audio.play(did);
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (page.intercept) {
      // The engine is asking what is here: the finger points, it does not pick.
      const r = canvas.getBoundingClientRect();
      const at = scene.toWorld(((ev.clientX - r.left) / r.width) * scene.fb.w, ((ev.clientY - r.top) / r.height) * scene.fb.h);
      page.intercept(at.x, at.y);
      return;
    }
    audio.unlock();
    down = true;
    lastX = lastY = -99;
    canvas.setPointerCapture(ev.pointerId);
    tapAt(ev);
  });
  canvas.addEventListener('pointermove', (ev) => { if (down) tapAt(ev); });
  const up = () => { down = false; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  document.addEventListener('pointerdown', () => audio.unlock(), { once: true });

  // ---------------------------------------------------------------- what happened this frame

  const UNLOCKS: [string, Tab][] = [['gnomes', 'gnomes'], ['dig', 'below'], ['rites', 'rites']];
  const known = new Set(UNLOCKS.filter(([flag]) => g.s.flags[flag]).map(([flag]) => flag));

  function handleEvents() {
    for (const e of g.events) {
      switch (e.type) {
        case 'diary': ui.say(e.text!); audio.play('diary'); break;
        case 'beat':
          for (const [flag, tab] of UNLOCKS) if (g.s.flags[flag] && !known.has(flag)) { known.add(flag); ui.nudge(tab); }
          break;
        case 'taken': audio.play('taken'); navigator.vibrate?.([40, 60, 120]); break;
        case 'caught': audio.play('caught'); navigator.vibrate?.(15); break;
        case 'reborn':
          known.clear();
          for (const [flag] of UNLOCKS) if (g.s.flags[flag]) known.add(flag);
          audio.play('reborn');
          save();
          ui.modal(
            'For sale: charming cottage',
            `<p>Mature garden. Some ornaments included. The previous owner left in a hurry.</p>
             <p><b>+${e.n} red hats</b> are handed down. Each one makes everything in the garden 10% better, for every owner to come.</p>
             <p>You are owner number ${g.s.runs + 1}.</p>`,
            'Move in',
            () => ui.openTab('hats'),
          );
          break;
        case 'greet': audio.play('greet'); break;
        case 'task': ui.toast(`<s>${e.text}</s> ✓ · +${fmt(e.n!)} blooms`); audio.play('task'); break;
        case 'ready': ui.toast(`<b>Done:</b> ${e.text}. Cross it off in the diary.`); ui.nudge('diary'); audio.play('ready'); break;
        case 'wake': case 'morning': audio.play(e.type); break;
        case 'scare': audio.play('scare'); navigator.vibrate?.(200); break;
        case 'pick': case 'catch': case 'weed': case 'peek': break;      // the tap that did it already made its sound
        default: audio.play(e.type);
      }
    }
    g.events.length = 0;
  }

  // ---------------------------------------------------------------- time away

  function welcomeBack(seconds: number) {
    const got = g.away(seconds);
    if (!got || got.blooms <= 0) return;
    const p = g.s.peace;
    const lines = [`<li>+${fmt(got.blooms)} blooms</li>`];
    if (got.teeth >= 1) lines.push(`<li>+${fmt(got.teeth)} ${g.s.flags.teethNamed ? 'teeth' : 'pebbles'}</li>`);
    if (got.whispers >= 1) lines.push(`<li>+${fmt(got.whispers)} whispers</li>`);
    if (got.metres) lines.push(`<li>the hole is ${got.metres} m deeper</li>`);
    ui.modal(
      mood(['While you were out', 'While you weren\'t looking', 'we kept busy'], p),
      `<p>${mood(['The gnomes have been ever so helpful.', 'They have all moved. The doorstep is piled high.', 'You were gone for ' + fmtTime(seconds) + '. We counted.'], p)}</p>
       <ul>${lines.join('')}</ul><p><small>${fmtTime(seconds)} away</small></p>`,
      mood(['Lovely', 'Right', 'thank you'], p),
    );
    save();
  }

  if (g.s.lastSeen) welcomeBack((Date.now() - g.s.lastSeen) / 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      save();
      document.title = g.s.peace < 45 ? 'come back' : 'Gnome Garden';
    } else {
      document.title = 'Gnome Garden';
      welcomeBack((Date.now() - g.s.lastSeen) / 1000);
      last = performance.now();
    }
  });
  window.addEventListener('pagehide', save);

  // ---------------------------------------------------------------- the loop

  let last = performance.now();
  let uiT = 0;
  let saveT = 0;

  function frame(now: number) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.25, (now - last) / 1000) * speed;
    last = now;
    while (dt > 0) {
      const stepDt = Math.min(dt, 0.1);
      g.step(stepDt);
      dt -= stepDt;
      handleEvents();
    }
    scene.render(g, now / 1000);
    ctx.putImageData(image, 0, 0);

    uiT -= 1;
    if (uiT <= 0) {
      uiT = 12;
      ui.update();
      audio.setMood({ peace: g.s.peace, dark: g.dark, choir: g.s.gnomes.choir, ending: g.ending ? g.ending.t : 0, rain: g.rain });
    }
    saveT += 1;
    if (saveT > 600) { saveT = 0; save(); }
  }
  requestAnimationFrame(frame);

  // For poking at from the console.
  (window as unknown as { game: Game }).game = g;

  const page: GamePage = {
    world,
    intercept: null,
    toScreen(x, y) {
      const r = canvas.getBoundingClientRect();
      const ox = Math.floor((scene.fb.w - WORLD_W * ZOOM) / 2);
      return { x: r.left + ((x * ZOOM + ox) / scene.fb.w) * r.width, y: r.top + ((y * ZOOM) / scene.fb.h) * r.height };
    },
    contentChanged() { g.refresh(); ui.update(); },
    save,
  };
  return page;
}
