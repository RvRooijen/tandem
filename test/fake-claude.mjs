#!/usr/bin/env node
// Stands in for the claude command line in tests: speaks its stream-json, and
// uses the tandem command line the way the agent does.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const resumed = args.includes('--resume');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

say({ type: 'system', subtype: 'init', session_id: 'sess-1' });
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
