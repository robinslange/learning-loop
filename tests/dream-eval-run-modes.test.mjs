import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepeated, runSingle } from '../plugin/scripts/dream-eval/run.mjs';

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

test('runSingle snapshots before dream and reports before/after delta', async () => {
  const mem = mkdtempSync(join(tmpdir(), 'mem-'));
  writeFileSync(join(mem, 'MEMORY.md'), '- a.md');
  const work = mkdtempSync(join(tmpdir(), 'work-'));
  const probes = [{ probe_id: '1', tier: 'forward', expected_files: ['a.md'] }];
  let dreamed = false;
  const retrieveFn = async () => (dreamed ? [] : ['a.md']);
  const invokeDream = async (dir) => { dreamed = true; writeFileSync(join(dir, 'MEMORY.md'), '- gone'); };
  const readIndex = (dir) => readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  let snappedContentAtSnapshotTime = null;
  const snapshotFn = (dir) => { snappedContentAtSnapshotTime = readFileSync(join(dir, 'MEMORY.md'), 'utf8'); return join(work, 'snap'); };
  const out = await runSingle({ memoryDir: mem, probes, retrieveFn, invokeDream, readIndex, snapshotFn, workDir: work, k: 3 });
  assert.strictEqual(out.before.hit_rate, 1);
  assert.strictEqual(out.after.hit_rate, 0);
  assert.strictEqual(snappedContentAtSnapshotTime, '- a.md');
});
