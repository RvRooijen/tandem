// The figure's voice: it babbles what the agent said, at the length of the
// line, the way a hand puppet talks.
//
// With a voice that was recorded for it (voice-samples.json, made on
// record.html: twenty short sounds a person said, a consonant and a vowel
// each), every syllable of the text is the recorded sound nearest to it,
// played faster and higher than it was said. Without one it makes the sounds
// itself, which is heard to be a machine:
//
// Not letter by letter but in syllables,
// each one a note that is scooped up to from below, in a sing-song that jumps
// about and now and then breaks upward; a throaty buzz with a nose in it, and
// a mouth around it (two filters, where a vowel rings) that goes from the one
// vowel to the next. The letters around a vowel close that mouth for a moment,
// or tick; a space ends the word, a comma or a full stop is a breath.

/** Where each vowel rings, low and high, in hertz. */
const VOWELS: Record<string, [number, number]> = { a: [780, 1200], e: [540, 1750], i: [330, 2250], o: [500, 900], u: [360, 800], y: [340, 2000] };
/** Letters that stop the voice and tick or hiss instead; the other consonants only close the mouth. */
const UNVOICED = 'cfhkpqstx';
/** The pitch it speaks at, and the notes above and below it that its sing-song goes by. */
const PITCH = 138, SCALE = [-5, -3, 0, 2, 4, 7, 9, 12];

let context: AudioContext | undefined, breath: AudioBuffer | undefined;

/** What is being said, as the mouth needs it: when each syllable sounds (in the audio's own time), how long, and how wide. */
let spoken: { at: number; length: number; wide: number }[] = [];
/**
 * How far the mouth is open at this moment for what is being said, 0 to 1; nothing when nothing is being said (any
 * more). It goes by what is heard: open on a syllable, widest where the word leans, shut between them.
 */
export function mouth(): number | undefined {
  const audio = context;
  // (Not allowed to make sound, its clock stands still: then nothing is said as far as the mouth goes.)
  if (!audio || audio.state !== 'running' || !spoken.length) return undefined;
  // (What is heard now was handed over a moment ago.)
  const now = audio.currentTime - (audio.outputLatency || 0);
  const end = spoken.at(-1)!;
  if (now > end.at + end.length + 0.15) { spoken = []; return undefined; }
  for (const s of spoken) {
    if (now < s.at) return 0;
    if (now < s.at + s.length) return s.wide * Math.sin(Math.PI * ((now - s.at) / s.length)) ** 0.6;
  }
  return 0;
}

interface Syllable { onset: string; vowels: string; letters: number; ends: 'word' | 'breath' | 'stop' | ''; first: boolean }

/** A text in syllables: what comes before a vowel, the vowels, and what follows up to the next one or the end of the word. */
function syllables(text: string): Syllable[] {
  const out: Syllable[] = [];
  for (const [w, word] of (text.toLowerCase().match(/[a-z0-9]+|[.!?,;:\n]+/g) ?? []).entries()) {
    if (!/[a-z0-9]/.test(word)) { const last = out.at(-1); if (last) last.ends = /[.!?\n]/.test(word) ? 'stop' : 'breath'; continue; }
    const parts = word.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]+$)?|[^aeiouy]+/g) ?? [word];
    for (const [i, part] of parts.entries()) {
      const vowels = part.match(/[aeiouy]+/)?.[0] ?? '';
      out.push({ onset: part.slice(0, vowels ? part.indexOf(vowels) : part.length), vowels: vowels || 'u', letters: part.length, ends: i === parts.length - 1 ? 'word' : '', first: i === 0 && w >= 0 });
    }
  }
  return out;
}

