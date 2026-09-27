import { describe, it, before, after } from 'node:test';
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
const TEMP_ROOT = join(tmpdir(), `ll-voice-gate-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIBRARIAN_DIR = join(TEMP_DATA, 'librarian');

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
      staleness_suspects: 0,
      counters: {},
    }) + '\n',
  );
  if (existsSync(queuePath())) rmSync(queuePath());
}

describe('voice-gate structured-output classification', () => {
  const server = startOllamaMock();

  before(() => {
    mkdirSync(join(TEMP_VAULT, '0-inbox'), { recursive: true });
    mkdirSync(LIBRARIAN_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;

    writeFileSync(
      join(TEMP_VAULT, '0-inbox', 'some-topic-title.md'),
      '---\nstatus: inbox\n---\nSome content.\n',
    );
    writeFileSync(
      join(TEMP_VAULT, '0-inbox', 'cached-array-references-mutate-through-reverse.md'),
      '---\nstatus: inbox\n---\nClaim content.\n',
    );
  });

  after(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('queues voice_flag when model returns "topic"', async () => {
    resetState();
    server.use(chat(() => structured({ label: 'topic' })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=topic-${runId}`);
    await mod.__test__.voiceCheck('0-inbox/some-topic-title.md');

    const items = readQueue();
    assert.equal(items.length, 1, 'expected 1 queue item');
    assert.equal(items[0].task, 'voice_flag');
    assert.equal(items[0].target, '0-inbox/some-topic-title.md');
    assert.equal(items[0].current_title, 'some-topic-title');
    assert.match(items[0].reason, /structured-output classifier/);

    const state = JSON.parse(readFileSync(statePath(), 'utf-8'));
    assert.equal(state.voice_flags, 1);
  });

  it('does not queue when model returns "claim"', async () => {
    resetState();
    server.use(chat(() => structured({ label: 'claim' })));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=claim-${runId}`);
    await mod.__test__.voiceCheck('0-inbox/cached-array-references-mutate-through-reverse.md');

    const items = readQueue();
    assert.equal(items.length, 0, 'expected no queue items for claim');
  });

  it('does not crash on malformed response', async () => {
    resetState();
    server.use(chat(() => unstructured('not valid json at all')));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=malformed-${runId}`);
    await mod.__test__.voiceCheck('0-inbox/some-topic-title.md');

    const items = readQueue();
    assert.equal(items.length, 0, 'expected no queue items on malformed response');
  });

  it('skips gracefully on HTTP error from ollama', async () => {
    resetState();
    server.use(chat(() => httpError(500)));

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=http-error-${runId}`);
    await mod.__test__.voiceCheck('0-inbox/some-topic-title.md');

    const items = readQueue();
    assert.equal(items.length, 0, 'expected no queue items on HTTP error');
  });

  it('classifies on the model reply, not on whatever the first request returns', async () => {
    // The old stub answered every request identically, so a voiceCheck that
    // called the wrong endpoint -- or called it twice and read the first answer
    // -- still classified correctly. MSW matches on method and path, so a
    // request that is not exactly one POST to /api/chat cannot be served.
    resetState();
    const seen = [];
    server.use(
      chat(({ request }) => {
        seen.push(request.method + ' ' + new URL(request.url).pathname);
        return structured({ label: 'topic' });
      }),
    );

    const mod = await import(`../plugin/scripts/librarian.mjs?bust=one-call-${runId}`);
    await mod.__test__.voiceCheck('0-inbox/some-topic-title.md');

    assert.deepEqual(seen, ['POST /api/chat']);
    assert.equal(readQueue().length, 1);
  });

  it('logs timeout and skips submission when fetch aborts', async () => {
    // Not served through MSW: voiceCheck hardcodes a 15s client budget, and a
    // network mock cannot make a request time out sooner than the caller asked.
    // The injected rejection is the exact value undici produces when
    // AbortSignal.timeout fires, so the branch under test sees what production
    // sees.
    resetState();
    const timingOut = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    const mod = await import(
      `../plugin/scripts/librarian.mjs?bust=timeout-${runId}-${randomBytes(4).toString('hex')}`
    );
    await mod.__test__.voiceCheck('0-inbox/some-topic-title.md', { fetchOverride: timingOut });

    assert.equal(readQueue().length, 0, 'expected no queue items on timeout');
  });
});
