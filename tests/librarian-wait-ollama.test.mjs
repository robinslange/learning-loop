import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-wait-ollama-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');

describe('waitForOllama bounded retry', () => {
  let originalFetch;

  before(() => {
    mkdirSync(TEMP_VAULT, { recursive: true });
    mkdirSync(join(TEMP_DATA, 'librarian'), { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.LL_VAULT_OVERRIDE = TEMP_VAULT;
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('throws after maxAttempts when ollama never responds', async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const { __test__ } = await import(
      `../scripts/librarian.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    await assert.rejects(
      () => __test__.waitForOllama({ maxAttempts: 3, intervalMs: 1 }),
      /ollama unreachable/i,
    );
    assert.equal(globalThis.fetch.mock.callCount(), 3);
  });

  it('returns when ollama becomes reachable mid-loop', async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error('ECONNREFUSED');
      return { ok: true };
    });

    const { __test__ } = await import(
      `../scripts/librarian.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    await __test__.waitForOllama({ maxAttempts: 5, intervalMs: 1 });
    assert.equal(calls, 2);
  });
});
