// What a playtest says: when each milestone came, and between two runs what moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, type Pacing } from '../playtest/pacing.ts';

test('two runs side by side say what moved', () => {
  const a: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.2, shovel: 14, awake: 66, old: 400 }, length: 600, later: [], took: 1 };
  const b: Pacing = { profile: 'eager', minutes: { start: 0, gerald: 1.3, shovel: 9, awake: 66.2, hat: 300 }, length: 500, later: [], took: 1 };
  assert.deepEqual(compare(a, b), [
    { milestone: 'shovel', before: 14, after: 9, change: -35.7 },
    { milestone: 'hat', before: undefined, after: 300 },
    { milestone: 'old', before: 400, after: undefined },
  ]);
});
