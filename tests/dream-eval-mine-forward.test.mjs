import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mineForward, writeProbes } from '../plugin/scripts/dream-eval/mine-probes.mjs';
import { DATA_PATHS } from '../plugin/scripts/lib/paths.mjs';

test('mineForward matches a correction utterance and binds by token', () => {
  const mem = mkdtempSync(join(tmpdir(), 'mem-'));
  writeFileSync(join(mem, 'location.md'), 'Robin lives in Auckland New Zealand');
  const lines = [{ session: 's1', text: "no, it's actually Auckland not Sydney" }];
  const probes = mineForward({ archiveLines: lines, memoryDir: mem });
  assert.ok(probes.some((p) => p.tier === 'forward' && p.expected_files.includes('location.md')));
});

test('writeProbes dedupes identical probes', () => {
  const pd = mkdtempSync(join(tmpdir(), 'pd-'));
  const p = [{ tier: 'forward', question: 'q', expected_files: ['a.md'] }];
  writeProbes(pd, p);
  writeProbes(pd, p);
  const lines = readFileSync(DATA_PATHS.dreamEvalProbes(pd), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.strictEqual(lines.length, 1);
});
