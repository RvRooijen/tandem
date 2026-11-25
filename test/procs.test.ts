// What looks after the core keeps the agent and the workers going while the core starts again: what they write
// meanwhile waits for the next core, which takes them up; a core that ends without letting go takes them with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcHost } from '../core/procs.ts';

type Sent = { proc: string; id?: string; data?: string; code?: number | null };

function core(host: ReturnType<typeof createProcHost>) {
  const got: Sent[] = [];
  host.connect((m) => got.push(m as Sent));
  return got;
}
const out = (got: Sent[], id: string) => got.filter((m) => m.proc === 'out' && m.id === id).map((m) => m.data).join('');
async function until(what: () => unknown, says: string) {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > 10_000) throw new Error(`waited too long for ${says}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
// A stand-in that reads its input, says it in two lines a while apart, and ends.
const script = `let i='';process.stdin.on('data',d=>i+=d).on('end',()=>{process.stdout.write('one '+i.trim()+'\\nhalf');setTimeout(()=>{process.stdout.write(' a line\\ntwo\\n');process.exit(3)},400)})`;
const start = (id: string) => ({ proc: 'start' as const, id, cmd: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env, input: 'hello' });

test('a process goes on while the core starts again, and the next core gets what it wrote meanwhile, in whole lines', async () => {
  const host = createProcHost();
  const first = core(host);
  host.message(start('agent'));
  await until(() => out(first, 'agent'), 'the first line');
  assert.equal(out(first, 'agent'), 'one hello\n', 'half a line waits for the rest of it');

  host.message({ proc: 'detach' });
  assert.equal(first.at(-1)!.proc, 'detached');
  host.exited();
  assert.equal(host.offer(), 'agent', 'the next core is told it is there');

  await new Promise((r) => setTimeout(r, 700));
  const second = core(host);
  host.message({ proc: 'attach', id: 'agent' });
  assert.equal(out(second, 'agent'), 'half a line\ntwo\n');
  assert.deepEqual(second.at(-1), { proc: 'exit', id: 'agent', code: 3 });
  assert.equal(host.offer(), '', 'taken up and ended: it is gone');
});

test('a core that ends without letting go takes its processes with it; one that is asked for and not there has ended', async () => {
  const host = createProcHost();
  core(host);
  host.message(start('worker:w1'));
  host.exited();
  assert.equal(host.offer(), '');
  const next = core(host);
  host.message({ proc: 'attach', id: 'worker:w1' });
  assert.deepEqual(next, [{ proc: 'exit', id: 'worker:w1', code: null }]);
});
