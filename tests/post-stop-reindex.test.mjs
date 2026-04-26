import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'post-stop-reindex.js');
const runId = randomBytes(8).toString('hex');
const VAULT = join(tmpdir(), `ll-test-vault-reindex-${runId}`);
const PLUGIN_DATA = join(tmpdir(), `ll-test-plugin-data-reindex-${runId}`);

function run(input) {
  return execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      VAULT_PATH: VAULT,
      CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
      LL_REINDEX_DEBUG: '1',
    },
    timeout: 5000,
  });
}

describe('post-stop-reindex', () => {
  before(() => {
    mkdirSync(VAULT, { recursive: true });
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('exits 0 on empty stdin', () => {
    assert.doesNotThrow(() => run(''));
  });

  it('exits 0 on stop_hook_active payload without spawning', () => {
    assert.doesNotThrow(() =>
      run(JSON.stringify({ stop_hook_active: true, session_id: 'x' })),
    );
  });

  it('exits 0 cleanly when no vault index DB exists (no spawn possible)', () => {
    // Vault dir exists but .vault-search/vault-index.db does not, so the hook
    // should hit the "exit: no db" branch and return 0 without spawning.
    assert.doesNotThrow(() =>
      run(JSON.stringify({ session_id: 'abc', stop_hook_active: false })),
    );
  });

  it('exits 0 on malformed JSON input (defensive)', () => {
    assert.doesNotThrow(() => run('{not valid json'));
  });
});
