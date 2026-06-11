import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, chmodSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSessionId } from '../scripts/lib/session.mjs';

// getSessionId() resolves plugin-data/session/id[-<ppid>] BEFORE the tmp files.
// Point CLAUDE_PLUGIN_DATA at an empty temp dir for the tmp-fallback tests so
// plugin-data resolves cleanly but has no session id → the resolver falls
// through to the tmp candidates these tests exercise. (A dedicated block below
// covers the plugin-data-precedence path.)
let pdRoot;
let savedPluginData;
let savedHarnessSid;
let sessionTmpDir;
let savedSessionTmpDir;

before(() => {
  savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  savedHarnessSid = process.env.CLAUDE_CODE_SESSION_ID;
  savedSessionTmpDir = process.env.LL_SESSION_TMP_DIR;
  pdRoot = mkdtempSync(join(tmpdir(), 'll-session-test-pd-'));
  sessionTmpDir = mkdtempSync(join(tmpdir(), 'll-session-tmp-'));
  process.env.CLAUDE_PLUGIN_DATA = pdRoot;
  process.env.LL_SESSION_TMP_DIR = sessionTmpDir;
  // The harness session id is the canonical key; clear it for the file-based
  // tests below so they exercise the on-disk fallbacks, and set it explicitly
  // in the tests that assert the env-first behavior.
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

after(() => {
  rmSync(pdRoot, { recursive: true, force: true });
  rmSync(sessionTmpDir, { recursive: true, force: true });
  if (savedPluginData !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  else delete process.env.CLAUDE_PLUGIN_DATA;
  if (savedHarnessSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedHarnessSid;
  else delete process.env.CLAUDE_CODE_SESSION_ID;
  if (savedSessionTmpDir !== undefined) process.env.LL_SESSION_TMP_DIR = savedSessionTmpDir;
  else delete process.env.LL_SESSION_TMP_DIR;
});

test('getSessionId reads the tmp candidate from LL_SESSION_TMP_DIR when set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-session-inject-'));
  process.env.LL_SESSION_TMP_DIR = dir;
  writeFileSync(join(dir, 'learning-loop-session-id'), 'injected-dir-id');
  try {
    assert.equal(getSessionId(), 'injected-dir-id');
  } finally {
    process.env.LL_SESSION_TMP_DIR = sessionTmpDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getSessionId reads the unsuffixed tmp file', () => {
  const path = join(sessionTmpDir, 'learning-loop-session-id');
  writeFileSync(path, 'session-from-tmp');
  try {
    assert.equal(getSessionId(), 'session-from-tmp');
  } finally {
    rmSync(path, { force: true });
  }
});

test('getSessionId returns "unknown" when no file is present', () => {
  rmSync(join(sessionTmpDir, 'learning-loop-session-id'), { force: true });
  assert.equal(getSessionId(), 'unknown');
});

test('getSessionId trims trailing whitespace from file contents', () => {
  const path = join(sessionTmpDir, 'learning-loop-session-id');
  writeFileSync(path, 'session-with-newline\n');
  try {
    assert.equal(getSessionId(), 'session-with-newline');
  } finally {
    rmSync(path, { force: true });
  }
});

test('getSessionId returns "unknown" when the tmp file is whitespace-only', () => {
  const path = join(sessionTmpDir, 'learning-loop-session-id');
  writeFileSync(path, '   \n');
  try {
    assert.equal(getSessionId(), 'unknown');
  } finally {
    rmSync(path, { force: true });
  }
});

test(
  'getSessionId surfaces an unreadable plugin-data id via logError, then falls through to tmp',
  { skip: process.platform === 'win32' },
  () => {
    if (process.getuid && process.getuid() === 0) return;
    const sessionDir = join(pdRoot, 'session');
    mkdirSync(sessionDir, { recursive: true });
    const pdId = join(sessionDir, 'id');
    const fallback = join(sessionTmpDir, 'learning-loop-session-id');
    writeFileSync(pdId, 'unreadable');
    chmodSync(pdId, 0o000);
    writeFileSync(fallback, 'recovered');
    try {
      assert.equal(getSessionId(), 'recovered');
    } finally {
      try {
        chmodSync(pdId, 0o600);
      } catch {}
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(fallback, { force: true });
    }
  },
);

// plugin-data precedence — the env-independent anchor that fixes the /reflect
// handshake. plugin-data/session/id[-<ppid>] must win over the tmp files,
// because os.tmpdir() honors $TMPDIR (a hook subprocess and the interactive
// shell disagree) while plugin-data does not.
test('getSessionId prefers plugin-data/session/id over the tmp file', () => {
  const tmpFile = join(sessionTmpDir, 'learning-loop-session-id');
  writeFileSync(tmpFile, 'tmp-loses');
  const sessionDir = join(pdRoot, 'session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'id'), 'plugin-data-wins');
  try {
    assert.equal(getSessionId(), 'plugin-data-wins');
  } finally {
    rmSync(tmpFile, { force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('getSessionId falls through to tmp when plugin-data has no session id', () => {
  const tmpFile = join(sessionTmpDir, 'learning-loop-session-id');
  writeFileSync(tmpFile, 'tmp-fallback');
  try {
    assert.equal(getSessionId(), 'tmp-fallback');
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

// --- Harness session id is the canonical key ---------------------------------
// CLAUDE_CODE_SESSION_ID is the only id that is identical across every process
// in a session (SessionStart hook, post-tool hook, the skill's bash-spawned
// node, and sub-agents) AND independent of $TMPDIR and process.ppid. It must win
// so the /reflect Step-4 marker handshake meets across the hook/shell boundary.
test('getSessionId returns CLAUDE_CODE_SESSION_ID when set', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'harness-uuid';
  try {
    assert.equal(getSessionId(), 'harness-uuid');
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  }
});

// The original bug: a stale plugin-data/session/id-<ppid> from a dead session
// shadowed the real id because ppid is not a session key and is reused. The
// harness id must override any on-disk file so a stale ppid file can never
// re-split the handshake.
test('getSessionId prefers CLAUDE_CODE_SESSION_ID over a stale on-disk session id', () => {
  const sessionDir = join(pdRoot, 'session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `id-${process.ppid}`), 'stale-ppid-id');
  writeFileSync(join(sessionDir, 'id'), 'stale-unsuffixed-id');
  process.env.CLAUDE_CODE_SESSION_ID = 'live-harness-uuid';
  try {
    assert.equal(getSessionId(), 'live-harness-uuid');
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// An empty/whitespace env value is treated as absent (a defensive guard for a
// harness that exports the var but leaves it blank), falling through to disk.
test('getSessionId ignores a blank CLAUDE_CODE_SESSION_ID and falls through', () => {
  const sessionDir = join(pdRoot, 'session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'id'), 'disk-id');
  process.env.CLAUDE_CODE_SESSION_ID = '   ';
  try {
    assert.equal(getSessionId(), 'disk-id');
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
