import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRetrieval } from '../scripts/lib/retrieval.mjs';

test('writeRetrieval emits record with all mandatory fields', () => {
  const sb = mkdtempSync(join(tmpdir(), 'll-retrieval-'));
  try {
    writeRetrieval({
      pluginData: sb,
      prefix: 'queries',
      command: 'query',
      query: 'test',
      results: [{ path: 'a.md' }, { path: 'peer:x/b.md' }],
      meta: { federated: false },
    });
    const month = new Date().toISOString().slice(0, 7);
    const file = join(sb, 'retrieval', `queries-${month}.jsonl`);
    assert.ok(existsSync(file), 'queries file should exist');
    const line = readFileSync(file, 'utf8').trim();
    const record = JSON.parse(line);
    // Mandatory fields:
    assert.ok(record.ts);
    assert.ok(record.session_id);
    assert.equal(record.command, 'query');
    assert.equal(record.query, 'test');
    assert.equal(record.result_count, 2);
    assert.equal(record.peer_results, 1);
    assert.deepEqual(record.top_paths, ['a.md', 'peer:x/b.md']);
    // Caller-provided meta:
    assert.equal(record.federated, false);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('writeRetrieval handles non-array results gracefully', () => {
  const sb = mkdtempSync(join(tmpdir(), 'll-retrieval-'));
  try {
    writeRetrieval({
      pluginData: sb,
      prefix: 'reads',
      command: 'memory-read',
      query: 'unused',
      results: null,
      meta: { file: 'mem.md' },
    });
    const month = new Date().toISOString().slice(0, 7);
    const record = JSON.parse(
      readFileSync(join(sb, 'retrieval', `reads-${month}.jsonl`), 'utf8').trim(),
    );
    assert.equal(record.result_count, 0);
    assert.deepEqual(record.top_paths, []);
    assert.equal(record.file, 'mem.md');
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('writeRetrieval is a no-op when pluginData is missing', () => {
  // Silent no-op rather than throw — same pattern as emitRetrieval (returns
  // early if resolvePluginData() returns null). Hooks fire in environments
  // where plugin-data may not be resolved yet; logging would create noise.
  assert.doesNotThrow(() =>
    writeRetrieval({
      pluginData: null,
      prefix: 'queries',
      command: 'query',
      query: 'x',
      results: [],
    }),
  );
});

test('writeRetrieval top_paths uses note_a fallback when path absent', () => {
  // Some result shapes (cluster, discriminate) carry note_a/note_b instead
  // of path. Same fallback the old vault-search.logRetrieval used.
  const sb = mkdtempSync(join(tmpdir(), 'll-retrieval-'));
  try {
    writeRetrieval({
      pluginData: sb,
      prefix: 'queries',
      command: 'discriminate',
      query: 'q',
      results: [{ note_a: 'x.md', note_b: 'y.md' }, { path: 'z.md' }],
    });
    const month = new Date().toISOString().slice(0, 7);
    const record = JSON.parse(
      readFileSync(join(sb, 'retrieval', `queries-${month}.jsonl`), 'utf8').trim(),
    );
    assert.deepEqual(record.top_paths, ['x.md', 'z.md']);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
