// Small things for building the page by hand.

type Child = Node | string | number | false | null | undefined | Child[];

/** h('button#send.primary', { onclick }, 'Send'): a tag, an id if it has one, classes. */
export function h<K extends keyof HTMLElementTagNameMap = 'div'>(spec: string, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const [head, ...classes] = spec.split('.');
  const [tag, id] = head.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  for (const k in props) {
    const v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  add(el, kids);
  return el as HTMLElementTagNameMap[K];
}

function add(el: Node, kid: Child) {
  if (Array.isArray(kid)) for (const k of kid) add(el, k);
  else if (kid instanceof Node) el.appendChild(kid);
  else if (kid !== false && kid !== null && kid !== undefined) el.appendChild(document.createTextNode(String(kid)));
}

export function clear(el: Element, ...kids: Child[]) {
  el.replaceChildren();
  add(el, kids);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** What somebody said, with the little markdown people actually use: bold, code, lists, line breaks. */
export function prose(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'prose';
  el.innerHTML = esc(text)
    .replace(/```\w*\n?([\s\S]*?)```/g, (_m, code) => `<pre>${code}</pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,4} (.+)$/gm, '<b>$1</b>')
    .replace(/^[-*] (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
  return el;
}

/** A value of a record, short enough for one line. */
export function short(v: unknown, max = 64): string {
  const s = typeof v === 'string' ? v : typeof v === 'number' ? num(v) : JSON.stringify(v);
  return s === undefined ? '—' : s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const num = (v: number) => (Math.abs(v) >= 1e6 ? v.toExponential(2).replace('e+', 'e') : String(Math.round(v * 1000) / 1000));

/** Minutes, the way a person says them. */
export function mins(m: number | undefined): string {
  if (m === undefined) return 'never';
  if (m < 90) return `${Math.round(m * 10) / 10} min`;
  return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;
}

export function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
