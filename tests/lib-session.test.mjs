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

before(() => {
  savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  pdRoot = mkdtempSync(join(tmpdir(), 'll-session-test-pd-'));
  process.env.CLAUDE_PLUGIN_DATA = pdRoot;
});

after(() => {
  rmSync(pdRoot, { recursive: true, force: true });
  if (savedPluginData !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  else delete process.env.CLAUDE_PLUGIN_DATA;
});

test('getSessionId returns ppid-suffixed when present', () => {
  const ppid = process.ppid;
  const path = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  writeFileSync(path, 'session-from-ppid');
  try {
    assert.equal(getSessionId(), 'session-from-ppid');
  } finally {
    rmSync(path, { force: true });
  }
});

test('getSessionId falls back to unsuffixed when ppid-suffixed absent', () => {
  const ppid = process.ppid;
  const suffixed = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  rmSync(suffixed, { force: true });
  const fallback = join(tmpdir(), 'learning-loop-session-id');
  writeFileSync(fallback, 'session-unsuffixed');
  try {
    assert.equal(getSessionId(), 'session-unsuffixed');
  } finally {
    rmSync(fallback, { force: true });
  }
});

test('getSessionId returns "unknown" when both files absent', () => {
  const ppid = process.ppid;
  rmSync(join(tmpdir(), `learning-loop-session-id-${ppid}`), { force: true });
  rmSync(join(tmpdir(), 'learning-loop-session-id'), { force: true });
  assert.equal(getSessionId(), 'unknown');
});

test('getSessionId trims trailing whitespace from file contents', () => {
  const ppid = process.ppid;
  const path = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  writeFileSync(path, 'session-with-newline\n');
  try {
    assert.equal(getSessionId(), 'session-with-newline');
  } finally {
    rmSync(path, { force: true });
  }
});

test('getSessionId skips empty ppid file and falls through to legacy', () => {
  const ppid = process.ppid;
  const suffixed = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  const fallback = join(tmpdir(), 'learning-loop-session-id');
  writeFileSync(suffixed, '');
  writeFileSync(fallback, 'session-from-legacy');
  try {
    assert.equal(getSessionId(), 'session-from-legacy');
  } finally {
    rmSync(suffixed, { force: true });
    rmSync(fallback, { force: true });
  }
});

test('getSessionId returns "unknown" when both candidates are whitespace-only', () => {
  const ppid = process.ppid;
  const suffixed = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  const fallback = join(tmpdir(), 'learning-loop-session-id');
  writeFileSync(suffixed, '   \n');
  writeFileSync(fallback, '\t\t');
  try {
    assert.equal(getSessionId(), 'unknown');
  } finally {
    rmSync(suffixed, { force: true });
    rmSync(fallback, { force: true });
  }
});

test(
  'getSessionId surfaces unreadable file via logError, then falls through',
  { skip: process.platform === 'win32' },
  () => {
    if (process.getuid && process.getuid() === 0) return;
    const ppid = process.ppid;
    const suffixed = join(tmpdir(), `learning-loop-session-id-${ppid}`);
    const fallback = join(tmpdir(), 'learning-loop-session-id');
    writeFileSync(suffixed, 'unreadable');
    chmodSync(suffixed, 0o000);
    writeFileSync(fallback, 'recovered');
    try {
      assert.equal(getSessionId(), 'recovered');
    } finally {
      try {
        chmodSync(suffixed, 0o600);
      } catch {}
      rmSync(suffixed, { force: true });
      rmSync(fallback, { force: true });
    }
  },
);

// plugin-data precedence — the env-independent anchor that fixes the /reflect
// handshake. plugin-data/session/id[-<ppid>] must win over the tmp files,
// because os.tmpdir() honors $TMPDIR (a hook subprocess and the interactive
// shell disagree) while plugin-data does not.
test('getSessionId prefers plugin-data/session/id-<ppid> over the tmp files', () => {
  const ppid = process.ppid;
  const tmpPpid = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  writeFileSync(tmpPpid, 'tmp-loses');
  const sessionDir = join(pdRoot, 'session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `id-${ppid}`), 'plugin-data-wins');
  try {
    assert.equal(getSessionId(), 'plugin-data-wins');
  } finally {
    rmSync(tmpPpid, { force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('getSessionId uses plugin-data/session/id (unsuffixed) when the ppid file is absent', () => {
  // The cross-process bridge: a reader's ppid differs from the SessionStart
  // writer's, so the unsuffixed file is what actually meets across processes.
  const sessionDir = join(pdRoot, 'session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'id'), 'bridge-id');
  try {
    assert.equal(getSessionId(), 'bridge-id');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('getSessionId falls through to tmp when plugin-data has no session id', () => {
  const ppid = process.ppid;
  const tmpPpid = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  writeFileSync(tmpPpid, 'tmp-fallback');
  try {
    assert.equal(getSessionId(), 'tmp-fallback');
  } finally {
    rmSync(tmpPpid, { force: true });
  }
});
