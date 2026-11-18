// Where a model's program runs: a node of its own under Node's permission
// model, which may read only this folder (its own code) and nothing else, start
// nothing and write nothing; with a little memory and a few seconds. The text
// comes in on stdin, and what it gave back goes out as JSON, with the
// silhouettes rings() was given. Whether that is a model is for format.ts to
// say, in the engine. (run.ts starts it.)
import { runInNewContext } from 'node:vm';
import { soFar } from './draft.ts';
import { pathFromSilhouettes, ringsFromSilhouettes, type RingOptions } from './profile.ts';
import type { Profile } from './format.ts';

/** A model's text as a program: what it gives back (export default) is returned. */
export function asProgram(text: string): string {
  if (/^\s*import\s/m.test(text)) throw new Error('a model cannot import anything: rings() and along() are there without it');
  if (!/^\s*export\s+default\b/m.test(text)) throw new Error('a model gives back what it is: export default { parts: [...] }');
  // (On the first line, so the line numbers of an error are the text's own.)
  return `(function () {${text.replace(/^(\s*)export\s+default\b/m, '$1return')}\n})()`;
}

/** Where in the text an error is: its line, from the stack the program left. */
function where(e: unknown): string {
  // (An error made inside the model's own world is not an Error of this one: it is read by what it has.)
  const err = (e && typeof e === 'object' ? e : {}) as { stack?: unknown; name?: unknown; message?: unknown };
  const stack = String(err.stack ?? '');
  const line = stack.match(/^model:(\d+)/)?.[1] ?? stack.match(/\(?model:(\d+):\d+\)?/)?.[1];
  const what = typeof err.message === 'string' ? `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}` : String(e);
  return line ? `${what} (line ${line})` : what;
}

export function evaluate(text: string): { model: unknown; profiles: Profile[] } {
  const profiles: Profile[] = [];
  const rings = (front: string[], side: string[], options: RingOptions = {}) => {
    const out = ringsFromSilhouettes(front, side, options);
    profiles.push({ front: [...front], side: [...side], ...(options.rows && { rows: options.rows }), ...(typeof options.name === 'string' && { name: options.name }) });
    return out;
  };
  const along = (front: string[], side: string[], options: RingOptions = {}) => {
    const out = pathFromSilhouettes(front, side, options);
    profiles.push({ front: [...front], side: [...side], ...(options.rows && { rows: options.rows }), ...(typeof options.name === 'string' && { name: options.name }) });
    return out;
  };
  let model: unknown;
  try {
    model = runInNewContext(asProgram(text), { rings, along, console: { log() {}, warn() {}, error() {} } }, { filename: 'model', timeout: 3000 });
  } catch (e) {
    throw new Error(where(e));
  }
  // (Through JSON: what is not a number, a string, a list or an object does not get out.)
  return JSON.parse(JSON.stringify({ model: model ?? null, profiles }));
}

if (process.argv[1] && import.meta.filename && process.argv[1] === import.meta.filename) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { text += d; });
  process.stdin.on('end', () => {
    try { process.stdout.write(JSON.stringify({ ok: true, ...evaluate(text) })); } catch (e) {
      // A model as it is being typed: what is whole of it so far, when that runs.
      if (process.argv.includes('--draft')) for (const tried of soFar(text)) {
        try { process.stdout.write(JSON.stringify({ ok: true, draft: true, ...evaluate(tried) })); return; } catch { /* a line less */ }
      }
      process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  });
}
