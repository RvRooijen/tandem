// A model's text read: its program run where it can do nothing else
// (evaluate.ts, in a node of its own), and what it gave back checked
// (format.ts). The same text is read once: what came of it is kept.
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkModel, type Model, type Profile } from './format.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ARGS = ['--no-warnings', '--permission', `--allow-fs-read=${HERE}`, '--max-old-space-size=256', `${HERE}evaluate.ts`];
/** As it is being typed: what is whole of it so far is what is read, leniently (see draft.ts). */
const DRAFT = [...ARGS, '--draft'];

export interface Read { model: Model; profiles: Profile[]; /** Only what was whole of a text being typed. */ draft?: boolean }

const kept = new Map<string, Read | Error>();
function keep(text: string, what: Read | Error) {
  kept.set(text, what);
  if (kept.size > 40) kept.delete(kept.keys().next().value!);
  if (what instanceof Error) throw what;
  return what;
}

function made(out: string, lenient = false): Read {
  let got: { ok: boolean; error?: string; model?: unknown; profiles?: Profile[]; draft?: boolean };
  try { got = JSON.parse(out); } catch { throw new Error('the model\'s program gave nothing back (too slow, or too large)'); }
  if (!got.ok) throw new Error(got.error ?? 'the model could not be read');
  return { model: checkModel(got.model, lenient), profiles: got.profiles ?? [], ...(got.draft && { draft: true }) };
}

/** Read a model's text; throws with what is wrong with it. */
export function readModel(text: string): Read {
  const had = kept.get(text);
  if (had) { if (had instanceof Error) throw had; return had; }
  try {
    return keep(text, made(execFileSync(process.execPath, ARGS, { input: text, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'] })));
  } catch (e) {
    return keep(text, e instanceof Error && !('status' in e) ? e : new Error('the model\'s program did not end in time, or used too much memory'));
  }
}

/** The same, without holding the engine up while it runs. A draft (a text being typed) gives what is whole of it so far. */
export function readModelLater(text: string, draft = false): Promise<Read> {
  if (draft) return new Promise((ok, fail) => {
    const child = execFile(process.execPath, DRAFT, { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 << 20 }, (err, stdout) => {
      try { if (err && !stdout) throw new Error('the model\'s program did not end in time'); ok(made(stdout, true)); } catch (e) { fail(e); }
    });
    child.stdin!.end(text);
  });
  const had = kept.get(text);
  if (had) return had instanceof Error ? Promise.reject(had) : Promise.resolve(had);
  return new Promise((ok, fail) => {
    const child = execFile(process.execPath, ARGS, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 << 20 }, (err, stdout) => {
      try {
        if (err && !stdout) throw new Error('the model\'s program did not end in time, or used too much memory');
        ok(keep(text, made(stdout)));
      } catch (e) {
        if (!kept.has(text)) kept.set(text, e as Error);
        fail(e);
      }
    });
    child.stdin!.end(text);
  });
}
