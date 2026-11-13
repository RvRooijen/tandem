// Usage: node scripts/event.js <type> <name> [message...] [+ <type> <name> [message...]]...
// e.g.   node scripts/event.js feedback ninja "the hilt runs into the hand"
// Several events in one call, separated by a lone `+`, are sent in that order: one step for the agent instead
// of one per event, e.g. node scripts/event.js feedback ninja "arm too long" + round ninja "round 3: arm" + step ninja 2
import { sendEvent } from './bus.js';

const args = process.argv.slice(2);
const events = [[]];
for (const arg of args) arg === '+' ? events.push([]) : events.at(-1).push(arg);
if (!events.every((e) => e.length)) {
  console.error('Usage: node scripts/event.js <type> <name> [message...] [+ <type> <name> [message...]]...');
  process.exit(1);
}
for (const [type, name, ...rest] of events) await sendEvent({ type, name, message: rest.join(' ') });
