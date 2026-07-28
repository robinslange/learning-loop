import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { DATA_PATHS } from '../plugin/scripts/lib/paths.mjs';

// Expectations are built with join(), not POSIX string literals: DATA_PATHS
// uses join() internally, so hardcoding '/tmp/pd/dream-eval' asserts the
// separator of whoever ran the test and fails on Windows with '\tmp\pd\...'.
test('dream-eval paths resolve under plugin data', () => {
  const pd = join('/tmp', 'pd');
  assert.strictEqual(DATA_PATHS.dreamEval(pd), join(pd, 'dream-eval'));
  assert.strictEqual(DATA_PATHS.dreamEvalProbes(pd), join(pd, 'dream-eval', 'probes.jsonl'));
  assert.strictEqual(DATA_PATHS.dreamEvalReports(pd), join(pd, 'dream-eval', 'reports'));
});
