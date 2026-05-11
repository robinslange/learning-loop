// tests/librarian-queue.test.mjs : unit tests for scripts/librarian/queue.mjs
//
// Tests the core persistent queue operations: append, read, expire, state load/save.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), 'll-queue-' + runId);
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

describe('librarian-queue', () => {
  let queue;

  before(async () => {
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    queue = await import('../scripts/librarian/queue.mjs?bust=queue-' + runId);
  });

  after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  beforeEach(() => {
    queue.resetState();
    const qPath = join(LIB_DIR, 'queue.jsonl');
    if (existsSync(qPath)) rmSync(qPath);
  });

  it('appendItem writes a JSON line and readQueue returns it', () => {
    const item = {
      id: queue.newItemId(),
      task: 'link_suggestion',
      target: 'foo.md',
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    queue.appendItem(item);
    const items = queue.readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'link_suggestion');
    assert.equal(items[0].target, 'foo.md');
  });

  it('appendItem is additive — multiple calls produce multiple lines', () => {
    queue.appendItem({
      id: queue.newItemId(),
      task: 'a',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    queue.appendItem({
      id: queue.newItemId(),
      task: 'b',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    assert.equal(queue.readQueue().length, 2);
  });

  it('pendingCount counts only pending items', () => {
    queue.appendItem({
      id: queue.newItemId(),
      task: 'a',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    queue.appendItem({
      id: queue.newItemId(),
      task: 'b',
      status: 'approved',
      created_at: new Date().toISOString(),
    });
    assert.equal(queue.pendingCount(), 1);
  });

  it('loadState returns default state when state file missing', () => {
    const state = queue.loadState();
    assert.deepEqual(state.visited, []);
    assert.equal(state.notes_visited, 0);
  });

  it('saveState + loadState round-trips', () => {
    const saved = {
      visited: ['a.md'],
      notes_visited: 5,
      counters: { x: 2 },
      last_note: 'a.md',
      started_at: null,
    };
    queue.saveState(saved);
    const loaded = queue.loadState();
    assert.deepEqual(loaded.visited, ['a.md']);
    assert.equal(loaded.notes_visited, 5);
    assert.equal(loaded.counters.x, 2);
  });

  it('incrementCounter bumps the named counter', () => {
    let state = queue.loadState();
    state = queue.incrementCounter(state, 'rejected_self_link');
    state = queue.incrementCounter(state, 'rejected_self_link');
    assert.equal(state.counters.rejected_self_link, 2);
  });

  it('markVisited appends note to visited', () => {
    let state = queue.loadState();
    state = queue.markVisited(state, 'a.md');
    state = queue.markVisited(state, 'b.md');
    assert.deepEqual(state.visited, ['a.md', 'b.md']);
    assert.equal(state.notes_visited, 2);
    assert.equal(state.last_note, 'b.md');
  });

  it('newItemId returns a 12-char hex string', () => {
    const id = queue.newItemId();
    assert.match(id, /^[0-9a-f]{12}$/);
  });

  it('expireStaleItems marks 30-day-old items expired', () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    queue.appendItem({
      id: queue.newItemId(),
      task: 'a',
      status: 'pending',
      created_at: oldDate,
      target: 'missing.md',
    });
    queue.expireStaleItems('/tmp/nonexistent-vault');
    const items = queue.readQueue();
    assert.equal(items[0].status, 'expired');
    assert.equal(items[0].expired_reason, 'stale');
  });

  it('expireStaleItems skips non-pending items', () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    queue.appendItem({ id: queue.newItemId(), task: 'a', status: 'approved', created_at: oldDate });
    queue.expireStaleItems('/tmp/nonexistent-vault');
    const items = queue.readQueue();
    assert.equal(items[0].status, 'approved');
  });

  it('resetState removes the state file', () => {
    queue.saveState({
      visited: ['x'],
      notes_visited: 1,
      counters: {},
      last_note: null,
      started_at: null,
    });
    queue.resetState();
    const state = queue.loadState();
    assert.deepEqual(state.visited, []);
  });
});
