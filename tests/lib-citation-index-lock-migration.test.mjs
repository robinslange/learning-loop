// Phase 3c smoke test: citation-index.mjs migrated from its hand-rolled
// O_EXCL lock to lib/file-lock.withLock. Verify the migrated update path
// round-trips correctly, and that ELOCK_TIMEOUT is now surfaced via
// logError rather than silently dropping the update (the prior behaviour
// when every retry was contended).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function withStderrCapture(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

test('updateCitationIndex: round-trip — write under withLock then read back', async () => {
  const sb = mkdtempSync(join(tmpdir(), 'll-citation-roundtrip-'));
  // citation-index resolves its data dir from CLAUDE_PLUGIN_DATA at import
  // time, so we must set the env and use a fresh dynamic import.
  process.env.CLAUDE_PLUGIN_DATA = sb;
  try {
    const { updateCitationIndex, loadCitationIndex } = await import(
      `../scripts/lib/sources/citation-index.mjs?cachebust=${sb}`
    );

    await updateCitationIndex('12345', { authors: ['Doe J'], title: 'Test', year: 2024 }, 'note-a.md');
    await updateCitationIndex('12345', null, 'note-b.md');

    const index = loadCitationIndex();
    assert.ok(index['pmid:12345'], 'pmid entry must exist');
    assert.deepEqual(index['pmid:12345'].cited_in, ['note-a.md', 'note-b.md']);

    const indexPath = join(sb, 'data', 'citation-index.json');
    assert.ok(existsSync(indexPath), 'index file must exist on disk');
    const onDisk = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.deepEqual(onDisk['pmid:12345'].cited_in, ['note-a.md', 'note-b.md']);

    // Lock file must NOT linger after a successful release.
    assert.ok(
      !existsSync(indexPath + '.lock'),
      'lockfile must be cleaned up after withLock returns',
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(sb, { recursive: true, force: true });
  }
});

test('updateCitationIndex: ELOCK_TIMEOUT is surfaced via logError, not silently dropped', async () => {
  // Plant a lockfile with our own (live) pid so isProcessAlive() in
  // tryRemoveIfStale always returns true, the lock is never considered
  // stale, every retry is contended, and acquireLock eventually returns
  // null. withLock then throws ELOCK_TIMEOUT, which _doUpdate catches
  // and routes to logError.
  const sb = mkdtempSync(join(tmpdir(), 'll-citation-timeout-'));
  process.env.CLAUDE_PLUGIN_DATA = sb;
  try {
    const { updateCitationIndex } = await import(
      `../scripts/lib/sources/citation-index.mjs?cachebust=${sb}-timeout`
    );

    const indexPath = join(sb, 'data', 'citation-index.json');
    const lockPath = indexPath + '.lock';
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(sb, 'data'), { recursive: true });
    writeFileSync(lockPath, String(process.pid));

    const stderr = await withStderrCapture(async () => {
      // Fully await the queued promise so the entire withLock retry
      // cycle (5 × 30ms = 120ms minimum) completes inside the capture
      // window. _writeQueue chains the actual _doUpdate, so awaiting
      // the returned promise drains it.
      await updateCitationIndex('99999', { title: 'Lost' }, 'lost.md');
    });

    assert.ok(existsSync(lockPath), 'planted lockfile must still exist');
    assert.ok(!existsSync(indexPath), 'index file must not exist after a lock-timeout');
    // The contract this test was named for: ELOCK_TIMEOUT surfaces via
    // logError with the scope + pmid metadata. Without this assertion
    // the test passes even if the migration silently swallowed the
    // failure — exactly the regression Phase 3c set out to prevent.
    assert.match(
      stderr,
      /citation-index\.updateCitationIndex\.lockTimeout/,
      `expected logError scope on stderr; got: ${stderr.slice(0, 300)}`,
    );
    assert.match(
      stderr,
      /ELOCK_TIMEOUT/,
      `expected error code on stderr; got: ${stderr.slice(0, 300)}`,
    );
    assert.match(
      stderr,
      /99999/,
      `expected pmid in meta; got: ${stderr.slice(0, 300)}`,
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(sb, { recursive: true, force: true });
  }
});
