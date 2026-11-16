// The icons of the tools: Lucide's, by what they are for here. One set, drawn
// as lines in the colour of the words they stand with.
import { ArrowUpRight, Brush, Check, ChevronLeft, ChevronRight, FileText, Folder, House, Lock, LockOpen, Paperclip, Pencil, RotateCcw, Settings, SlidersHorizontal, Target, X, createElement } from 'lucide';

const ICONS = {
  close: X, yes: Check, back: ChevronLeft, more: ChevronRight,
  folder: Folder, home: House, file: FileText, clip: Paperclip, again: RotateCcw,
  lock: Lock, unlock: LockOpen, settings: SlidersHorizontal,
  engine: Settings, page: Target, open: ArrowUpRight, art: Brush, edit: Pencil,
};
export type IconName = keyof typeof ICONS;

/** An icon, as large as the words around it. */
export function icon(name: IconName): SVGElement {
  const el = createElement(ICONS[name]) as unknown as SVGElement;
  el.setAttribute('class', `t-ic i-${name}`);
  el.setAttribute('width', '1em');
  el.setAttribute('height', '1em');
  el.setAttribute('aria-hidden', 'true');
  return el;
}
