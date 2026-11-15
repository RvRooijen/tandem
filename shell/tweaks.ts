// The values of a change set that the person turns themselves: a row each, with
// a slider, a switch, a colour or a field. What is set is sent while it is being
// set (code.tweak), one at a time and always the last: the working copy has it
// at once, and its page shows it. A row stays the same element for as long as
// its value is there, so a slider is not taken from under the finger when
// the card it is on hears of the change it made itself.
import { h } from './dom.ts';

type Value = number | boolean | string;
/** A value the agent exposed, as it stands in the working copy; `was` is what the agent had set, once the person turned it. */
export interface Tweak {
  label: string; file: string; name: string;
  kind: 'number' | 'boolean' | 'text' | 'colour';
  value: Value; was?: Value;
  min?: number; max?: number; step?: number;
}

type Act = <T>(name: string, input?: Record<string, unknown>) => Promise<T | undefined>;
interface Row { el: HTMLElement; shape: string; sync(t: Tweak): void }

const key = (t: Tweak) => `${t.file}\n${t.name}`;
const ranged = (t: Tweak) => t.kind === 'number' && t.min !== undefined && t.max !== undefined;
/** A colour as a colour picker takes it: six digits. One that says how see-through it is has no picker. */
const picked = (v: Value) => (/^#[0-9a-f]{3}$/i.test(String(v)) ? `#${[...String(v).slice(1)].map((c) => c + c).join('')}` : String(v)).toLowerCase();
const pickable = (v: Value) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v));
const shapeOf = (t: Tweak) => `${t.kind}${ranged(t) ? ':range' : ''}${t.kind === 'colour' && pickable(t.value) ? ':pick' : ''}`;

/** `turned` is called when the person starts turning something: whoever shows the rows may want the copy in view. */
export function createTweaks(act: Act, turned?: () => void) {
  const rows = new Map<string, Row>();

  function row(first: Tweak): Row {
    let t = first;
    let next: Value | undefined, sending = false;
    async function send(value: Value) {
      next = value;
      if (sending) return;
      sending = true;
      turned?.();
      // One at a time, and what was set last is what is sent last: what came between is skipped.
      while (next !== undefined) {
        const v = next;
        next = undefined;
        await act('code.tweak', { file: t.file, name: t.name, value: v });
        await new Promise((r) => setTimeout(r, 90));
      }
      sending = false;
      sync(t);
    }

    const label = h('span.tlabel');
    const back = h<'button'>('button.back', { hidden: true, onclick: () => { if (t.was === undefined) return; show(t.was); void send(t.was); } });
    let controls: HTMLInputElement[];
    /** A field that is typed in is left alone while it is: what is half typed is not a value yet. */
    let typed: HTMLInputElement | undefined;
    let show: (v: Value) => void;
    const named = { 'aria-label': first.label };

    if (first.kind === 'number') {
      const fits = (v: number) => (t.min === undefined || v >= t.min) && (t.max === undefined || v <= t.max);
      const num = h<'input'>('input.n', { type: 'number', inputMode: 'decimal', ...named, oninput: () => {
        const v = Number(num.value);
        if (!num.value.trim() || !Number.isFinite(v) || !fits(v)) return;
        if (slide) slide.value = String(v);
        void send(v);
      } });
      const slide = ranged(first) ? h<'input'>('input.slide', { type: 'range', ...named, oninput: () => { num.value = slide!.value; void send(Number(slide!.value)); } }) : undefined;
      controls = slide ? [num, slide] : [num];
      typed = num;
      show = (v) => { num.value = String(v); if (slide) slide.value = String(v); };
    } else if (first.kind === 'boolean') {
      const box = h<'input'>('input.switch', { type: 'checkbox', role: 'switch', ...named, onchange: () => void send(box.checked) });
      controls = [box];
      show = (v) => { box.checked = v === true; };
    } else if (first.kind === 'colour' && pickable(first.value)) {
      const pick = h<'input'>('input.pick', { type: 'color', ...named, oninput: () => void send(pick.value) });
      controls = [pick];
      show = (v) => { pick.value = picked(v); };
    } else {
      // (A text is sent when it is done, not letter by letter: half a word is not what anybody means.)
      const text = h<'input'>('input.text', { type: 'text', ...named, onchange: () => void send(text.value) });
      controls = [text];
      typed = text;
      show = (v) => { text.value = String(v); };
    }

    function sync(now: Tweak) {
      t = now;
      label.textContent = now.label;
      for (const c of controls) {
        c.setAttribute('aria-label', now.label);
        if (now.kind !== 'number') continue;
        if (now.min !== undefined) c.min = String(now.min); else c.removeAttribute('min');
        if (now.max !== undefined) c.max = String(now.max); else c.removeAttribute('max');
        // (A slider with no step of its own goes in a hundred steps; a field takes whatever is typed.)
        c.step = now.step !== undefined ? String(now.step) : c.type === 'range' ? String((now.max! - now.min!) / 100) : 'any';
      }
      back.hidden = now.was === undefined;
      back.textContent = `↺ ${now.was ?? ''}`;
      back.title = `Back to ${now.was ?? ''}, as the agent had it`;
      back.setAttribute('aria-label', back.title);
      // What it is set to here is ahead of what the core last said: it is not put back under the hand.
      if (sending || (typed && typed.ownerDocument.activeElement === typed)) return;
      show(now.value);
    }

    const el = h('div.tweak', { data: { kind: first.kind } }, h('div.thead', {}, label, back), controls);
    return { el, shape: shapeOf(first), sync };
  }

  return {
    /** The rows for these values, in their order, inside `el`: made once, and brought up to date from then on. */
    into(el: HTMLElement, list: Tweak[]) {
      const keys = new Set(list.map(key));
      for (const k of [...rows.keys()]) if (!keys.has(k)) rows.delete(k);
      const els = list.map((t) => {
        let r = rows.get(key(t));
        if (!r || r.shape !== shapeOf(t)) rows.set(key(t), r = row(t));
        r.sync(t);
        return r.el;
      });
      // (Only when other rows are wanted: putting the same ones in again would end what is being dragged.)
      if (els.length !== el.children.length || els.some((x, n) => el.children[n] !== x)) el.replaceChildren(...els);
      el.hidden = !els.length;
    },
  };
}

export type Tweaks = ReturnType<typeof createTweaks>;
