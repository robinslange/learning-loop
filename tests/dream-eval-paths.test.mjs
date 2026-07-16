import { test } from 'node:test';
import assert from 'node:assert';
import { DATA_PATHS } from '../plugin/scripts/lib/paths.mjs';

test('dream-eval paths resolve under plugin data', () => {
  const pd = '/tmp/pd';
  assert.strictEqual(DATA_PATHS.dreamEval(pd), '/tmp/pd/dream-eval');
  assert.strictEqual(DATA_PATHS.dreamEvalProbes(pd), '/tmp/pd/dream-eval/probes.jsonl');
  assert.strictEqual(DATA_PATHS.dreamEvalReports(pd), '/tmp/pd/dream-eval/reports');
});
