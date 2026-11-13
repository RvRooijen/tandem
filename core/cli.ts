// The command line: the same commands, from a shell. This is how the agent
// works, and how anything can be tried by hand.
//   node core/cli.ts list                      every command
//   node core/cli.ts run game.state            run one
//   node core/cli.ts run records.set '{"path":"flowers/tulip","value":{"value":7}}'
// Who is asking comes from TANDEM_BY (default: me), the round from TANDEM_ROUND.
export {};
const [, , verb, name, json] = process.argv;
const base = `http://127.0.0.1:${process.env.TANDEM_PORT ?? 5201}/api`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function call(path: string, init?: RequestInit) {
  try {
    const res = await fetch(base + path, init);
    return await res.json() as any;
  } catch (e) {
    fail(`the tandem server is not answering on ${base} (${e instanceof Error ? e.message : e}). Start it with: npm start`);
  }
}

if (verb === 'list') {
  const list = await call('/commands') as { name: string; about: string; kind: string; input: Record<string, string>; agent: string }[];
  const mine = (process.env.TANDEM_BY ?? 'me').startsWith('agent');
  for (const c of list) {
    if (name && !c.name.startsWith(name)) continue;
    const input = Object.entries(c.input).map(([k, t]) => `${k}: ${t}`).join(', ');
    const may = mine && c.agent !== 'yes' ? (c.agent === 'no' ? '  [the person only]' : '  [becomes a proposal]') : '';
    console.log(`${c.name}  (${c.kind})${may}\n    ${c.about}${input ? `\n    takes { ${input} }` : ''}`);
  }
} else if (verb === 'run' && name) {
  let input: unknown = {};
  if (json) { try { input = JSON.parse(json); } catch { fail(`the input is not JSON: ${json}`); } }
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-tandem-by': process.env.TANDEM_BY ?? 'me' };
  if (process.env.TANDEM_ROUND) headers['x-tandem-round'] = process.env.TANDEM_ROUND;
  const out = await call(`/run/${name}`, { method: 'POST', headers, body: JSON.stringify(input) });
  if (!out.ok) fail(`${name} was refused (${out.code}): ${out.error}`);
  console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 1));
} else {
  fail('usage: node core/cli.ts list [prefix]  |  node core/cli.ts run <command> [\'<json input>\']');
}
