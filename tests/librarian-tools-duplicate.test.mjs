// tests/librarian-tools-duplicate.test.mjs : unit tests for scripts/librarian/tools/duplicate.mjs

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), 'll-tools-dup-' + runId);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

const TARGET = '3-permanent/target.md';
const NEIGHBOUR_A = '3-permanent/neighbour-a.md';
const NEIGHBOURS = [{ path: NEIGHBOUR_A, score: 0.93 }];

function queuePath() {
  return join(LIB_DIR, 'queue.jsonl');
}
function readQueue() {
  if (!existsSync(queuePath())) return [];
  return readFileSync(queuePath(), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('librarian-tools-duplicate', () => {
  let duplicateCheck, submitDuplicateFlag;
  let origFetch;

  before(async () => {
    mkdirSync(join(TEMP_VAULT, '3-permanent'), { recursive: true });
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.VAULT_PATH = TEMP_VAULT;
    writeFileSync(join(TEMP_VAULT, TARGET), '---\ntags: test\n---\nSome claim body.\n');
    writeFileSync(join(TEMP_VAULT, NEIGHBOUR_A), '---\ntags: test\n---\nSame claim body.\n');
    const mod = await import('../plugin/scripts/librarian/tools/duplicate.mjs?bust=dup-' + runId);
    duplicateCheck = mod.duplicateCheck;
    submitDuplicateFlag = mod.submitDuplicateFlag;
    origFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = origFetch;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.VAULT_PATH;
  });

  beforeEach(() => {
    if (existsSync(queuePath())) rmSync(queuePath());
    const sp = join(LIB_DIR, 'state.json');
    writeFileSync(
      sp,
      JSON.stringify({ visited: [], notes_visited: 0, duplicate_flags: 0, counters: {} }) + '\n',
    );
    globalThis.fetch = origFetch;
  });

  it('submitDuplicateFlag enqueues a duplicate_flag item', async () => {
    await submitDuplicateFlag({
      target: TARGET,
      duplicate_of: NEIGHBOUR_A,
      similarity: 0.93,
      reason: 'test',
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'duplicate_flag');
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
    assert.equal(items[0].similarity, 0.93);
  });

  it('submitDuplicateFlag rejects self-duplicates', async () => {
    const result = await submitDuplicateFlag({
      target: TARGET,
      duplicate_of: TARGET,
      reason: 'test',
    });
    assert.equal(result, 'Rejected: self-duplicate');
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck queues duplicate_flag when model says "duplicate"', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({ relationship: 'duplicate', duplicate_of: NEIGHBOUR_A }),
        },
      }),
    }));
    await duplicateCheck(TARGET, {
      bodyOverride: 'Some claim body.',
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
  });

  it('duplicateCheck does not queue when model says "same_topic"', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ relationship: 'same_topic', duplicate_of: null }) },
      }),
    }));
    await duplicateCheck(TARGET, {
      bodyOverride: 'body',
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck skips when model names a non-neighbour', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            relationship: 'duplicate',
            duplicate_of: '3-permanent/ghost.md',
          }),
        },
      }),
    }));
    await duplicateCheck(TARGET, {
      bodyOverride: 'body',
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck accepts neighbour identified by basename slug', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({ relationship: 'duplicate', duplicate_of: 'neighbour-a' }),
        },
      }),
    }));
    await duplicateCheck(TARGET, {
      bodyOverride: 'body',
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
  });

  it('duplicateCheck returns early when no body', async () => {
    let called = false;
    globalThis.fetch = mock.fn(async () => {
      called = true;
      return {};
    });
    await duplicateCheck(TARGET, {
      bodyOverride: null,
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(called, false);
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck skips gracefully on HTTP error', async () => {
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 500 }));
    await duplicateCheck(TARGET, {
      bodyOverride: 'body',
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck reads note body from VAULT_PATH when bodyOverride not set', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ relationship: 'same_topic', duplicate_of: null }) },
      }),
    }));
    // TARGET file exists in TEMP_VAULT with content
    await duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
      fetchOverride: globalThis.fetch,
    });
    // Should reach ollama (body was read), model returned same_topic so no queue item
    assert.equal(globalThis.fetch.mock.callCount(), 1);
    assert.equal(readQueue().length, 0);
  });
});
