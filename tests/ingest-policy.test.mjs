import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePolicy, readPolicy, clearPolicy, isActive } from '../scripts/ingest-policy.mjs';

test('write+read round-trip', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'policy-test-'));
  const sessionId = 'test-session-12345';
  try {
    writePolicy(dataDir, sessionId, {
      vault_root: '/tmp/vault',
      ingested_repo_slug: 'foo-abcdef',
      allowed_bash_prefixes: ['ygrep ', 'git log'],
      allowed_write_dir_prefix: '_ingested-repos/foo-abcdef/',
      expires_at_seconds: 600,
    });
    const p = readPolicy(dataDir, sessionId);
    assert.equal(p.session_id, sessionId);
    assert.equal(p.fanout_active, true);
    assert.equal(p.ingested_repo_slug, 'foo-abcdef');
    assert.deepEqual(p.allowed_bash_prefixes, ['ygrep ', 'git log']);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('clear removes the file', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'policy-clear-'));
  const sessionId = 'session-clear';
  try {
    writePolicy(dataDir, sessionId, {
      vault_root: '/tmp/vault',
      ingested_repo_slug: 'foo',
      allowed_bash_prefixes: [],
      allowed_write_dir_prefix: '_ingested-repos/foo/',
      expires_at_seconds: 60,
    });
    clearPolicy(dataDir, sessionId);
    assert.equal(readPolicy(dataDir, sessionId), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('expired policy returns isActive=false', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'policy-expired-'));
  const sessionId = 'session-expired';
  try {
    writePolicy(dataDir, sessionId, {
      vault_root: '/tmp/vault',
      ingested_repo_slug: 'foo',
      allowed_bash_prefixes: [],
      allowed_write_dir_prefix: '_ingested-repos/foo/',
      expires_at_seconds: -10,
    });
    const p = readPolicy(dataDir, sessionId);
    assert.equal(isActive(p), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('readPolicy returns null when file absent', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'policy-absent-'));
  try {
    assert.equal(readPolicy(dataDir, 'no-session'), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('isActive returns false on null', () => {
  assert.equal(isActive(null), false);
});
