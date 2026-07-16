import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepeated } from '../plugin/scripts/dream-eval/run.mjs';

test('runRepeated tracks a drift curve and surviving-file count per pass', async () => {
  const mem = mkdtempSync(join(tmpdir(), 'mem-'));
  writeFileSync(join(mem, 'MEMORY.md'), '- a.md');
  const work = mkdtempSync(join(tmpdir(), 'work-'));
  const probes = [{ probe_id: '1', tier: 'forward', expected_files: ['a.md'] }];
  let passCount = 0;
  const invokeDream = async () => { passCount++; };
  const retrieveFn = async () => (passCount >= 2 ? [] : ['a.md']);   // degrades after pass 2
  const readIndex = () => '- a.md';
  const expectedExists = () => passCount < 3;                         // file compressed away at pass 3
  const out = await runRepeated({ memoryDir: mem, workDir: work, probes, retrieveFn, invokeDream, readIndex, passes: 3, k: 3, expectedExists });
  assert.strictEqual(out.curve.length, 3);
  assert.strictEqual(out.curve[0].hit_rate, 1);
  assert.strictEqual(out.curve[2].hit_rate, 0);
  assert.strictEqual(out.curve[2].expected_files_surviving, 0);
});
