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

/** Markdown inside a line: code, links, bold, italic, struck through. `s` is escaped already. */
function inline(s: string): string {
  // Code and links are set aside first, so nothing inside them is read as markdown.
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  const link = (url: string, words: string) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${words}</a>`);
  return s
    .replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${code}</code>`))
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_m, words, url) => link(url, words))
    .replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])/g, (_m, before, url) => `${before}${link(url, url)}`)
    .replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w_])__([^\n]+?)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w_])_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^\n]+?)~~/g, '<s>$1</s>')
    .replace(/\u0000(\d+)\u0000/g, (_m, n) => kept[Number(n)]);
}

const FENCE = /^\s*```/, HEADING = /^(#{1,6})\s+(.+?)\s*#*$/, RULE = /^\s*([-*_])(\s*\1){2,}\s*$/, QUOTE = /^\s*&gt;\s?/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/, DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Markdown as blocks: code, headings, rules, tables, quotes, lists (one inside another) and paragraphs. `lines` are escaped already. */
function blocks(lines: string[]): string {
  const out: string[] = [];
  const starts = (n: number) => FENCE.test(lines[n]) || HEADING.test(lines[n]) || RULE.test(lines[n]) || QUOTE.test(lines[n]) || ITEM.test(lines[n]) || (lines[n].includes('|') && DIVIDER.test(lines[n + 1] ?? ''));
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre>${code.join('\n')}</pre>`);
    } else if (HEADING.test(line)) {
      const [, marks, words] = HEADING.exec(line)!;
      out.push(`<h4 class="h${marks.length}">${inline(words)}</h4>`);
      i++;
    } else if (RULE.test(line)) { out.push('<hr>'); i++; }
    else if (line.includes('|') && DIVIDER.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_c, n) => `<td>${inline(r[n] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE, ''));
      out.push(`<blockquote>${blocks(inner)}</blockquote>`);
    } else if (ITEM.test(line)) {
      // The items of one list start where the first one does; what stands further in belongs to the item above it.
      const indent = ITEM.exec(line)![1].length, ordered = /\d/.test(ITEM.exec(line)![2]);
      const items: string[][] = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        if (m && m[1].length <= indent + 1) {
          if (m[1].length < indent || /\d/.test(m[2]) !== ordered) break;
          items.push([m[3]]);
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i])) items.at(-1)!.push(lines[i].replace(new RegExp(`^\\s{0,${indent + 2}}`), ''));
        else if (!lines[i].trim() && (ITEM.test(lines[i + 1] ?? '') || /^\s{2,}\S/.test(lines[i + 1] ?? ''))) continue;
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(([first, ...rest]) => `<li>${inline(first)}${rest.length ? blocks(rest) : ''}</li>`).join('')}</${tag}>`);
    } else {
      const text: string[] = [];
      for (; i < lines.length && lines[i].trim() && (!text.length || !starts(i)); i++) text.push(lines[i]);
      out.push(`<p>${text.map((l) => inline(l.trim())).join('<br>')}</p>`);
    }
  }
  return out.join('');
}

/** What somebody said, as markdown: headings, bold and italic, code, links, lists, tables, quotes; a line break is one. */
export function prose(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'prose';
  el.innerHTML = blocks(esc(text.replace(/\r/g, '')).split('\n'));
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
