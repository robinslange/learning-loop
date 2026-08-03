// tests/hook-fail-mode.test.mjs
// Unit tests for preWriteFailMode() config reader, plus integration tests that
// verify closed-mode wires deny() on an internal scan failure and open-mode
// does not.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { preWriteFailMode } from '../plugin/scripts/lib/hook-config.mjs';
import { runHook } from './helpers/hook-runner.mjs';
import { skipOnWindows } from './helpers/platform.mjs';
import { VAULT_DIRS, TITLE_INDEX_EXTRA_DIRS } from '../plugin/hooks/lib/snapshot.mjs';

// --- Unit tests: preWriteFailMode() ---

describe('preWriteFailMode()', () => {
  it('defaults to open when hooks key is absent', () => {
    assert.equal(preWriteFailMode({}), 'open');
  });

  it('defaults to open when hooks.pre_write_fail_mode is absent', () => {
    assert.equal(preWriteFailMode({ hooks: {} }), 'open');
  });

  it('defaults to open when config is null', () => {
    assert.equal(preWriteFailMode(null), 'open');
  });

  it('defaults to open when config is undefined', () => {
    assert.equal(preWriteFailMode(undefined), 'open');
  });

  it('honours closed when explicitly configured', () => {
    assert.equal(preWriteFailMode({ hooks: { pre_write_fail_mode: 'closed' } }), 'closed');
  });

  it('falls back to open on an invalid value', () => {
    assert.equal(preWriteFailMode({ hooks: { pre_write_fail_mode: 'nonsense' } }), 'open');
  });

  it('falls back to open on an empty string', () => {
    assert.equal(preWriteFailMode({ hooks: { pre_write_fail_mode: '' } }), 'open');
  });

  it('falls back to open on a boolean true (wrong type)', () => {
    assert.equal(preWriteFailMode({ hooks: { pre_write_fail_mode: true } }), 'open');
  });
});

// --- Integration tests: fail-mode wiring in pre-write-check.js ---

const HOOK = fileURLToPath(new URL('../plugin/hooks/pre-write-check.js', import.meta.url));
const SKIP = skipOnWindows('UDS socket / subprocess: skipped on win32');

// A Write payload with a title (triggers the duplicate gate) and no
// wikilinks (no broken-link noise in the output).
const NOTE =
  '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\n\n# Test note title\n\nBody text.\n';

// Binary that always crashes with a non-zero exit, simulating a scan failure.
const CRASHING_STUB = '#!/bin/sh\necho "scan failed" 1>&2\nexit 1\n';

let VAULT;

describe('pre-write-check fail-mode wiring', { skip: SKIP }, () => {
  before(() => {
    VAULT = mkdtempSync(join(tmpdir(), 'll-fail-mode-vault-'));
    for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS]) {
      mkdirSync(join(VAULT, dir), { recursive: true });
    }
    mkdirSync(join(VAULT, '.vault-search'), { recursive: true });
    // Gate only existsSync-checks this file; the stub binary never reads it.
    writeFileSync(join(VAULT, '.vault-search', 'vault-index.db'), '');
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
  });

  function runWithFailMode(failMode, filePath) {
    const r = runHook(HOOK, {
      timeoutMs: 30000,
      stdin: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: NOTE },
      },
      env: { VAULT_PATH: VAULT, LL_PRE_WRITE_BUDGET_MS: '30000' },
      seed: (pluginDataDir) => {
        // Write a per-test config.json so getConfig() picks it up.
        writeFileSync(
          join(pluginDataDir, 'config.json'),
          JSON.stringify({ vault_path: VAULT, hooks: { pre_write_fail_mode: failMode } }),
        );
        const binDir = join(pluginDataDir, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, 'll-search'), CRASHING_STUB);
        chmodSync(join(binDir, 'll-search'), 0o755);
      },
    });
    return r;
  }

  it('open mode: internal scan failure allows the write (no deny, no output)', () => {
    const filePath = join(VAULT, '0-inbox', 'open-mode-test.md');
    const r = runWithFailMode('open', filePath);
    try {
      assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
      assert.equal(r.exitCode, 0, `hook must exit 0 in open mode; stderr: ${r.stderr}`);
      const out = r.stdout.trim();
      const result = out ? JSON.parse(out) : null;
      // In open mode a scan failure produces no output at all (the write goes through).
      if (result) {
        assert.notEqual(
          result.hookSpecificOutput?.permissionDecision,
          'deny',
          'open mode must not deny the write on scan failure',
        );
      }
    } finally {
      r.cleanup();
    }
  });

  it('closed mode: internal scan failure produces a deny decision', () => {
    const filePath = join(VAULT, '0-inbox', 'closed-mode-test.md');
    const r = runWithFailMode('closed', filePath);
    try {
      assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
      // A deny via emitJson still exits 0 (it's structured output, not an error exit).
      assert.equal(r.exitCode, 0, `hook must exit 0 even when denying; stderr: ${r.stderr}`);
      const out = r.stdout.trim();
      assert.ok(out, `closed mode must emit a deny payload on scan failure; stderr: ${r.stderr}`);
      const result = JSON.parse(out);
      assert.equal(
        result.hookSpecificOutput?.permissionDecision,
        'deny',
        'closed mode must emit permissionDecision=deny on scan failure',
      );
      assert.match(
        result.hookSpecificOutput?.permissionDecisionReason,
        /pre_write_fail_mode.*closed|closed.*pre_write_fail_mode|fail.?mode.*closed|closed.*fail.?mode/i,
        'deny reason must mention fail-mode setting',
      );
    } finally {
      r.cleanup();
    }
  });
});
