// Values of a change set that the person turns themselves. The agent says which
// (code.expose): a file of its working copy and the name a value has there. The
// value is then read from that file and written back into it, in place, when the
// person changes it on the card (code.tweak); nothing is kept anywhere else, so
// what the card shows is what the code says. Only a value written out where it
// is named can be turned: a number, true or false, a text in quotes, a colour.

export type TweakValue = number | boolean | string;

/** What the agent exposed: what the person reads on the card, where the value is, and for a number how far it goes. */
export interface Tweak {
  label: string;
  file: string;
  name: string;
  min?: number;
  max?: number;
  step?: number;
  /** The value when it was exposed: the agent's own, to go back to. */
  was: TweakValue;
  /** What the person last set it to, when they did: while it stands there, `was` stays what the agent had. */
  set?: TweakValue;
}

export type TweakKind = 'number' | 'boolean' | 'text' | 'colour';

/** A value found in a source: what it is, and where it is written (the value itself, without its quotes). */
export interface Found {
  kind: TweakKind;
  value: TweakValue;
  from: number;
  to: number;
  /** A number that is written without a point: it stays a whole number unless a step says otherwise. */
  whole?: boolean;
  /** A text: what it is quoted with. */
  quote?: string;
}

const COLOUR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// After the value the statement ends (a unit may come first: 12px): a value that is part of a sum is not the value.
const DONE = String.raw`[ \t]*(?:[;,)}\]]|\r?$|\/\/|\/\*|#)`;
const END = `(?=${DONE})`, UNIT = `(?=[a-zA-Z%]*${DONE})`;
const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\d_.]|[xXobn][\da-fA-F]|n\b)`;
const VALUE = [
  String.raw`(?<number>${NUMBER})${UNIT}`,
  String.raw`(?<bool>true|false|True|False)${END}`,
  String.raw`(?<colour>#[0-9a-fA-F]{3,8})${END}`,
  String.raw`(?<quote>["'\x60])(?<text>[^"'\x60\\\n$]*)\k<quote>`,
].join('|');

/**
 * Every place in a source where `name` is given a value that is written out: `NAME = 4`, `name: 4`, `"name": 4`,
 * `--name: 4px`, with a type between them (`NAME: number = 4`) or not.
 */
export function find(source: string, name: string): Found[] {
  if (!/^[\w$-]+$/.test(name)) return [];
  const named = name.replace(/[$]/g, '\\$&');
  const re = new RegExp(String.raw`(?<![\w$-])["']?${named}["']?(?![\w$-])[ \t]*(?::[ \t]*[A-Za-z_][\w.<>\[\]| ]*=|[:=])[ \t]*(?:${VALUE})`, 'gm');
  const out: Found[] = [];
  for (const m of source.matchAll(re)) {
    const g = m.groups!;
    const raw = g.number ?? g.bool ?? g.colour ?? g.text;
    // The value is the last thing matched, but for the quote that closes a text.
    const to = m.index + m[0].length - (g.quote ? 1 : 0);
    const from = to - raw.length;
    if (g.number !== undefined) out.push({ kind: 'number', value: Number(raw), from, to, whole: /^-?\d+$/.test(raw) });
    else if (g.bool !== undefined) out.push({ kind: 'boolean', value: raw.toLowerCase() === 'true', from, to });
    else if (g.colour !== undefined) { if (COLOUR.test(raw)) out.push({ kind: 'colour', value: raw, from, to }); }
    else out.push({ kind: COLOUR.test(raw) ? 'colour' : 'text', value: raw, from, to, quote: g.quote });
  }
  return out;
}

/** Why a value cannot be written where one was found; undefined when it can. */
export function unfit(found: Found, value: unknown, t: Pick<Tweak, 'min' | 'max'> = {}): string | undefined {
  if (found.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'it is a number';
    if (t.min !== undefined && value < t.min) return `it goes no lower than ${t.min}`;
    if (t.max !== undefined && value > t.max) return `it goes no higher than ${t.max}`;
    return undefined;
  }
  if (found.kind === 'boolean') return typeof value === 'boolean' ? undefined : 'it is true or false';
  if (typeof value !== 'string') return found.kind === 'colour' ? 'it is a colour, like #ff8800' : 'it is a text';
  if (found.kind === 'colour') return COLOUR.test(value) ? undefined : 'it is a colour, like #ff8800';
  if (/["'`\\\n\r$]/.test(value) || value.length > 200) return 'it is a short text on one line, without quotes, backslashes or $';
  return undefined;
}

/** The source with another value where one was found. Written as the code had it: True stays True, a unit stays. */
export function put(source: string, found: Found, value: TweakValue): string {
  const was = source.slice(found.from, found.to);
  const text = typeof value === 'boolean' ? (/^[TF]/.test(was) ? (value ? 'True' : 'False') : String(value))
    // (A number is written plainly: 0.30000000000000004 is not what anybody set.)
    : typeof value === 'number' ? String(Number(value.toPrecision(12)))
      : value;
  return source.slice(0, found.from) + text + source.slice(found.to);
}
