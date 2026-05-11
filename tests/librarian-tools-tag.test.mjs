// tests/librarian-tools-tag.test.mjs : unit tests for scripts/librarian/tools/tag-suggest.mjs

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), 'll-tools-tag-' + runId);
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');
const VOCAB = ['pharmacology', 'neuroscience', 'graphql'];

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

describe('librarian-tools-tag', () => {
  let tagCheck, submitTagSuggestion;
  let origFetch;

  before(async () => {
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    const mod = await import('../scripts/librarian/tools/tag-suggest.mjs?bust=tag-' + runId);
    tagCheck = mod.tagCheck;
    submitTagSuggestion = mod.submitTagSuggestion;
    origFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = origFetch;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  beforeEach(() => {
    if (existsSync(queuePath())) rmSync(queuePath());
    const sp = join(LIB_DIR, 'state.json');
    writeFileSync(
      sp,
      JSON.stringify({ visited: [], notes_visited: 0, tag_suggestions: 0, counters: {} }) + '\n',
    );
    globalThis.fetch = origFetch;
  });

  it('submitTagSuggestion enqueues a tag_suggestion item', async () => {
    await submitTagSuggestion({
      target: '0-inbox/foo.md',
      suggested_tags: ['pharmacology'],
      existing_tags: '',
      reason: 'test',
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'tag_suggestion');
    assert.deepEqual(items[0].suggested_tags, ['pharmacology']);
  });

  it('tagCheck queues tag_suggestion with valid vocabulary-bounded tags', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ suggested_tags: ['pharmacology', 'neuroscience'] }) },
      }),
    }));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body about nootropics.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
      fetchOverride: globalThis.fetch,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['pharmacology', 'neuroscience']);
  });

  it('tagCheck filters out tags outside vocabulary', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ suggested_tags: ['pharmacology', 'made-up'] }) },
      }),
    }));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
      fetchOverride: globalThis.fetch,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['pharmacology']);
  });

  it('tagCheck filters out existing tags', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ suggested_tags: ['pharmacology', 'neuroscience'] }) },
      }),
    }));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: 'pharmacology',
      vocabularyOverride: VOCAB,
      fetchOverride: globalThis.fetch,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['neuroscience']);
  });

  it('tagCheck skips when body is empty', async () => {
    let called = false;
    globalThis.fetch = mock.fn(async () => {
      called = true;
      return {};
    });
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: '',
      vocabularyOverride: VOCAB,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(called, false);
    assert.equal(readQueue().length, 0);
  });

  it('tagCheck skips when vocabulary is empty', async () => {
    let called = false;
    globalThis.fetch = mock.fn(async () => {
      called = true;
      return {};
    });
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      vocabularyOverride: [],
      fetchOverride: globalThis.fetch,
    });
    assert.equal(called, false);
    assert.equal(readQueue().length, 0);
  });

  it('tagCheck skips gracefully on HTTP error', async () => {
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 500 }));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      vocabularyOverride: VOCAB,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(readQueue().length, 0);
  });

  it('tagCheck does not crash on malformed JSON response', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: 'bad json' } }),
    }));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      vocabularyOverride: VOCAB,
      fetchOverride: globalThis.fetch,
    });
    assert.equal(readQueue().length, 0);
  });
});
