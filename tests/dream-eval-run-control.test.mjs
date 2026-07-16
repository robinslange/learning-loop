import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runControl } from '../plugin/scripts/dream-eval/run.mjs';

test('runControl reports dream_hurts when consolidation lowers forward hit rate', async () => {
  const mem = mkdtempSync(join(tmpdir(), 'mem-'));
  writeFileSync(join(mem, 'MEMORY.md'), '- a.md');
  const work = mkdtempSync(join(tmpdir(), 'work-'));
  const probes = [{ probe_id: '1', tier: 'forward', expected_files: ['a.md'] }];
  // control fork retrieves a.md correctly; consolidated fork loses it.
  const retrieveFn = async ({ indexText }) => (indexText.includes('DREAMED') ? ['z.md'] : ['a.md']);
  const invokeDream = async (dir) => writeFileSync(join(dir, 'MEMORY.md'), '- DREAMED');
  const readIndex = (dir) => readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  const out = await runControl({
    memoryDir: mem,
    workDir: work,
    probes,
    retrieveFn,
    invokeDream,
    readIndex,
    k: 3,
  });
  assert.strictEqual(out.verdict, 'dream_hurts');
  assert.strictEqual(out.control.hit_rate, 1);
  assert.strictEqual(out.consolidated.hit_rate, 0);
});
