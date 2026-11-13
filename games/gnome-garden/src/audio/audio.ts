// All sound is made here from oscillators and noise: a music box that comes
// apart as peace of mind runs out, the choir's hum, and a few small noises.
export interface Mood { peace: number; dark: number; choir: number; ending: number; rain: number }

export interface Audio {
  /** Call from a user gesture: browsers only start audio then. */
  unlock(): void;
  setMuted(m: boolean): void;
  setMood(m: Mood): void;
  play(name: string): void;
}

// A lullaby in C, sixteen steps; 0 is a rest.
const TUNE = [659, 784, 1047, 784, 698, 880, 1047, 880, 587, 784, 988, 784, 523, 659, 784, 0];
const PICK = [523, 587, 659, 784, 880, 1047];

export function createAudio(): Audio {
  let ctx: AudioContext | null = null;
  let master: GainNode;
  let droneGain: GainNode, humGain: GainNode, rainGain: GainNode;
  let muted = false;
  let mood: Mood = { peace: 100, dark: 0, choir: 0, ending: 0, rain: 0 };
  let stepAt = 0;
  let step = 0;
  let nextBird = 0;
  const lastPlayed: Record<string, number> = {};

  function tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const gn = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, freq), t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise(dur: number, vol: number, cutoff: number, delay = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(vol, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(gn).connect(master);
    src.start(t);
  }

  function startBeds() {
    if (!ctx) return;
    // The drone: two saws a hair apart, heard only once things have gone wrong.
    droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    for (const f of [55, 55.6, 82.1]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    lp.connect(droneGain).connect(master);
    // The choir: a soft open fifth with a slow wobble.
    humGain = ctx.createGain();
    humGain.gain.value = 0;
    const wob = ctx.createOscillator();
    wob.frequency.value = 0.23;
    const wobGain = ctx.createGain();
    wobGain.gain.value = 2.2;
    wob.connect(wobGain);
    wob.start();
    for (const f of [110, 164.8, 220.6]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      wobGain.connect(o.frequency);
      o.connect(humGain);
      o.start();
    }
    humGain.connect(master);
    // The rain: two seconds of noise going round, with the top taken off.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 0.4;
    rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    src.connect(band).connect(rainGain).connect(master);
    src.start();
    setInterval(tick, 60);
  }

  /** The music box and the birds, scheduled a little ahead. */
  function tick() {
    if (!ctx || muted || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const dread = 1 - mood.peace / 100;
    if (now >= stepAt) {
      const gap = 0.36 + dread * 0.42;
      stepAt = Math.max(now, stepAt) + gap;
      const f = TUNE[step++ % TUNE.length];
      // Notes go missing, then flat, then it is mostly silence.
      const plays = mood.peace > 30 ? Math.random() > dread * 0.75 : Math.random() < 0.16;
      if (f && plays && !mood.ending) {
        const bend = 1 - dread * 0.11 - Math.random() * dread * 0.05;
        tone(f * bend, 0.9, 'sine', 0.05 * (1 - dread * 0.4), 0.02);
        tone(f * bend * 2.003, 0.35, 'triangle', 0.012, 0.02);
        if (dread > 0.55 && Math.random() < 0.3) tone(f * bend * 0.943, 1.2, 'sine', 0.025, 0.06);
      }
    }
    if (now >= nextBird) {
      nextBird = now + 3 + Math.random() * 7;
      if (mood.peace > 68 && mood.dark < 0.4) {
        const base = 2300 + Math.random() * 900;
        tone(base, 0.07, 'sine', 0.025, 0, base * 1.35);
        tone(base * 1.1, 0.07, 'sine', 0.025, 0.11, base * 1.5);
        if (Math.random() < 0.5) tone(base, 0.09, 'sine', 0.02, 0.24, base * 1.2);
      } else if (mood.peace > 55 && mood.dark > 0.6) {
        for (let i = 0; i < 4; i++) tone(4300, 0.03, 'sine', 0.008, i * 0.06);   // a cricket
      }
    }
    droneGain.gain.setTargetAtTime(dread * dread * 0.11 + mood.ending * 0.25, now, 0.8);
    const voice = Math.min(1, mood.choir / 18) * (mood.dark > 0.5 ? 1 : 0.3);
    humGain.gain.setTargetAtTime(voice * 0.045 + mood.ending * 0.08, now, 0.6);
    rainGain.gain.setTargetAtTime(mood.rain * 0.09, now, 1.2);
  }

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.7;
      master.connect(ctx.destination);
      startBeds();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  }

  function setMuted(m: boolean) {
    muted = m;
    if (ctx) master.gain.setTargetAtTime(m ? 0 : 0.7, ctx.currentTime, 0.05);
  }

  /** At most one of each sound per `gap` ms. */
  function ready(name: string, gap: number): boolean {
    const now = performance.now();
    if (now - (lastPlayed[name] ?? 0) < gap) return false;
    lastPlayed[name] = now;
    return true;
  }

  function play(name: string) {
    if (!ctx || muted) return;
    const dread = 1 - mood.peace / 100;
    const flat = 1 - dread * 0.22;
    switch (name) {
      case 'pick': {
        if (!ready(name, 45)) return;
        const f = PICK[Math.floor(Math.random() * PICK.length)] * flat;
        tone(f, 0.22, 'triangle', 0.09);
        if (dread > 0.5) tone(f * 1.06, 0.3, 'sine', 0.03);
        break;
      }
      case 'snip': if (ready(name, 110)) tone(1500 * flat, 0.03, 'square', 0.006); break;
      case 'deliver': if (ready(name, 160)) tone(330 * flat, 0.12, 'sine', 0.03); break;
      case 'tooth': if (ready(name, 140)) { tone(2100, 0.04, 'square', 0.012); tone(1400, 0.05, 'square', 0.01, 0.04); } break;
      case 'buy': tone(523 * flat, 0.12, 'triangle', 0.07); tone(784 * flat, 0.2, 'triangle', 0.07, 0.08); break;
      case 'rite': tone(110, 1.6, 'sine', 0.16); tone(164.8, 1.4, 'sine', 0.07, 0.04); tone(233, 1.1, 'sine', 0.03, 0.1); noise(0.5, 0.03, 400); break;
      case 'no': if (ready(name, 150)) tone(130, 0.09, 'square', 0.03); break;
      case 'diary': if (ready(name, 300)) { tone(880 * flat, 0.05, 'sine', 0.03); tone(1175 * flat, 0.08, 'sine', 0.03, 0.07); } break;
      case 'greet': tone(659, 0.1, 'triangle', 0.06); tone(784, 0.1, 'triangle', 0.06, 0.09); tone(1047, 0.2, 'triangle', 0.06, 0.18); break;
      case 'visitor': if (ready(name, 500)) { tone(988 * flat, 0.25, 'sine', 0.04); tone(784 * flat, 0.4, 'sine', 0.04, 0.22); } break;
      case 'lure': tone(220, 2.5, 'sine', 0.05, 0, 207); break;
      case 'taken': noise(0.9, 0.22, 500); tone(300, 0.9, 'sawtooth', 0.07, 0, 38); break;
      case 'caught': if (ready(name, 2000)) { tone(1245, 0.5, 'sine', 0.035); tone(880, 0.5, 'sine', 0.035); } break;
      case 'depth': if (ready(name, 600)) tone(82, 0.5, 'sine', 0.08, 0, 62); break;
      case 'dusk': tone(392 * flat, 0.8, 'sine', 0.035); tone(294 * flat, 1.2, 'sine', 0.035, 0.5); break;
      case 'dawn': if (mood.peace > 45) { tone(523, 0.3, 'sine', 0.03); tone(659, 0.3, 'sine', 0.03, 0.2); tone(784, 0.5, 'sine', 0.03, 0.4); } break;
      case 'ending': noise(13, 0.3, 90); tone(40, 13, 'sawtooth', 0.12, 0, 110); break;
      case 'weed': if (ready(name, 60)) { noise(0.08, 0.05, 2500); tone(260 * flat, 0.08, 'triangle', 0.04); } break;
      case 'catch': tone(880 * flat, 0.09, 'triangle', 0.06); tone(1319 * flat, 0.09, 'triangle', 0.06, 0.07); tone(1760 * flat, 0.18, 'triangle', 0.05, 0.14); break;
      case 'critter': if (ready(name, 800) && mood.peace > 40) tone(1568, 0.12, 'sine', 0.02, 0, 1760); break;
      case 'task': tone(659 * flat, 0.1, 'triangle', 0.06); tone(880 * flat, 0.1, 'triangle', 0.06, 0.09); tone(1319 * flat, 0.25, 'triangle', 0.06, 0.18); break;
      case 'ability:water': noise(0.9, 0.05, 3000); break;
      case 'ability:bell': tone(1319, 0.6, 'sine', 0.08); tone(1976, 0.5, 'sine', 0.04); tone(1319, 0.6, 'sine', 0.07, 0.25); break;
      case 'ability:away': tone(330 * flat, 0.5, 'sine', 0.04, 0, 165); break;
      case 'ability:sing': tone(220, 1.5, 'sine', 0.06); tone(330, 1.5, 'sine', 0.05, 0.1); break;
      case 'peek': if (ready(name, 300)) tone(196 * flat, 0.25, 'sine', 0.04, 0, 392); break;
      case 'scare': noise(0.5, 0.35, 1200); tone(90, 0.6, 'sawtooth', 0.2, 0, 45); tone(1480, 0.4, 'square', 0.05); break;
      case 'ready': if (ready(name, 400)) { tone(784 * flat, 0.1, 'triangle', 0.05); tone(1047 * flat, 0.18, 'triangle', 0.05, 0.1); } break;
      case 'morning': if (mood.peace > 40) { tone(523, 0.25, 'sine', 0.03); tone(784, 0.4, 'sine', 0.03, 0.2); } break;
      case 'wake': tone(147, 0.5, 'sine', 0.05, 0, 110); break;
      case 'ability:nap': tone(392 * flat, 0.5, 'sine', 0.04, 0, 262); break;
      case 'reborn': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.7, 'sine', 0.06, 0.6 + i * 0.22)); break;
    }
  }

  return { unlock, setMuted, setMood: (m) => { mood = m; }, play };
}
