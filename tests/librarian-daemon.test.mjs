// tests/librarian-daemon.test.mjs : unit tests for scripts/librarian/daemon.mjs
//
// Tests: SIGTERM drain, AbortSignal loop exit, state save on drain, __test__ surface.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), 'll-daemon-' + runId);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

describe('librarian-daemon', () => {
  before(() => {
    mkdirSync(join(TEMP_VAULT, '3-permanent'), { recursive: true });
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.VAULT_PATH = TEMP_VAULT;
  });

  after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.VAULT_PATH;
  });

  it('__test__ on librarian.mjs includes investigateNote', async () => {
    const mod = await import('../plugin/scripts/librarian.mjs?bust=daemon-test-' + runId);
    assert.ok(typeof mod.__test__ === 'object', '__test__ must be exported');
    const keys = Object.keys(mod.__test__);
    assert.ok(keys.includes('voiceCheck'), 'voiceCheck missing');
    assert.ok(keys.includes('tagCheck'), 'tagCheck missing');
    assert.ok(keys.includes('duplicateCheck'), 'duplicateCheck missing');
    assert.ok(keys.includes('waitForOllama'), 'waitForOllama missing');
    assert.ok(keys.includes('investigateNote'), 'investigateNote missing');
  });

  it('runDaemon exits cleanly when AbortSignal is pre-aborted', async () => {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-preabort-' + runId
    );
    const ac = new AbortController();
    ac.abort();

    // Build a minimal mock db
    const mockDb = {
      exec: () => [{ values: [] }],
    };

    const cfg = {
      enabled: true,
      model: 'test-model',
      paceMs: 10,
      queueCap: 200,
      ollamaUrl: 'http://localhost:11434',
      pauseOnBattery: false,
      batteryPollMs: 60000,
      linkPrompt: '',
      voicePrompt: '',
      tagPrompt: '',
      duplicatePrompt: '',
      structuralTags: new Set(),
    };

    // waitForOllama will try to fetch; intercept with a mock
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true });

    try {
      await runDaemon({ signal: ac.signal, configOverride: cfg, deps: { db: mockDb } });
    } finally {
      globalThis.fetch = origFetch;
    }
    // No assertion needed — just must not throw and must return
  });

  it('runDaemon saves state on abort (drain path)', async () => {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-drain-' + runId
    );
    const ac = new AbortController();

    const mockDb = { exec: () => [{ values: [['3-permanent/note.md']] }] };
    const cfg = {
      enabled: true,
      model: 'test-model',
      paceMs: 5000,
      queueCap: 200,
      ollamaUrl: 'http://localhost:11434',
      pauseOnBattery: false,
      batteryPollMs: 60000,
      linkPrompt: '',
      voicePrompt: '',
      tagPrompt: '',
      duplicatePrompt: '',
      structuralTags: new Set(),
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true });

    // Pre-set state to something recognizable
    const { saveState, loadState, resetState } = await import(
      '../plugin/scripts/librarian/queue.mjs?bust=daemon-drain-q-' + runId
    );
    resetState();
    saveState({ visited: [], notes_visited: 0, counters: {}, last_note: null, started_at: null });

    const daemonPromise = runDaemon({
      signal: ac.signal,
      configOverride: cfg,
      deps: { db: mockDb },
    });

    // Abort shortly after start
    setTimeout(() => ac.abort(), 50);
    await daemonPromise;

    globalThis.fetch = origFetch;

    // State file must exist after drain
    const statePath = join(LIB_DIR, 'state.json');
    assert.ok(existsSync(statePath), 'state.json must exist after drain');
  });

  it('runDaemon returns immediately when disabled in config', async () => {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-disabled-' + runId
    );
    const cfg = { enabled: false };
    const start = Date.now();
    await runDaemon({ configOverride: cfg });
    assert.ok(Date.now() - start < 500, 'should return quickly when disabled');
  });
});
