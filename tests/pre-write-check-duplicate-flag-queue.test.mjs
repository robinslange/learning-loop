// tests/pre-write-check-duplicate-flag-queue.test.mjs
//
// Covers checkDuplicateFlagQueue in hooks/pre-write-check.js: the cheap
// pre-scan read that lets a fresh librarian duplicate_flag short-circuit the
// gate's own reflect-scan for the same note path. checkDuplicateFlagQueue
// itself takes the already-read items array (checkDuplicateNote reads the
// queue via pendingItems() ONCE per gate run and passes the result down, so
// two call sites can't each pay for their own JSONL read).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), 'll-pwc-dupe-flag-' + runId);
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

function writeQueue(items) {
  mkdirSync(LIB_DIR, { recursive: true });
  writeFileSync(
    join(LIB_DIR, 'queue.jsonl'),
    items.map((i) => JSON.stringify(i)).join('\n') + '\n',
  );
  return items;
}

describe('pre-write-check: duplicate_flag queue consultation', () => {
  let preWriteCheck;

  before(async () => {
    mkdirSync(TEMP_DATA, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    preWriteCheck = await import('../plugin/hooks/pre-write-check.js?bust=dupe-flag-' + runId);
  });

  after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('a fresh duplicate_flag entry for the same path returns its verdict', () => {
    const items = writeQueue([
      {
        id: 'abc123',
        task: 'duplicate_flag',
        target: '0-inbox/new-note.md',
        duplicate_of: '3-permanent/sleep-existing.md',
        similarity: 0.91,
        reason: 'duplicate classifier (structured output)',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    ]);
    const result = preWriteCheck.checkDuplicateFlagQueue('0-inbox/new-note.md', items);
    assert.ok(result, 'expected a verdict from the fresh queue entry');
    assert.match(result, /Potential duplicate/);
    assert.match(result, /sleep-existing\.md/);
  });

  it('a stale duplicate_flag entry, past the TTL, is ignored', () => {
    const staleTs = new Date(Date.now() - HookConfig.DUPLICATE_FLAG_TTL_MS - 1000).toISOString();
    const items = writeQueue([
      {
        id: 'def456',
        task: 'duplicate_flag',
        target: '0-inbox/new-note.md',
        duplicate_of: '3-permanent/sleep-existing.md',
        similarity: 0.91,
        reason: 'duplicate classifier (structured output)',
        status: 'pending',
        created_at: staleTs,
      },
    ]);
    const result = preWriteCheck.checkDuplicateFlagQueue('0-inbox/new-note.md', items);
    assert.equal(result, null, 'a stale entry must not short-circuit the scan');
  });

  it('no matching entry for the path falls through', () => {
    const items = writeQueue([
      {
        id: 'ghi789',
        task: 'duplicate_flag',
        target: 'somewhere/else.md',
        duplicate_of: '3-permanent/sleep-existing.md',
        similarity: 0.91,
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    ]);
    const result = preWriteCheck.checkDuplicateFlagQueue('0-inbox/new-note.md', items);
    assert.equal(result, null);
  });

  it('an empty queue falls through', () => {
    const items = writeQueue([]);
    const result = preWriteCheck.checkDuplicateFlagQueue('0-inbox/new-note.md', items);
    assert.equal(result, null);
  });
});
