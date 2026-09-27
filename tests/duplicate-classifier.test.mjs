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
const TEMP_ROOT = join(tmpdir(), `ll-dup-classifier-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIBRARIAN_DIR = join(TEMP_DATA, 'librarian');

const TARGET = '3-permanent/target.md';
const NEIGHBOUR_A = '3-permanent/neighbour-a.md';
const NEIGHBOUR_B = '3-permanent/neighbour-b.md';

const NEIGHBOURS = [
  { path: NEIGHBOUR_A, score: 0.93 },
  { path: NEIGHBOUR_B, score: 0.81 },
];

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
      duplicate_flags: 0,
      staleness_suspects: 0,
      counters: {},
    }) + '\n',
  );
  if (existsSync(queuePath())) rmSync(queuePath());
}

describe('duplicate classifier structured-output flag', () => {
  const server = startOllamaMock();
  let calls;

  before(() => {
    mkdirSync(join(TEMP_VAULT, '3-permanent'), { recursive: true });
    mkdirSync(LIBRARIAN_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.VAULT_PATH = TEMP_VAULT;

    writeFileSync(join(TEMP_VAULT, TARGET), '---\nstatus: inbox\n---\nClaim about widgets.\n');
    writeFileSync(
      join(TEMP_VAULT, NEIGHBOUR_A),
      '---\nstatus: permanent\n---\nThe same claim about widgets.\n',
    );
    writeFileSync(
      join(TEMP_VAULT, NEIGHBOUR_B),
      '---\nstatus: permanent\n---\nA different claim about gadgets.\n',
    );
  });

  beforeEach(() => {
    calls = 0;
    server.events.removeAllListeners();
    server.events.on('request:start', () => {
      calls += 1;
    });
  });

  after(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.VAULT_PATH;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('queues duplicate_flag when model returns "duplicate" with valid neighbour', async () => {
    resetState();

    server.use(chat(() => structured({ relationship: 'duplicate', duplicate_of: NEIGHBOUR_A })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-happy-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'duplicate_flag');
    assert.equal(items[0].target, TARGET);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
    assert.equal(items[0].similarity, 0.93);

    const state = JSON.parse(readFileSync(statePath(), 'utf-8'));
    assert.equal(state.duplicate_flags, 1);
  });

  it('does not queue when model returns "same_topic"', async () => {
    resetState();

    server.use(chat(() => structured({ relationship: 'same_topic', duplicate_of: null })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-same-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it('does not queue when model returns "unrelated"', async () => {
    resetState();

    server.use(chat(() => structured({ relationship: 'unrelated', duplicate_of: null })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-unrel-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it('skips when model names a non-neighbour as duplicate', async () => {
    resetState();

    server.use(
      chat(() =>
        structured({ relationship: 'duplicate', duplicate_of: '3-permanent/some-other-note.md' }),
      ),
    );

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-nonbr-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it('accepts a neighbour identified by basename slug', async () => {
    resetState();

    server.use(chat(() => structured({ relationship: 'duplicate', duplicate_of: 'neighbour-a' })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-slug-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
  });

  it('does not crash on malformed response', async () => {
    resetState();

    server.use(chat(() => unstructured('unrelated')));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-malformed-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it('skips gracefully on HTTP error from ollama', async () => {
    resetState();

    server.use(chat(() => httpError(500)));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-http-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it('logs timeout and skips submission when fetch aborts', async () => {
    resetState();

    // Not served through MSW: duplicateCheck fixes its own client timeout, and
    // a network mock cannot expire it sooner. The injected rejection is what
    // undici throws when AbortSignal.timeout fires.
    const timingOut = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    const mod = await import(
      `../plugin/scripts/librarian.mjs?bust=dup-timeout-${runId}-${randomBytes(4).toString('hex')}`
    );
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
      fetchOverride: timingOut,
    });

    assert.equal(readQueue().length, 0);
  });

  it('returns without queueing when there are no neighbours', async () => {
    resetState();

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=dup-noneigh-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, { neighboursOverride: [] });

    assert.equal(calls, 0, 'a note with no neighbours must not reach ollama');
    assert.equal(readQueue().length, 0);
  });
});
