// tests/librarian-tools-duplicate.test.mjs : unit tests for scripts/librarian/tools/duplicate.mjs

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chat, httpError, startOllamaMock, structured } from './helpers/ollama-mock.mjs';

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
  const server = startOllamaMock();
  let duplicateCheck, submitDuplicateFlag;
  let calls;

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
  });

  after(() => {
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
    calls = 0;
    server.events.removeAllListeners();
    server.events.on('request:start', () => {
      calls += 1;
    });
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
    server.use(chat(() => structured({ relationship: 'duplicate', duplicate_of: NEIGHBOUR_A })));
    await duplicateCheck(TARGET, {
      bodyOverride: 'Some claim body.',
      neighboursOverride: NEIGHBOURS,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
  });

  it('duplicateCheck does not queue when model says "same_topic"', async () => {
    server.use(chat(() => structured({ relationship: 'same_topic', duplicate_of: null })));
    await duplicateCheck(TARGET, { bodyOverride: 'body', neighboursOverride: NEIGHBOURS });
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck skips when model names a non-neighbour', async () => {
    server.use(
      chat(() => structured({ relationship: 'duplicate', duplicate_of: '3-permanent/ghost.md' })),
    );
    await duplicateCheck(TARGET, { bodyOverride: 'body', neighboursOverride: NEIGHBOURS });
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck accepts neighbour identified by basename slug', async () => {
    server.use(chat(() => structured({ relationship: 'duplicate', duplicate_of: 'neighbour-a' })));
    await duplicateCheck(TARGET, { bodyOverride: 'body', neighboursOverride: NEIGHBOURS });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
  });

  it('duplicateCheck returns early when no body', async () => {
    await duplicateCheck(TARGET, { bodyOverride: null, neighboursOverride: NEIGHBOURS });
    assert.equal(calls, 0, 'a note with no body must not reach ollama');
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck skips gracefully on HTTP error', async () => {
    server.use(chat(() => httpError(500)));
    await duplicateCheck(TARGET, { bodyOverride: 'body', neighboursOverride: NEIGHBOURS });
    assert.equal(readQueue().length, 0);
  });

  it('duplicateCheck reads note body from VAULT_PATH when bodyOverride not set', async () => {
    let body;
    server.use(
      chat(async ({ request }) => {
        body = await request.json();
        return structured({ relationship: 'same_topic', duplicate_of: null });
      }),
    );
    // TARGET file exists in TEMP_VAULT with content
    await duplicateCheck(TARGET, { neighboursOverride: NEIGHBOURS });
    // The point of the test is that the body came off disk, so assert the disk
    // content actually reached ollama -- a request count alone would pass on a
    // prompt built from an empty string.
    assert.equal(calls, 1);
    assert.match(body.messages.map((m) => m.content).join('\n'), /Some claim body\./);
    assert.equal(readQueue().length, 0);
  });
});
