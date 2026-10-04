// tests/librarian-queue.test.mjs : unit tests for scripts/librarian/queue.mjs
//
// Tests the core persistent queue operations: append, read, expire, state load/save.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), 'll-queue-' + runId);
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

describe('librarian-queue', () => {
  let queue;

  before(async () => {
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    queue = await import('../plugin/scripts/librarian/queue.mjs?bust=queue-' + runId);
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
    assert.deepEqual(state.checked, {});
    assert.equal(state.notes_visited, 0);
  });

  it('saveState + loadState round-trips', () => {
    const saved = {
      checked: { 'a.md': 1000 },
      notes_visited: 5,
      counters: { x: 2 },
      last_note: 'a.md',
      started_at: null,
    };
    queue.saveState(saved);
    const loaded = queue.loadState();
    assert.deepEqual(loaded.checked, { 'a.md': 1000 });
    assert.equal(loaded.notes_visited, 5);
    assert.equal(loaded.counters.x, 2);
  });

  it('incrementCounter bumps the named counter', () => {
    let state = queue.loadState();
    state = queue.incrementCounter(state, 'rejected_self_link');
    state = queue.incrementCounter(state, 'rejected_self_link');
    assert.equal(state.counters.rejected_self_link, 2);
  });

  it('markChecked records the mtime each note was checked at', () => {
    let state = queue.loadState();
    state = queue.markChecked(state, 'a.md', 1000);
    state = queue.markChecked(state, 'b.md', 2000);
    state = queue.markChecked(state, 'a.md', 3000);
    assert.deepEqual(state.checked, { 'a.md': 3000, 'b.md': 2000 });
    assert.equal(state.notes_visited, 3);
    assert.equal(state.last_note, 'a.md');
  });

  it('trimToCap expires the oldest pending items beyond the cap and keeps the newest', () => {
    const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
    const add = (id, status, created_at) =>
      queue.appendItem({ id, task: 'a', status, created_at, target: 'x.md' });
    add('p-old', 'pending', at(1));
    add('p-new', 'pending', at(4));
    add('approved', 'approved', at(0));
    add('p-mid', 'pending', at(3));
    add('p-bad-date', 'pending', 'not a date');
    queue.trimToCap(2);
    assert.deepEqual(
      queue.readQueue().map((i) => [i.id, i.status, i.expired_reason]),
      [
        ['p-old', 'expired', 'over_cap'],
        ['p-new', 'pending', undefined],
        ['approved', 'approved', undefined],
        ['p-mid', 'pending', undefined],
        ['p-bad-date', 'expired', 'over_cap'],
      ],
    );
    assert.equal(queue.pendingCount(), 2);
  });

  it('trimToCap leaves a queue at or under the cap untouched', () => {
    queue.appendItem({
      id: 'a',
      task: 'a',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    queue.trimToCap(1);
    assert.deepEqual(
      queue.readQueue().map((i) => i.status),
      ['pending'],
    );
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

  it('expireStaleItems keeps pending items and resolved ones created within LIBRARIAN_QUEUE_TTL_MS', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const ttl = HookConfig.LIBRARIAN_QUEUE_TTL_MS;
    const vault = join(TEMP_ROOT, 'vault');
    mkdirSync(vault, { recursive: true });
    const live = join(vault, 'live.md');
    writeFileSync(live, '# live\n');
    const past = new Date(Date.now() - DAY);
    utimesSync(live, past, past);
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    const add = (id, status, created_at, target = 'missing.md') =>
      queue.appendItem({ id, task: 'a', status, created_at, target });
    add('expired-past-ttl', 'expired', ago(ttl + DAY));
    add('expired-within-ttl', 'expired', ago(ttl - DAY));
    add('expired-bad-date', 'expired', 'not a date');
    add('approved-past-ttl', 'approved', ago(ttl + DAY));
    add('approved-within-ttl', 'approved', ago(ttl - DAY));
    add('pending-past-ttl', 'pending', ago(ttl + DAY));
    add('pending-live', 'pending', ago(0), 'live.md');
    // No age, so never stale and never past the window: it waits for review.
    add('pending-bad-date', 'pending', 'not a date', 'live.md');
    queue.expireStaleItems(vault);
    assert.deepEqual(
      queue.readQueue().map((i) => [i.id, i.status]),
      [
        ['expired-within-ttl', 'expired'],
        ['approved-within-ttl', 'approved'],
        ['pending-live', 'pending'],
        ['pending-bad-date', 'pending'],
      ],
    );
  });

  it('resetState removes the state file', () => {
    queue.saveState({
      checked: { x: 1 },
      notes_visited: 1,
      counters: {},
      last_note: null,
      started_at: null,
    });
    queue.resetState();
    const state = queue.loadState();
    assert.deepEqual(state.checked, {});
  });
});

describe('librarian-queue: appendItem on a fresh plugin-data dir', () => {
  // Regression for the ensureDir()-before-lock ordering: withLock opens
  // `<queuePath>.lock` in the librarian dir, so a caller writing the very
  // first item to a plugin-data dir that has never seen a librarian
  // directory must not fail lock acquisition before ensureDir() runs. Unlike
  // the describe block above, this one does NOT pre-create the librarian dir.
  const freshRunId = randomBytes(4).toString('hex');
  const freshRoot = join(tmpdir(), 'll-queue-fresh-' + freshRunId);
  const freshData = join(freshRoot, 'plugin-data');
  let freshQueue;

  before(async () => {
    mkdirSync(freshData, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = freshData;
    freshQueue = await import(
      '../plugin/scripts/librarian/queue.mjs?bust=queue-fresh-' + freshRunId
    );
  });

  after(() => {
    rmSync(freshRoot, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  it('succeeds and creates the queue file when the librarian dir does not exist yet', () => {
    assert.equal(
      existsSync(join(freshData, 'librarian')),
      false,
      'librarian dir must not pre-exist',
    );
    freshQueue.appendItem({
      id: freshQueue.newItemId(),
      task: 'link_suggestion',
      target: 'foo.md',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    const qPath = join(freshData, 'librarian', 'queue.jsonl');
    assert.ok(existsSync(qPath), 'expected the queue file to be created');
    const items = freshQueue.readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].target, 'foo.md');
  });
});
