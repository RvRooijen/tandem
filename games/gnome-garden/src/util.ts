// Small shared helpers: number formatting, seeded random, math.

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

/** 1234 -> "1.23K"; whole numbers below 1000 stay whole. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) {
    if (n >= 100 || Number.isInteger(n)) return String(Math.floor(n));
    return n < 10 ? (Math.floor(n * 10) / 10).toString() : String(Math.floor(n));
  }
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIX.length) return n.toExponential(2).replace('+', '');
  const v = n / Math.pow(1000, tier);
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const cut = Math.floor(v * Math.pow(10, digits)) / Math.pow(10, digits);
  return cut.toFixed(digits) + SUFFIX[tier];
}

/** Compact form for the in-world pixel font (uppercase, no long suffixes). */
export function fmtTiny(n: number): string {
  if (n < 1000) return String(Math.floor(n));
  const tier = Math.floor(Math.log10(n) / 3);
  const tiny = ['', 'K', 'M', 'B', 'T', 'Q'];
  if (tier >= tiny.length) return 'E' + Math.floor(Math.log10(n));
  const v = n / Math.pow(1000, tier);
  return (v >= 10 ? String(Math.floor(v)) : (Math.floor(v * 10) / 10).toString()) + tiny[tier];
}

export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/** Deterministic hash of an integer to [0, 1). */
export function hash01(n: number): number {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Mulberry32: a small seeded generator, so runs can be replayed in tests. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a wording by how much peace of mind is left: [cozy, odd, creepy]. */
export function mood<T>(variants: readonly T[], peace: number): T {
  if (variants.length === 1) return variants[0];
  const i = peace >= 70 ? 0 : peace >= 35 ? 1 : 2;
  return variants[Math.min(i, variants.length - 1)];
}
