// tests/librarian-tools-voice.test.mjs : unit tests for scripts/librarian/tools/voice.mjs

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
const TEMP_ROOT = join(tmpdir(), 'll-tools-voice-' + runId);
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

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

describe('librarian-tools-voice', () => {
  const server = startOllamaMock();
  let voiceCheck, submitVoiceFlag;

  before(async () => {
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    const mod = await import('../plugin/scripts/librarian/tools/voice.mjs?bust=voice-' + runId);
    voiceCheck = mod.voiceCheck;
    submitVoiceFlag = mod.submitVoiceFlag;
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
      JSON.stringify({ visited: [], notes_visited: 0, voice_flags: 0, counters: {} }) + '\n',
    );
  });

  it('submitVoiceFlag enqueues a voice_flag item', async () => {
    await submitVoiceFlag({
      target: '0-inbox/some-topic.md',
      current_title: 'some-topic',
      reason: 'test',
    });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'voice_flag');
    assert.equal(items[0].target, '0-inbox/some-topic.md');
  });

  it('voiceCheck queues voice_flag when model returns "topic"', async () => {
    server.use(chat(() => structured({ label: 'topic' })));
    await voiceCheck('0-inbox/some-topic.md');
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'voice_flag');
  });

  it('voiceCheck does not queue when model returns "claim"', async () => {
    server.use(chat(() => structured({ label: 'claim' })));
    await voiceCheck('0-inbox/some-claim.md');
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck skips gracefully on HTTP error', async () => {
    server.use(chat(() => httpError(500)));
    await voiceCheck('0-inbox/foo.md');
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck does not crash on malformed JSON response', async () => {
    server.use(chat(() => unstructured('not valid json')));
    await voiceCheck('0-inbox/foo.md');
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck skips when ollama cannot be reached at all', async () => {
    // A refused connection and a 500 reach the same catch, but only a real
    // Response distinguishes them -- the hand-rolled `{ ok: false }` object
    // could express one and not the other.
    server.use(chat(() => Response.error()));
    await voiceCheck('0-inbox/foo.md');
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck logs and skips on timeout', async () => {
    // Not served through MSW: voiceCheck fixes its own 15s client budget and a
    // network mock cannot expire it sooner. The injected rejection is what
    // undici throws when AbortSignal.timeout fires.
    const logs = [];
    const timingOut = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await voiceCheck('0-inbox/foo.md', {
      fetchOverride: timingOut,
      logFn: (msg) => logs.push(msg),
    });
    assert.equal(readQueue().length, 0);
    assert.ok(
      logs.some((l) => l.includes('timeout')),
      'should log timeout',
    );
  });
});
