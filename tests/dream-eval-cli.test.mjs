import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from '../plugin/scripts/dream-eval/cli.mjs';

test('parseArgs defaults to single mode, 10 passes, no mine', () => {
  assert.deepStrictEqual(parseArgs([]), { mode: 'single', passes: 10, mine: false });
});

test('parseArgs reads mode, passes, and mine flags', () => {
  assert.deepStrictEqual(parseArgs(['--mode=control', '--mine']), { mode: 'control', passes: 10, mine: true });
  assert.deepStrictEqual(parseArgs(['--mode=repeated', '--passes=5']), { mode: 'repeated', passes: 5, mine: false });
});

test('parseArgs rejects an unknown mode', () => {
  assert.throws(() => parseArgs(['--mode=bogus']), /unknown mode/i);
});
