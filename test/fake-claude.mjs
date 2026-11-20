#!/usr/bin/env node
// Stands in for the claude command line in tests: speaks its stream-json, and
// uses the tandem command line the way the agent does.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const resumed = args.includes('--resume');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

say({ type: 'system', subtype: 'init', session_id: 'sess-1' });

// A drawing worker: it draws in the folder it is run in, with the tools of the workspace, the way the guide says.
if (process.env.PIXEL_WORKER) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const name = prompt.match(/art\/([\w-]+)\.txt/)[1];
  const file = `art/${name}.txt`;
  if (prompt.includes('make it fail')) {
    say({ type: 'result', is_error: true, result: 'the pencil broke', session_id: 'sess-w' });
    process.exit(1);
  }
  const isNew = prompt.startsWith('The user wants a new project');
  const approved = prompt.includes('approves phase "silhouette"');
  let phase = 'color';
  let content;
  if (isNew) {
    phase = 'silhouette';
    content = '3 = #5a6988\n4 = #7d90ab\n\n@size 8 8\n// body\n@rect 2 3 4 5 3\n// head\n@rect 3 1 2 2 4\n';
  } else if (approved) {
    content = 'r = #d5392f\ns = #f2c9a0\n\n@size 8 8\n// body\n@rect 2 3 4 5 r\n// head\n@rect 3 1 2 2 s\n';
  } else {
    // Feedback on a drawing there is: one more shape, in its first colour.
    const text = readFileSync(file, 'utf8');
    const c = text.match(/^(\S) = #/m)[1];
    content = `${text.trimEnd()}\n@rect 0 0 1 1 ${c}\n`;
  }
  // The Write call as it streams in: its input in pieces, so whoever watches sees the drawing grow.
  const input = JSON.stringify({ file_path: `${process.cwd()}/${file}`, content });
  const cutAt = input.lastIndexOf('@rect') + 9;
  say({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write' } } });
  say({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(0, cutAt) } } });
  await new Promise((r) => setTimeout(r, 350));
  say({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(cutAt) } } });
  say({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  writeFileSync(file, content);
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
// Told that concepts were accepted: it has nothing to propose, it says what it heard.
if (prompt.includes('The person accepted')) {
  const text = `Seen: ${[...prompt.matchAll(/^- (.+)$/gm)].map((m) => m[1]).join(' | ')}${prompt.includes('[The message is about:]') ? ' With what they say now.' : ''}`;
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  say({ type: 'result', is_error: false, result: text, session_id: 'sess-1' });
  process.exit(0);
}
// Told that a drawing worker's round ended: it judges it the way the agent is asked to. A silhouette it approves,
// a drawing in colour it takes into the project, and a worker that failed or was stopped it closes.
if (prompt.includes('The drawing worker ')) {
  const id = prompt.match(/The drawing worker (w[a-z0-9]+),/)[1];
  const does = prompt.includes('has a silhouette ready') ? 'art.approve' : prompt.includes('ready in colour') ? 'art.accept' : 'art.close';
  const looked = does === 'art.close' ? { status: 0 } : spawnSync('tandem', ['run', 'art.look', JSON.stringify({ name: prompt.match(/, on ([\w-]+),/)[1], worker: id })], { encoding: 'utf8' });
  const out = spawnSync('tandem', ['run', does, JSON.stringify({ worker: id })], { encoding: 'utf8' });
  const text = `Worker ${id}: looked (${looked.status === 0 ? 'ok' : looked.stderr.trim()}), ${does} (${out.status === 0 ? 'ok' : out.stderr.trim()}).`;
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  say({ type: 'result', is_error: false, result: text, session_id: 'sess-1' });
  process.exit(0);
}
// Asked to code: it changes the game's code where it stands, which is its working copy.
if (prompt.startsWith('code:')) {
  const { writeFileSync } = await import('node:fs');
  if (prompt.includes('undo')) (await import('node:fs')).rmSync('src/seasons.js', { force: true });
  else writeFileSync('src/seasons.js', 'export const SEASONS = 4;\n');
  const tools = args.slice(args.indexOf('--allowedTools') + 1);
  const text = `Seasons ${prompt.includes('undo') ? 'taken out' : 'added'}. In the copy: ${process.cwd().endsWith('-tandem-work')}. May edit: ${tools.includes('Edit(**)')}; may run: ${tools.filter((t) => t.startsWith('Bash(') && !t.includes('tandem') && !t.includes('git ')).join(' ')}. Kept off: ${args.slice(args.indexOf('--disallowedTools') + 1).filter((t) => t.startsWith('Edit(')).join(' ')}. Note: ${prompt.includes('could not take') ? 'clash' : 'none'}.`;
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  say({ type: 'result', is_error: false, result: text, session_id: 'sess-1' });
  process.exit(0);
}
say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } });
// Its one idea, every time: a concept about the tulips, proposed through the command line like any agent would.
const idea = JSON.stringify({ name: `Tulips ${process.env.TANDEM_ROUND}`, text: 'Tulips are worth a bit more.' });
const command = `tandem run concepts.create '${idea}'`;
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const out = spawnSync('tandem', ['run', 'concepts.create', idea], { encoding: 'utf8' });
const text = `${resumed ? 'Again: ' : ''}I proposed it (${out.status === 0 ? 'ok' : out.stderr.trim()}). Allowed: ${args.slice(args.indexOf('--allowedTools') + 1)[0]}. About: ${prompt.includes('[The message is about:]') ? 'refs' : 'nothing'}.${prompt.includes('Tandem itself was changed') ? ` New: ${prompt.match(/before: (.*?)\. They are in your list/)?.[1]}.` : ''}${prompt.includes('[The person shared') ? ` Shared: ${[...prompt.matchAll(/^- (\S+) \((a picture|a file), "([^"]+)"\)$/gm)].map((m) => `${m[3]} is ${m[2]}, there: ${existsSync(m[1])}`).join('; ')}.` : ''}`;
say({ type: 'assistant', message: { usage: { input_tokens: 12, cache_read_input_tokens: resumed ? 60_000 : 30_000, cache_creation_input_tokens: 4_000, output_tokens: 88 }, content: [{ type: 'text', text }] } });
say({ type: 'result', is_error: false, result: text, session_id: 'sess-1' });
