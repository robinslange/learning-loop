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
