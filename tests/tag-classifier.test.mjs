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
import { countRequests } from './helpers/msw.mjs';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-tag-classifier-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIBRARIAN_DIR = join(TEMP_DATA, 'librarian');

const VOCAB = ['pharmacology', 'neuroscience', 'graphql', 'networking'];

function queuePath() {
  return join(LIBRARIAN_DIR, 'queue.jsonl');
}

function readQueue() {
  const p = queuePath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function statePath() {
  return join(LIBRARIAN_DIR, 'state.json');
}

function resetState() {
  writeFileSync(
    statePath(),
    JSON.stringify({
      visited: [],
      notes_visited: 0,
      link_suggestions: 0,
      voice_flags: 0,
      tag_suggestions: 0,
      staleness_suspects: 0,
      counters: {},
    }) + '\n',
  );
  if (existsSync(queuePath())) rmSync(queuePath());
}

describe('tag classifier structured-output suggestion', () => {
  const server = startOllamaMock();
  let requests;

  before(() => {
    mkdirSync(TEMP_VAULT, { recursive: true });
    mkdirSync(LIBRARIAN_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.VAULT_PATH = TEMP_VAULT;
  });

  beforeEach(() => {
    requests = countRequests();
  });

  after(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.VAULT_PATH;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('queues tag_suggestion with cleaned vocabulary-bounded tags', async () => {
    resetState();

    server.use(chat(() => structured({ suggested_tags: ['pharmacology', 'neuroscience'] })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-happy-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Body about pharmacokinetics of a nootropic.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });

    const items = readQueue();
    assert.equal(items.length, 1, 'expected one queue item');
    assert.equal(items[0].task, 'tag_suggestion');
    assert.equal(items[0].target, '3-permanent/foo.md');
    assert.deepEqual(items[0].suggested_tags, ['pharmacology', 'neuroscience']);
    assert.equal(items[0].existing_tags, '');

    const state = JSON.parse(readFileSync(statePath(), 'utf-8'));
    assert.equal(state.tag_suggestions, 1);
  });

  it('does not queue when model returns empty array', async () => {
    resetState();

    server.use(chat(() => structured({ suggested_tags: [] })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-empty-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Some body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });

    assert.equal(readQueue().length, 0);
  });

  it('filters out tags outside the vocabulary', async () => {
    resetState();

    server.use(chat(() => structured({ suggested_tags: ['pharmacology', 'made-up-tag'] })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-vocab-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });

    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['pharmacology']);
  });

  it('filters out tags already on the note', async () => {
    resetState();

    server.use(chat(() => structured({ suggested_tags: ['pharmacology', 'neuroscience'] })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-existing-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: 'pharmacology',
      vocabularyOverride: VOCAB,
    });

    const items = readQueue();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].suggested_tags, ['neuroscience']);
  });

  it('does not crash on malformed response', async () => {
    resetState();

    server.use(chat(() => unstructured('not json')));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-malformed-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });

    assert.equal(readQueue().length, 0);
  });

  it('skips gracefully on HTTP error from ollama', async () => {
    resetState();

    server.use(chat(() => httpError(500)));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-http-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });

    assert.equal(readQueue().length, 0);
  });

  it('logs timeout and skips submission when fetch aborts', async () => {
    resetState();

    // Not served through MSW: tagCheck fixes its own client timeout, and a
    // network mock cannot expire it sooner. The injected rejection is what
    // undici throws when AbortSignal.timeout fires.
    const timingOut = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    const mod = await import(
      `../plugin/scripts/librarian.mjs?bust=tag-timeout-${runId}-${randomBytes(4).toString('hex')}`
    );
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: 'Body.',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
      fetchOverride: timingOut,
    });

    assert.equal(readQueue().length, 0);
  });

  it('returns without queueing when body is empty', async () => {
    resetState();

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=tag-emptybody-${runId}`);
    await mod.__test__.tagCheck('3-permanent/foo.md', {
      bodyOverride: '',
      existingTagsOverride: '',
      vocabularyOverride: VOCAB,
    });

    assert.equal(requests(), 0, 'should short-circuit before fetch');
    assert.equal(readQueue().length, 0);
  });
});