/** What record.html writes: the sounds by name ("ba", "lu"), each 16-bit samples in base64. */
interface Recorded { rate: number; samples: Record<string, string> }
/** The recorded sounds, once they were asked for; null where there are none. */
let recorded: Promise<Map<string, AudioBuffer> | null> | undefined;
function voiceOf(audio: AudioContext): Promise<Map<string, AudioBuffer> | null> {
  // (The file is only there once someone recorded a voice: asked for like this, it may be missing.)
  const load = Object.values(import.meta.glob<{ default: Recorded }>('./voice-samples.json'))[0];
  return recorded ??= !load ? Promise.resolve(null) : load().then((file) => {
    const sounds = new Map<string, AudioBuffer>();
    for (const [name, base64] of Object.entries(file.default.samples)) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), pcm = new Int16Array(bytes.buffer);
      const buffer = audio.createBuffer(1, pcm.length, file.default.rate), into = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) into[i] = pcm[i]! / 32768;
      sounds.set(name, buffer);
    }
    return sounds.size ? sounds : null;
  }).catch(() => null);
}
/** Which recorded line a syllable is nearest to, by the consonant it starts with. */
const LINE: Record<string, string> = { b: 'b', p: 'b', f: 'b', v: 'b', w: 'b', d: 'd', t: 'd', k: 'd', g: 'd', c: 'd', q: 'd', x: 'd', s: 'd', z: 'd', j: 'd', m: 'm', n: 'm', h: 'm', l: 'l', r: 'l' };

/**
 * The text in the recorded voice: a sound a syllable, faster and higher than it was said. It is not said evenly: a
 * word leans on one of its syllables, which is longer, louder and higher than the others; every stretch between two
 * commas has its own pace and its own tune, up first and then down; the last syllable before a breath is drawn out;
 * and each sound bends a little while it is said.
 */
function recite(audio: AudioContext, sounds: Map<string, AudioBuffer>, said: Syllable[], asks: boolean, per: number) {
  const out = audio.createGain();
  out.gain.value = 0.65;
  out.connect(audio.destination);
  const step = per / 1000;
  let at = audio.currentTime + 0.03, pace = 0.9 + 0.3 * Math.random(), drift = 0, inPhrase = 0;
  spoken = [];
  // Which syllable of each word is leant on: the first of a longer word mostly, and of short words one in three.
  const leant = said.map(() => false);
  for (let i = 0, start = 0; i < said.length; i++) {
    if (!said[i]!.ends && i < said.length - 1) continue;
    const count = i - start + 1;
    if (count > 1) leant[start + (Math.random() < 0.75 ? 0 : Math.min(1, count - 1))] = true; else if (Math.random() < 0.35) leant[start] = true;
    start = i + 1;
  }
  for (const [i, s] of said.entries()) {
    const through = i / Math.max(said.length - 1, 1), last = i === said.length - 1;
    const closes = s.ends === 'breath' || s.ends === 'stop' || last;
    const vowel = s.vowels[0] === 'y' ? 'i' : s.vowels[0]!;
    const sound = sounds.get((LINE[s.onset[0] ?? ''] ?? 'l') + vowel) ?? [...sounds.values()][i % sounds.size]!;
    // The tune of this stretch: up over its first syllables and then down, wandering a little, higher where it leans.
    drift = Math.max(-2, Math.min(1.2, drift + Math.random() * 1.6 - 0.85));
    const arc = 1.6 * Math.sin(Math.min(inPhrase / 4, 1) * Math.PI * 0.5) - 0.7 * Math.max(0, inPhrase - 4);
    const note = arc + drift + (leant[i] ? 1.4 : 0) - 1.5 * through
      + (closes ? (asks && last ? 3.5 : -2.5) : 0);
    const rate = 1.08 * 2 ** (Math.max(-6, Math.min(4, note)) / 12);
    // How long it takes: by its letters, at the pace of this stretch, longer where it leans or closes, short otherwise.
    const slot = step * (1.2 + s.letters * 0.75) * pace * (leant[i] ? 1.3 : 0.8 + 0.25 * Math.random()) * (closes ? 1.45 : 1);
    const source = audio.createBufferSource(), loud = audio.createGain();
    source.buffer = sound;
    // (It bends while it is said: down mostly, up at the end of a question.)
    const bend = asks && last ? 1.12 : closes ? 0.9 : 0.94 + 0.1 * Math.random();
    source.playbackRate.setValueAtTime(rate, at);
    source.playbackRate.linearRampToValueAtTime(rate * bend, at + slot);
    // A sound that is longer than its syllable is let go of a little after the next one starts; one it leans on, or
    // that closes, is said out.
    const whole = sound.duration / rate, length = leant[i] || closes ? whole : Math.min(whole, slot * 1.5);
    const level = (leant[i] ? 1 : 0.62 + 0.2 * Math.random()) * (closes && !asks ? 0.85 : 1);
    loud.gain.setValueAtTime(level, at);
    loud.gain.setValueAtTime(level, at + length * 0.65);
    loud.gain.linearRampToValueAtTime(0, at + length);
    source.connect(loud).connect(out);
    source.start(at);
    source.stop(at + length + 0.01);
    spoken.push({ at, length: Math.min(length, slot * 1.1), wide: leant[i] ? 1 : 0.45 + 0.25 * Math.random() });
    at += slot;
    inPhrase++;
    // Between words hardly a gap, now and then a longer one as if it looks for a word; a breath after a comma, a
    // longer one after a full stop, and then another pace and the tune from the start.
    if (s.ends === 'word') at += step * (Math.random() < 0.12 ? 3.5 : 0.3 + 0.9 * Math.random());
    if (s.ends === 'breath' || s.ends === 'stop') {
      at += step * (s.ends === 'stop' ? 5.5 : 3) * (0.8 + 0.5 * Math.random());
      pace = 0.85 + 0.4 * Math.random();
      inPhrase = 0;
      drift = 0;
    }
  }
  window.setTimeout(() => out.disconnect(), (at - audio.currentTime) * 1000 + 900);
}

