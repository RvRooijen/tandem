#!/usr/bin/env node
// Stands in for the claude command line in tests: speaks its stream-json, and
// uses the tandem command line the way the agent does.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const resumed = args.includes('--resume');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

say({ type: 'system', subtype: 'init', session_id: 'sess-1' });

// A drawing worker: it draws in the folder it is run in, with the tools of the workspace, the way the guide says.
if (process.env.PIXEL_WORKER) {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const name = prompt.match(/art\/([\w-]+)\.txt/)[1];
  const file = `art/${name}.txt`;
  if (prompt.includes('make it fail')) {
    say({ type: 'result', is_error: true, result: 'the pencil broke', session_id: 'sess-w' });
    process.exit(1);
  }
  const isNew = prompt.startsWith('The user wants a new project');
  const approved = prompt.includes('approves phase "silhouette"');
  let phase = 'color';
  if (isNew) {
    phase = 'silhouette';
    writeFileSync(file, '3 = #5a6988\n4 = #7d90ab\n\n@size 8 8\n// body\n@rect 2 3 4 5 3\n// head\n@rect 3 1 2 2 4\n');
  } else if (approved) {
    writeFileSync(file, 'r = #d5392f\ns = #f2c9a0\n\n@size 8 8\n// body\n@rect 2 3 4 5 r\n// head\n@rect 3 1 2 2 s\n');
  } else {
    // Feedback on a drawing there is: one more shape, in its first colour.
    const text = readFileSync(file, 'utf8');
    const c = text.match(/^(\S) = #/m)[1];
    writeFileSync(file, `${text.trimEnd()}\n@rect 0 0 1 1 ${c}\n`);
  }
  const tool = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
  const sent = tool('scripts/event.js', 'round', name, 'round 1: block it out', '+', 'phase', name, phase);
  const rendered = tool('scripts/render.js', file);
  const text = `${approved ? 'Coloured' : isNew ? 'Blocked out' : 'Changed'} ${name}. Render ${rendered.status === 0 && existsSync(`out/${name}.png`) ? 'ok' : rendered.stderr.trim().split('\n').pop()}, events ${sent.status === 0 ? 'ok' : 'failed'}. Depth kept: ${existsSync(`depth/${name}.txt`)}. Tools: ${args.slice(args.indexOf('--allowedTools') + 1).filter((t) => t.startsWith('Write(art')).join(' ')}.`;
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${process.cwd()}/${file}` } }] } });
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  say({ type: 'result', is_error: false, result: text, session_id: 'sess-w' });
  process.exit(0);
}

if (prompt.startsWith('fail')) {
  say({ type: 'result', is_error: true, result: 'out of patience', session_id: 'sess-1' });
  process.exit(1);
}
say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } });
const command = `node core/cli.ts run records.set '{"path":"flowers/tulip","value":{"value":8},"note":"a little more"}'`;
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const out = spawnSync(process.execPath, ['--no-warnings', 'core/cli.ts', 'run', 'records.set', '{"path":"flowers/tulip","value":{"value":8},"note":"a little more"}'], { encoding: 'utf8' });
const text = `${resumed ? 'Again: ' : ''}I proposed it (${out.status === 0 ? 'ok' : out.stderr.trim()}). Allowed: ${args.slice(args.indexOf('--allowedTools') + 1)[0]}. About: ${prompt.includes('[The message is about:]') ? 'refs' : 'nothing'}.`;
say({ type: 'assistant', message: { usage: { input_tokens: 12, cache_read_input_tokens: resumed ? 60_000 : 30_000, cache_creation_input_tokens: 4_000, output_tokens: 88 }, content: [{ type: 'text', text }] } });
say({ type: 'result', is_error: false, result: text, session_id: 'sess-1' });
