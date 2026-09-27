// tests/librarian-tools-tag.test.mjs : unit tests for scripts/librarian/tools/tag-suggest.mjs

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  chat,
  httpError,
  startOllamaMock,
  structured,
  unstructured,
} from './helpers/ollama-mock.mjs';

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
  const server = startOllamaMock();
  let tagCheck, submitTagSuggestion;
  let calls;

  before(async () => {
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    const mod = await import('../plugin/scripts/librarian/tools/tag-suggest.mjs?bust=tag-' + runId);
    tagCheck = mod.tagCheck;
    submitTagSuggestion = mod.submitTagSuggestion;
  });

  after(() => {
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
    calls = 0;
    server.events.removeAllListeners();
    server.events.on('request:start', () => {
      calls += 1;
    });
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
    server.use(chat(() => structured({ suggested_tags: ['pharmacology', 'neuroscience'] })));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body about nootropics.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['pharmacology', 'neuroscience']);
  });

  it('tagCheck filters out tags outside vocabulary', async () => {
    server.use(chat(() => structured({ suggested_tags: ['pharmacology', 'made-up'] })));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['pharmacology']);
  });

  it('tagCheck filters out existing tags', async () => {
    server.use(chat(() => structured({ suggested_tags: ['pharmacology', 'neuroscience'] })));
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: 'pharmacology',
      vocabularyOverride: VOCAB,
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['neuroscience']);
  });

  it('tagCheck skips when body is empty', async () => {
    await tagCheck('0-inbox/foo.md', { bodyOverride: '', vocabularyOverride: VOCAB });
    assert.equal(calls, 0, 'an empty body must not reach ollama');
    assert.equal(readQueue().length, 0);
  });

  it('tagCheck skips when vocabulary is empty', async () => {
    await tagCheck('0-inbox/foo.md', { bodyOverride: 'Body.', vocabularyOverride: [] });
    assert.equal(calls, 0, 'an empty vocabulary must not reach ollama');
    assert.equal(readQueue().length, 0);
  });

  it('tagCheck skips gracefully on HTTP error', async () => {
    server.use(chat(() => httpError(500)));
    await tagCheck('0-inbox/foo.md', { bodyOverride: 'Body.', vocabularyOverride: VOCAB });
    assert.equal(readQueue().length, 0);
  });

  it('tagCheck does not crash on malformed JSON response', async () => {
    server.use(chat(() => unstructured('bad json')));
    await tagCheck('0-inbox/foo.md', { bodyOverride: 'Body.', vocabularyOverride: VOCAB });
    assert.equal(readQueue().length, 0);
  });

  it('sends the note body and the vocabulary ollama is asked to choose from', async () => {
    // The prompt is the only thing that bounds the model to the vault's own
    // tags. A stub that answers regardless of what it was asked cannot notice
    // the body or the vocabulary going missing from the request.
    let body;
    server.use(
      chat(async ({ request }) => {
        body = await request.json();
        return structured({ suggested_tags: ['graphql'] });
      }),
    );
    await tagCheck('0-inbox/foo.md', {
      bodyOverride: 'A note about resolvers.',
      vocabularyOverride: VOCAB,
    });
    const prompt = body.messages.map((m) => m.content).join('\n');
    assert.match(prompt, /A note about resolvers\./);
    for (const tag of VOCAB) assert.ok(prompt.includes(tag), `vocabulary must carry ${tag}`);
  });
});