/** The most words it says of one text. */
const MOST = 14;
/**
 * A text as far as it is said: a short line whole, of a longer one fewer and fewer of its words (a hundred are not
 * said ten times as long as ten), picked evenly from the first to the last, each with the comma or stop after it.
 */
function gist(text: string): string {
  const tokens = text.match(/[a-z0-9']+|[.!?,;:\n]+/gi) ?? [];
  const words = tokens.flatMap((t, i) => (/[a-z0-9]/i.test(t) ? [i] : []));
  const keep = Math.min(words.length, MOST, Math.round(2 + 1.6 * Math.sqrt(words.length)));
  if (keep >= words.length) return text;
  const picked = Array.from({ length: keep }, (_, k) => words[Math.round((k * (words.length - 1)) / Math.max(keep - 1, 1))]!);
  return [...new Set(picked)].map((i) => tokens[i]! + (tokens[i + 1] && !/[a-z0-9]/i.test(tokens[i + 1]!) ? tokens[i + 1]!.trim() || '.' : '')).join(' ');
}

/** Say a text: `per` milliseconds a letter. Nothing is heard where the browser has not let the page make sound yet. */
export function babble(text: string, per = 45): void {
  if (typeof AudioContext === 'undefined') return;
  text = gist(text);
  const said = syllables(text);
  if (!said.length) return;
  context ??= new AudioContext();
  const audio = context;
  if (audio.state === 'suspended') void audio.resume().catch(() => {});
  void voiceOf(audio).then((sounds) => { if (sounds) recite(audio, sounds, said, text.trimEnd().endsWith('?'), per); else hum(audio, said, text, per); });
}

/** The text in a voice that is made here, for want of a recorded one. */
function hum(audio: AudioContext, said: Syllable[], text: string, per: number) {
  if (!breath) {
    breath = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const samples = breath.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  const begin = audio.currentTime + 0.03;
  const out = audio.createGain();
  out.gain.value = 0.25;
  out.connect(audio.destination);

  // The throat: two saws a little apart, a waver on their pitch, and a rattle under it that makes it gravelly.
  const voice = audio.createGain(), rough = audio.createGain();
  voice.gain.value = 0;
  const buzzes = [0, 9].map((cents) => {
    const o = audio.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = cents;
    o.frequency.value = PITCH;
    o.connect(rough);
    return o;
  });
  rough.connect(voice);
  const waver = audio.createOscillator(), depth = audio.createGain();
  waver.frequency.value = 6.1;
  depth.gain.value = PITCH * 0.03;
  waver.connect(depth);
  for (const o of buzzes) depth.connect(o.frequency);
  const rattle = audio.createOscillator(), grit = audio.createGain();
  rattle.type = 'square';
  rattle.frequency.value = 41;
  grit.gain.value = 0.3;
  rattle.connect(grit).connect(rough.gain);
  // The mouth: what of the buzz rings low and what rings high; the nose, which is always the same; and the chest.
  const mouth = ([[1, 4.5], [0.6, 6]] as const).map(([loud, sharp]) => {
    const f = audio.createBiquadFilter(), g = audio.createGain();
    f.type = 'bandpass';
    f.Q.value = sharp;
    g.gain.value = loud;
    voice.connect(f).connect(g).connect(out);
    return f;
  });
  for (const [type, at, sharp, loud] of [['bandpass', 1050, 9, 0.5], ['lowpass', 420, 0.7, 0.22]] as const) {
    const f = audio.createBiquadFilter(), g = audio.createGain();
    f.type = type;
    f.frequency.value = at;
    f.Q.value = sharp;
    g.gain.value = loud;
    voice.connect(f).connect(g).connect(out);
  }
  const tick = (at: number, length: number, loud: number, from: number) => {
    const n = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
    n.buffer = breath!;
    f.type = 'highpass';
    f.frequency.value = from;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(loud, at + 0.004);
    g.gain.linearRampToValueAtTime(0, at + length);
    n.connect(f).connect(g).connect(out);
    n.start(at, Math.random() * 0.5, length + 0.02);
  };
  const hz = (note: number) => PITCH * 2 ** (note / 12);

  const asks = text.trimEnd().endsWith('?');
  let at = begin, step = 3;
  spoken = [];
  for (const [i, s] of said.entries()) {
    const through = i / Math.max(said.length - 1, 1), last = i === said.length - 1;
    // (The last syllable before a breath is drawn out, as in talking.)
    const length = (per / 1000) * s.letters * (0.85 + 0.3 * Math.random()) * (s.ends === 'stop' || s.ends === 'breath' || last ? 1.5 : 1);
    // The tune: a step or two up or down from the last note, higher at the start of a word, and now and then the
    // voice breaks an octave up. A sentence comes down towards its end; a question goes up.
    step = Math.max(0, Math.min(SCALE.length - 2, step + Math.round(Math.random() * 4 - 2.1) + (s.first ? 1 : 0)));
    const squeak = Math.random() < 0.12 ? 12 : 0;
    const note = SCALE[step]! + squeak - 4 * through + (asks && through > 0.75 ? 9 * (through - 0.75) / 0.25 : 0);
    for (const o of buzzes) {
      o.frequency.setValueAtTime(hz(note - 4), at);
      o.frequency.linearRampToValueAtTime(hz(note), at + length * 0.3);
      o.frequency.linearRampToValueAtTime(hz(note - (s.ends === 'stop' || last ? 5 : 1.5)), at + length);
    }
    // The consonants before the vowel shut the mouth, or tick; then it opens on the vowel, and where there are two
    // it goes from the one to the other.
    const shut = s.onset ? Math.min(0.035, length * 0.3) : 0;
    if (s.onset) {
      const hard = [...s.onset].some((c) => UNVOICED.includes(c));
      voice.gain.setTargetAtTime(hard ? 0.02 : 0.35, at, 0.006);
      mouth[0]!.frequency.setTargetAtTime(270, at, 0.008);
      mouth[1]!.frequency.setTargetAtTime(1250, at, 0.008);
      if (hard) tick(at, /[sfhcx]/.test(s.onset) ? shut + 0.02 : 0.018, /[sfhcx]/.test(s.onset) ? 0.07 : 0.16, /[sfhcx]/.test(s.onset) ? 3800 : 1700);
    }
    const from = VOWELS[s.vowels[0]!]!, to = VOWELS[s.vowels.at(-1)!]!;
    spoken.push({ at: at + shut, length: length - shut, wide: 0.5 + 0.5 * Math.random() });
    voice.gain.setTargetAtTime(1, at + shut, 0.012);
    for (const [k, f] of mouth.entries()) {
      f.frequency.setTargetAtTime(from[k]!, at + shut, 0.014);
      if (to !== from) f.frequency.setTargetAtTime(to[k]!, at + shut + (length - shut) * 0.5, 0.03);
    }
    at += length;
    if (s.ends) voice.gain.setTargetAtTime(s.ends === 'word' ? 0.25 : 0, at - 0.03, 0.015);
    // (A breath after a comma, a longer one after a full stop, and then it starts high again.)
    if (s.ends === 'word') at += (per / 1000) * 0.8;
    if (s.ends === 'breath') at += (per / 1000) * 3;
    if (s.ends === 'stop') { at += (per / 1000) * 5; step = 4; }
  }
  voice.gain.setTargetAtTime(0, at, 0.03);
  for (const o of [...buzzes, waver, rattle]) { o.start(begin); o.stop(at + 0.3); }
  // (What was made for this text is let go of when it has been said.)
  window.setTimeout(() => out.disconnect(), (at - audio.currentTime) * 1000 + 700);
}
