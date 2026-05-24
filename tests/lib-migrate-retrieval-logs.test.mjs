import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateRetrievalLogsIfNeeded } from '../scripts/lib/migrate-retrieval-logs.mjs';

test('migrate removes pre-v2 jsonl files and writes marker', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-pd-'));
  const rdir = join(pd, 'retrieval');
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, 'queries-2026-04.jsonl'), '{"old":true}\n');
  writeFileSync(join(rdir, 'reads-2026-04.jsonl'), '{"old":true}\n');
  writeFileSync(join(rdir, 'keepme.txt'), 'not jsonl');
  try {
    const result = migrateRetrievalLogsIfNeeded(pd);
    assert.equal(result.skipped, false);
    assert.equal(result.removed, 2);
    assert.ok(existsSync(join(pd, '.retrieval-migrated-v2')));
    assert.ok(existsSync(join(rdir, 'keepme.txt')), 'non-jsonl files preserved');
    const remaining = readdirSync(rdir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(remaining.length, 0);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('migrate is idempotent — second call skips with already-migrated reason', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-pd-'));
  try {
    migrateRetrievalLogsIfNeeded(pd);
    const second = migrateRetrievalLogsIfNeeded(pd);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already-migrated');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('migrate creates the retrieval dir when absent (clean install path)', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-pd-'));
  try {
    const result = migrateRetrievalLogsIfNeeded(pd);
    assert.equal(result.skipped, false);
    assert.equal(result.removed, 0);
    assert.ok(existsSync(join(pd, 'retrieval')), 'retrieval dir should be created');
    assert.ok(existsSync(join(pd, '.retrieval-migrated-v2')));
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('migrate is a silent no-op when pluginData is null', () => {
  const result = migrateRetrievalLogsIfNeeded(null);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-plugin-data');
});

test('migrate preserves third-party retrieval jsonl files (cache-health, future plugins)', () => {
  // Regression test for Phase 4 code review: blanket .jsonl deletion would
  // wipe cache-health-YYYY-MM.jsonl (written by plugins/omc-cache-health,
  // read by scripts/cache-health-report.mjs). Only files matching the four
  // pre-canonical prefixes (queries-, reads-, episodic-queries-,
  // shadow-injection-) should be removed.
  const pd = mkdtempSync(join(tmpdir(), 'll-pd-'));
  const rdir = join(pd, 'retrieval');
  mkdirSync(rdir, { recursive: true });
  // Pre-canonical (should be removed):
  writeFileSync(join(rdir, 'queries-2026-04.jsonl'), '{"old":true}\n');
  writeFileSync(join(rdir, 'reads-2026-04.jsonl'), '{"old":true}\n');
  writeFileSync(join(rdir, 'episodic-queries-2026-04.jsonl'), '{"old":true}\n');
  writeFileSync(join(rdir, 'shadow-injection-2026-04.jsonl'), '{"old":true}\n');
  // Third-party / future plugins (must survive):
  writeFileSync(join(rdir, 'cache-health-2026-04.jsonl'), '{"keep":true}\n');
  writeFileSync(join(rdir, 'cache-health-2026-05.jsonl'), '{"keep":true}\n');
  writeFileSync(join(rdir, 'future-plugin-2026-04.jsonl'), '{"keep":true}\n');
  try {
    const result = migrateRetrievalLogsIfNeeded(pd);
    assert.equal(result.skipped, false);
    assert.equal(result.removed, 4, 'should remove exactly the 4 pre-canonical files');
    // Pre-canonical gone:
    for (const stale of [
      'queries-2026-04.jsonl',
      'reads-2026-04.jsonl',
      'episodic-queries-2026-04.jsonl',
      'shadow-injection-2026-04.jsonl',
    ]) {
      assert.ok(!existsSync(join(rdir, stale)), `${stale} should be removed`);
    }
    // Third-party survived:
    for (const kept of [
      'cache-health-2026-04.jsonl',
      'cache-health-2026-05.jsonl',
      'future-plugin-2026-04.jsonl',
    ]) {
      assert.ok(existsSync(join(rdir, kept)), `${kept} must NOT be deleted`);
    }
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});
