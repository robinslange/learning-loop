// tests/pre-write-check-duplicate-gate.test.mjs
// Covers checkDuplicateNote in hooks/pre-write-check.js via a stub ll-search
// emitting a canned reflect-scan envelope. Contract: above-threshold non-self
// match warns; self-match is exempt; below-threshold is silent; a crashing
// binary fails OPEN (write allowed) with a logged error.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';
import { VAULT_DIRS, TITLE_INDEX_EXTRA_DIRS } from '../hooks/lib/snapshot.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';

const HOOK = new URL('../hooks/pre-write-check.js', import.meta.url).pathname;
let VAULT;

// Note content with a # title (triggers the gate) and no wikilinks (no
// broken-link noise in additionalContext).
const NOTE = '---\ntags: [sleep]\n---\n\n# Sleep consolidates memory\n\nClean body.\n';

function runWithStub(stubScript, filePath, { allowStderrError = false, tool = 'Write', toolInput = null } = {}) {
  const r = runHook(HOOK, {
    stdin: {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput ?? { file_path: filePath, content: NOTE },
    },
    env: { VAULT_PATH: VAULT },
    seed: (pluginDataDir) => {
      const binDir = join(pluginDataDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'll-search'), stubScript);
      chmodSync(join(binDir, 'll-search'), 0o755);
    },
  });
  try {
    assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
    assert.equal(r.exitCode, 0, r.stderr);
    if (!allowStderrError) {
      assert.ok(!r.stderr.includes('"level":"error"'), `hook logged an error: ${r.stderr}`);
    }
    const out = r.stdout.trim();
    return { result: out ? JSON.parse(out) : null, stderr: r.stderr };
  } finally {
    r.cleanup();
  }
}

function envelopeStub(similarity, path, title) {
  const payload = JSON.stringify({
    queries: [
      {
        query: 'Sleep consolidates memory',
        top_match_similarity: similarity,
        results: [{ path, title }],
      },
    ],
  });
  return `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`;
}

describe('pre-write-check duplicate-note gate', () => {
  before(() => {
    VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-dupe-vault-'));
    // Create canonical dirs so rebuildVaultSnapshot doesn't log missing-dir errors.
    for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS]) {
      mkdirSync(join(VAULT, dir), { recursive: true });
    }
    mkdirSync(join(VAULT, '.vault-search'), { recursive: true });
    // The gate only checks existsSync on the db; the stub never reads it.
    writeFileSync(join(VAULT, '.vault-search', 'vault-index.db'), '');
    writeFileSync(join(VAULT, '3-permanent', 'sleep-existing.md'), '# Existing sleep note\n');
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
  });

  it('fixture similarities straddle the live threshold (the suite loses meaning otherwise)', () => {
    assert.ok(
      0.92 > HookConfig.SIMILARITY_THRESHOLD &&
        0.99 > HookConfig.SIMILARITY_THRESHOLD &&
        0.5 < HookConfig.SIMILARITY_THRESHOLD,
      'fixture similarities must straddle the threshold',
    );
  });

  it('warns with similarity percentage on an above-threshold non-self match', () => {
    const { result } = runWithStub(
      envelopeStub(0.92, '3-permanent/sleep-existing.md', 'Existing sleep note'),
      join(VAULT, '0-inbox', 'new-note.md'),
    );
    assert.ok(result, 'expected a warning payload');
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined, 'duplicate gate must warn, never deny');
    assert.match(result.hookSpecificOutput.additionalContext, /Potential duplicate/);
    assert.match(result.hookSpecificOutput.additionalContext, /92% similar/);
    assert.match(result.hookSpecificOutput.additionalContext, /sleep-existing\.md/);
  });

  it('self-match exemption: top result pointing at the file being written stays silent', () => {
    const { result } = runWithStub(
      envelopeStub(0.99, '0-inbox/new-note.md', 'Sleep consolidates memory'),
      join(VAULT, '0-inbox', 'new-note.md'),
    );
    assert.equal(result, null);
  });

  it('self-match exemption survives a non-normalized file_path (resolve() does real work)', () => {
    // Raw string, NOT path.join — join() would normalize the .. away before
    // the hook ever sees it.
    const { result } = runWithStub(
      envelopeStub(0.99, '0-inbox/new-note.md', 'Sleep consolidates memory'),
      `${VAULT}/0-inbox/../0-inbox/new-note.md`,
    );
    assert.equal(result, null);
  });

  it('below-threshold similarity stays silent', () => {
    const { result } = runWithStub(
      envelopeStub(0.5, '3-permanent/sleep-existing.md', 'Existing sleep note'),
      join(VAULT, '0-inbox', 'new-note.md'),
    );
    assert.equal(result, null);
  });

  it('Edit payloads skip the duplicate-note gate even when the title would collide', () => {
    const target = join(VAULT, '0-inbox', 'new-note.md');
    const { result } = runWithStub(
      envelopeStub(0.92, '3-permanent/sleep-existing.md', 'Existing sleep note'),
      target,
      {
        tool: 'Edit',
        toolInput: { file_path: target, old_string: 'Clean body.', new_string: NOTE },
      },
    );
    assert.equal(result, null, 'duplicate gate must not run for Edit payloads');
  });

  it('crashing binary fails OPEN: no output, error logged at the gate scope', () => {
    const { result, stderr } = runWithStub(
      '#!/bin/sh\necho "onnx blew up" 1>&2\nexit 1\n',
      join(VAULT, '0-inbox', 'new-note.md'),
      { allowStderrError: true },
    );
    assert.equal(result, null, 'gate failure must not block or warn');
    assert.match(stderr, /pre-write-check\.checkDuplicateNote/, `expected the gate's logError scope in stderr; got: ${stderr}`);
  });
});
