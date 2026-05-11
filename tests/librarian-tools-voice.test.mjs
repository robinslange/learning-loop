// tests/librarian-tools-voice.test.mjs : unit tests for scripts/librarian/tools/voice.mjs

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

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
  let voiceCheck, submitVoiceFlag;
  let origFetch;

  before(async () => {
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    const mod = await import('../scripts/librarian/tools/voice.mjs?bust=voice-' + runId);
    voiceCheck = mod.voiceCheck;
    submitVoiceFlag = mod.submitVoiceFlag;
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
      JSON.stringify({ visited: [], notes_visited: 0, voice_flags: 0, counters: {} }) + '\n',
    );
    globalThis.fetch = origFetch;
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
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: JSON.stringify({ label: 'topic' }) } }),
    }));
    await voiceCheck('0-inbox/some-topic.md', { fetchOverride: globalThis.fetch });
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, 'voice_flag');
  });

  it('voiceCheck does not queue when model returns "claim"', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: JSON.stringify({ label: 'claim' }) } }),
    }));
    await voiceCheck('0-inbox/some-claim.md', { fetchOverride: globalThis.fetch });
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck skips gracefully on HTTP error', async () => {
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 500 }));
    await voiceCheck('0-inbox/foo.md', { fetchOverride: globalThis.fetch });
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck does not crash on malformed JSON response', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: 'not valid json' } }),
    }));
    await voiceCheck('0-inbox/foo.md', { fetchOverride: globalThis.fetch });
    assert.equal(readQueue().length, 0);
  });

  it('voiceCheck logs and skips on timeout', async () => {
    const logs = [];
    const logFn = (msg) => logs.push(msg);
    globalThis.fetch = mock.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    await voiceCheck('0-inbox/foo.md', { fetchOverride: globalThis.fetch, logFn });
    assert.equal(readQueue().length, 0);
    assert.ok(
      logs.some((l) => l.includes('timeout')),
      'should log timeout',
    );
  });
});
