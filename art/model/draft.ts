// A model as it is being typed: a program cut off halfway, which does not run.
// What is whole of it so far is made to run: the half line it ends on is left
// off, and what is still open (a list, an object, a call) is closed after it.
// Where that is not enough (it ends on `const x =`), a line more is left off,
// and so on. Who watches sees the model grow, part by part.

/** The text up to its last whole line, with what is open there closed; undefined when nothing can be closed. */
export function closed(text: string): string | undefined {
  const open: string[] = [];
  let quote: string | null = null, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      else if (c === '\n' && quote !== '`') return undefined;
      continue;
    }
    if (c === '/' && next === '/') { line = true; i++; continue; }
    if (c === '/' && next === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') open.push(c);
    else if (c === ')' || c === ']' || c === '}') { if (!open.length) return undefined; open.pop(); }
  }
  if (quote || block) return undefined;
  const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  return `${text}\n${open.reverse().map((c) => close[c]).join('')}\n`;
}

/** What may run of a text cut off while it is typed: the most of it first, then a line less each time. */
export function soFar(text: string, tries = 8): string[] {
  const lines = text.split('\n');
  // (The last line is half typed, unless the text ends on a line's end.)
  let end = text.endsWith('\n') ? lines.length : lines.length - 1;
  const out: string[] = [];
  for (let k = 0; k < tries && end > 0; k++, end--) {
    const c = closed(lines.slice(0, end).join('\n'));
    if (c && /^\s*export\s+default\b/m.test(c)) out.push(c);
  }
  return out;
}

/**
 * The pixel drawings in a model's text, read as text, not run: every list of strings of # and . (a silhouette a
 * round part is made from), under the name it is given, as far as it is typed. So who watches sees them drawn row
 * by row, before the model they are for is there at all.
 */
export function sketchesIn(text: string): { name: string; rows: string[] }[] {
  const out: { name: string; rows: string[] }[] = [];
  const start = /(?:const|let|var)\s+([\w$]+)\s*=\s*\[\s*$|([\w$]+)\s*:\s*\[\s*$/;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(start);
    if (!m) continue;
    const rows: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j].match(/^\s*(['"`])([^'"`]*)\1?\s*,?\s*(?:\/\/.*)?$/);
      if (!row) break;
      rows.push(row[2]);
    }
    // (A list of words is not a drawing: it is one when its rows are pixels.)
    if (rows.length >= 2 && rows.every((r) => /^[#. ]*$/.test(r)) && rows.some((r) => r.includes('#'))) out.push({ name: m[1] ?? m[2], rows });
  }
  return out;
}
