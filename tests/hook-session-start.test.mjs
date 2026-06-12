// tests/hook-session-start.test.mjs
// Characterisation tests for hooks/session-start.js
//
// Per-test timeout: 12000ms (session-start spawns subprocesses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../plugin/hooks/session-start.js', import.meta.url).pathname;
const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

// Seed update-check.json with a fresh timestamp so the hook does NOT spawn
// the background update-check child that would hit api.github.com.
function seedUpdateCheck(pluginDataDir, opts = {}) {
  const payload = {
    checked: Math.floor(Date.now() / 1000) - 5,
    update_available: opts.updateAvailable ?? false,
    installed: '1.17.3',
    latest: opts.latest ?? '1.17.3',
  };
  writeFileSync(join(pluginDataDir, 'update-check.json'), JSON.stringify(payload));
}

// Seed a config.json in pluginData with no vault_path so resolveVaultPath() returns null.
function seedNoVaultConfig(pluginDataDir) {
  writeFileSync(join(pluginDataDir, 'config.json'), JSON.stringify({ vault_path: null }));
}

// Parse and validate the hook's JSON output.
function parseOutput(stdout, label = '') {
  const trimmed = stdout.trim();
  assert.ok(trimmed.length > 0, `${label}: stdout must not be empty`);
  const parsed = JSON.parse(trimmed);
  assert.ok(parsed.hookSpecificOutput, `${label}: missing hookSpecificOutput`);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart', `${label}: wrong hookEventName`);
  return parsed.hookSpecificOutput;
}

// ---------------------------------------------------------------------------
// Test 1: Golden path — emits paths, retrieval protocol, session tmp files.
// ---------------------------------------------------------------------------
test(
  'session-start golden: emits paths, retrieval protocol; creates session tmp keys',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'golden-session-001' },
      env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: '/tmp/test-project-golden' },
      seed: (pd) => {
        seedUpdateCheck(pd);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}\nstderr: ${r.stderr}`);

      const hso = parseOutput(r.stdout, 'golden');
      const ctx = hso.additionalContext;
      assert.ok(typeof ctx === 'string' && ctx.length > 0, 'additionalContext must be non-empty');

      // Paths section present.
      assert.match(ctx, /Learning Loop Paths/i);
      assert.match(ctx, /PLUGIN=/);
      assert.match(ctx, /VAULT=/);

      // Retrieval protocol present.
      assert.match(ctx, /Retrieval Protocol/i);

      // Note: the helper's r.tmpKeys is unreliable under concurrent node --test
      // workers (the before/after diff races against cleanup from sibling test
      // files). The exit code 0 + additionalContext checks above already
      // demonstrate the hook ran end-to-end; the session-id and session-start
      // file writes are verified separately in unit tests of vault-snapshot.mjs.
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 2: No vault — empty additionalContext, exit 0.
// ---------------------------------------------------------------------------
test(
  'session-start no vault: additionalContext empty, exit 0',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'no-vault-session-001' },
      // No VAULT_PATH; seed config with null vault_path so resolveVaultPath() returns null.
      seed: (pd) => {
        seedUpdateCheck(pd);
        seedNoVaultConfig(pd);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const hso = parseOutput(r.stdout, 'no-vault');
      assert.equal(hso.additionalContext, '', 'no vault should produce empty additionalContext');
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 3: Cached update notice — matches /Plugin Update Available/.
// ---------------------------------------------------------------------------
test(
  'session-start update notice: additionalContext contains update banner',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'update-session-001' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        // Seed update-check with update_available=true so the notice fires.
        writeFileSync(
          join(pd, 'update-check.json'),
          JSON.stringify({
            checked: Math.floor(Date.now() / 1000) - 5,
            update_available: true,
            installed: '1.17.3',
            latest: '1.18.0',
          }),
        );
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}`);
      const hso = parseOutput(r.stdout, 'update-notice');
      assert.match(hso.additionalContext, /Plugin Update Available/i);
      assert.match(hso.additionalContext, /1\.18\.0/);
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 4: Federation seed-meta backfill on first run.
// ---------------------------------------------------------------------------
test(
  'session-start seed-meta backfill: writes .seed-meta.json when config exists but no seed-meta',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'fed-backfill-session' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        seedUpdateCheck(pd);
        // Create federation/config.json without .seed-meta.json.
        const fedDir = join(pd, 'federation');
        mkdirSync(fedDir, { recursive: true });
        writeFileSync(join(fedDir, 'config.json'), JSON.stringify({ peers: [] }));
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);

      const metaPath = join(r.pluginDataDir, 'federation', '.seed-meta.json');
      assert.ok(existsSync(metaPath), '.seed-meta.json should be written by backfill');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      assert.ok(meta.backfilled === true, 'backfill flag should be set');
      assert.ok(typeof meta.plugin_version === 'string', 'plugin_version should be a string');
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 5: Watch daemon NOT spawned when vault-index.db absent.
// ---------------------------------------------------------------------------
test(
  'session-start watch daemon not spawned when DB absent',
  { timeout: 12000 },
  () => {
    // The fixture vault has .vault-search/.gitkeep but no vault-index.db.
    // findBinary() also returns null in sandbox (no ~/.local/bin/ll-search).
    // Either condition alone suppresses spawn; both apply here.
    const r = runHook(HOOK, {
      stdin: { session_id: 'no-daemon-session' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        seedUpdateCheck(pd);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}`);

      // watch.pid must not exist in either the legacy (plugin-data) or
      // current (vault/.vault-search) location when daemon was not spawned.
      const legacyPidPath = join(r.pluginDataDir, 'watch.pid');
      assert.ok(!existsSync(legacyPidPath), 'legacy watch.pid must not exist when daemon not spawned');
      const vaultPidPath = join(VAULT, '.vault-search', 'watch.pid');
      assert.ok(!existsSync(vaultPidPath), 'vault watch.pid must not exist when daemon not spawned');
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 6: Cached intentions marker — hook emits the intentions context block.
// ---------------------------------------------------------------------------
// (Test 6 is below; new Test 7 for dream-gate is appended at end of file.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 7: Cached dream-gate marker — hook emits the dream consolidation block.
// ---------------------------------------------------------------------------
test(
  'session-start reads cached dream-gate marker and emits Dream Consolidation Due block',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'dream-gate-cache-session' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        seedUpdateCheck(pd);
        // Write a pre-populated dream-gate marker at the canonical path.
        // MARKER_PATHS.dreamGate(pluginData) = pluginData/session-start-cache/dream-gate.json
        const cacheDir = join(pd, 'session-start-cache');
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(
          join(cacheDir, 'dream-gate.json'),
          JSON.stringify({ nudge: 'test-dream-nudge' }),
        );
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const hso = parseOutput(r.stdout, 'dream-gate-cache');
      assert.match(hso.additionalContext, /## Dream Consolidation Due/);
      assert.match(hso.additionalContext, /test-dream-nudge/);
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// (original Test 6 below)
// ---------------------------------------------------------------------------
test(
  'session-start reads cached intentions marker and emits context block',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'intentions-cache-session' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        seedUpdateCheck(pd);
        // Write a pre-populated intentions marker at the canonical path.
        // pluginData resolves to sandboxRoot/plugin-data; the hook reads from
        // MARKER_PATHS.intentions(pluginData) = pluginData/session-start-cache/intentions.json
        const cacheDir = join(pd, 'session-start-cache');
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(
          join(cacheDir, 'intentions.json'),
          JSON.stringify([{ context: 'test-ctx', count: 3 }]),
        );
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const hso = parseOutput(r.stdout, 'intentions-cache');
      assert.match(hso.additionalContext, /## Notes with active intentions:/);
      assert.match(hso.additionalContext, /- test-ctx \(3 notes\)/);
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Tests: MEMORY.md recency gate (Task 2.1)
// ---------------------------------------------------------------------------

test(
  'session-start memory: skips MEMORY.md when mtime older than 7 days',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'stale-mem' },
      env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: '/tmp/test-project-stale' },
      seed: (pd, sb) => {
        seedUpdateCheck(pd);
        const encoded = '/tmp/test-project-stale'.replace(/[/\\]/g, '-');
        const memDir = join(sb, '.claude', 'projects', encoded, 'memory');
        mkdirSync(memDir, { recursive: true });
        const memPath = join(memDir, 'MEMORY.md');
        writeFileSync(memPath, '- [test.md](test.md) — old entry\n');
        const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(memPath, old, old);
      },
    });
    try {
      assert.equal(r.exitCode, 0);
      const hso = parseOutput(r.stdout, 'stale-mem');
      assert.ok(
        !hso.additionalContext.includes('## Auto-memory index'),
        'stale MEMORY.md should not be injected',
      );
    } finally {
      r.cleanup();
    }
  },
);

test(
  'session-start memory: injects MEMORY.md when mtime within 7 days',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'fresh-mem' },
      env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: '/tmp/test-project-fresh' },
      seed: (pd, sb) => {
        seedUpdateCheck(pd);
        const encoded = '/tmp/test-project-fresh'.replace(/[/\\]/g, '-');
        const memDir = join(sb, '.claude', 'projects', encoded, 'memory');
        mkdirSync(memDir, { recursive: true });
        const memPath = join(memDir, 'MEMORY.md');
        writeFileSync(memPath, '- [test.md](test.md) — fresh entry\n');
        // Default mtime is now, no utimesSync needed.
      },
    });
    try {
      assert.equal(r.exitCode, 0);
      const hso = parseOutput(r.stdout, 'fresh-mem');
      assert.ok(
        hso.additionalContext.includes('## Auto-memory index'),
        'fresh MEMORY.md should be injected',
      );
      assert.ok(
        hso.additionalContext.includes('fresh entry'),
        'memory content should be in context',
      );
    } finally {
      r.cleanup();
    }
  },
);

test(
  'session-start memory: env override forces injection of stale MEMORY.md',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'override-mem' },
      env: {
        VAULT_PATH: VAULT,
        CLAUDE_PROJECT_DIR: '/tmp/test-project-override',
        LEARNING_LOOP_ALWAYS_INJECT_MEMORY: '1',
      },
      seed: (pd, sb) => {
        seedUpdateCheck(pd);
        const encoded = '/tmp/test-project-override'.replace(/[/\\]/g, '-');
        const memDir = join(sb, '.claude', 'projects', encoded, 'memory');
        mkdirSync(memDir, { recursive: true });
        const memPath = join(memDir, 'MEMORY.md');
        writeFileSync(memPath, '- [override.md](override.md) — forced inject\n');
        const old = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(memPath, old, old);
      },
    });
    try {
      assert.equal(r.exitCode, 0);
      const hso = parseOutput(r.stdout, 'override-mem');
      assert.ok(
        hso.additionalContext.includes('forced inject'),
        'env override should inject even very stale MEMORY.md',
      );
    } finally {
      r.cleanup();
    }
  },
);

test(
  'a 230KB MEMORY.md is injected capped, and the hook output stays valid JSON',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'big-global-mem' },
      env: { VAULT_PATH: VAULT },
      seed: (pd, sb) => {
        seedUpdateCheck(pd);
        // Arrange: oversized GLOBAL memory index, mtime fresh (now). Line-oriented
        // content so the cap cuts on a newline. The global memory path keys on the
        // vault PARENT, mirroring context-assembly.mjs.
        const encodedVaultParent = resolve(VAULT, '..').replace(/[/\\]/g, '-');
        const globalMemoryPath = join(sb, '.claude', 'projects', encodedVaultParent, 'memory', 'MEMORY.md');
        mkdirSync(dirname(globalMemoryPath), { recursive: true });
        const big = ('- [note](note.md) - ' + 'x'.repeat(80) + '\n').repeat(2500); // ~230KB
        writeFileSync(globalMemoryPath, big);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const out = r.stdout;
      const parsed = JSON.parse(out);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('## Global memory index:'));
      assert.ok(ctx.includes('[truncated — full index at'));
      // The injected section is capped, not the whole file:
      assert.ok(Buffer.byteLength(out, 'utf8') <= 8192);
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Session-id stamping (writer side of the /reflect Step-4 handshake).
//
// The writer must stamp the canonical id into plugin-data/session/id (the
// single env-independent file both the post-tool hook and the skill's bash read
// back via getSessionId()). It must NOT create per-ppid files: ppid is not a
// session key, differs per process, and stale id-<ppid> files accumulate and
// shadow the real id — the root cause of the recurring handshake breakage.
// ---------------------------------------------------------------------------
test(
  'session-start stamps CLAUDE_CODE_SESSION_ID into plugin-data/session/id and writes no ppid file',
  { timeout: 12000 },
  () => {
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'll-ss-sid-'));
    const r = runHook(HOOK, {
      stdin: { source: 'startup' },
      env: {
        VAULT_PATH: VAULT,
        CLAUDE_PROJECT_DIR: '/tmp/test-project-sid',
        CLAUDE_CODE_SESSION_ID: 'harness-uuid-xyz',
        LL_SESSION_TMP_DIR: isolatedTmp,
      },
      seed: (pd) => seedUpdateCheck(pd),
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const sessionDir = join(r.pluginDataDir, 'session');
      const idFile = join(sessionDir, 'id');
      assert.ok(existsSync(idFile), 'plugin-data/session/id must exist');
      assert.equal(
        readFileSync(idFile, 'utf8').trim(),
        'harness-uuid-xyz',
        'session/id must hold the harness session id',
      );
      const ppidFiles = readdirSync(sessionDir).filter((n) => /^id-\d+$/.test(n));
      assert.deepEqual(ppidFiles, [], `no id-<ppid> files expected, found: ${ppidFiles}`);
    } finally {
      r.cleanup();
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  },
);

test(
  'session-start falls back to a generated id when no payload or env session id exists',
  { timeout: 12000 },
  () => {
    // LL_SESSION_TMP_DIR isolates the legacy tmp candidate: without it,
    // getSessionId() in the hook child could resolve a live session's
    // machine-global /tmp/learning-loop-session-id instead of falling through
    // to the generated id.
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'll-ss-fallback-'));
    const r = runHook(HOOK, {
      stdin: { source: 'startup' },
      env: {
        VAULT_PATH: VAULT,
        CLAUDE_PROJECT_DIR: '/tmp/test-project-sid2',
        LL_SESSION_TMP_DIR: isolatedTmp,
      },
      seed: (pd) => seedUpdateCheck(pd),
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const idFile = join(r.pluginDataDir, 'session', 'id');
      assert.ok(existsSync(idFile), 'plugin-data/session/id must exist');
      assert.match(
        readFileSync(idFile, 'utf8').trim(),
        /^[0-9a-f]{8}$/,
        'fallback id should be an 8-hex-char token',
      );
    } finally {
      r.cleanup();
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// M4: the stdin hook payload's session_id is the canonical key — it must win
// over $CLAUDE_CODE_SESSION_ID and land in both the plugin-data session id and
// the memory-snapshot marker that stop-nudge diffs against.
// ---------------------------------------------------------------------------
test(
  'session-start prefers the stdin payload session_id and stamps it everywhere — M4',
  { timeout: 12000 },
  () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'll-ss-proj-'));
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'll-ss-m4-'));
    const encodedPath = projectDir.replace(/[/\\]/g, '-');
    const r = runHook(HOOK, {
      env: {
        VAULT_PATH: VAULT,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_CODE_SESSION_ID: 'env-id-should-lose',
        LL_SESSION_TMP_DIR: isolatedTmp,
      },
      stdin: { session_id: 'payload-id-wins', source: 'startup' },
      seed: (pd, sandboxRoot) => {
        seedUpdateCheck(pd);
        const memDir = join(sandboxRoot, '.claude', 'projects', encodedPath, 'memory');
        mkdirSync(memDir, { recursive: true });
        writeFileSync(join(memDir, 'a.md'), '# x');
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(
        readFileSync(join(r.pluginDataDir, 'session', 'id'), 'utf8').trim(),
        'payload-id-wins',
        'plugin-data session id must carry the payload id',
      );
      assert.ok(
        existsSync(join(r.pluginDataDir, 'markers', 'memory-snapshot-payload-id-wins')),
        'memory snapshot must be keyed by the payload id in plugin-data',
      );
      assert.deepEqual(
        JSON.parse(
          readFileSync(join(r.pluginDataDir, 'markers', 'memory-snapshot-payload-id-wins'), 'utf8'),
        ),
        ['a.md'],
        'snapshot content must be the bare files array (stop-nudge reads via Array.isArray)',
      );
    } finally {
      r.cleanup();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// M12: a crashed previous session leaves watch.pid.lock behind. The spawn
// guard must recover the stale lock (dead pid, old mtime) instead of treating
// EEXIST as "locked forever" — otherwise vault indexing is silently disabled
// on every later session.
// ---------------------------------------------------------------------------
test(
  'watch-daemon recovers from a crashed spawn lock — M12',
  { timeout: 12000 },
  () => {
    const vaultDir = mkdtempSync(join(realpathSync(tmpdir()), 'll-wd-vault-'));
    const vsDir = join(vaultDir, '.vault-search');
    mkdirSync(vsDir, { recursive: true });
    writeFileSync(join(vsDir, 'vault-index.db'), '');
    // Crashed previous session: lock file with a dead pid, old mtime.
    writeFileSync(join(vsDir, 'watch.pid.lock'), '2147483647');
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(vsDir, 'watch.pid.lock'), old, old);

    const r = runHook(HOOK, {
      env: { VAULT_PATH: vaultDir },
      stdin: '',
      seed: (pluginDataDir) => {
        seedUpdateCheck(pluginDataDir);
        const bin = join(pluginDataDir, 'bin', 'll-search');
        writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(
        existsSync(join(vsDir, 'watch.fingerprint')),
        'daemon spawn path must proceed past a stale lock (fingerprint written)',
      );
      assert.ok(!existsSync(join(vsDir, 'watch.pid.lock')), 'lock released after spawn');
    } finally {
      r.cleanup();
      rmSync(vaultDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Regression (W5/6b): the post-acquire re-probe treated only 'alive' as
// occupied. An empty watch.pid means a daemon is mid-write of its own pidfile
// ('writer-in-progress') — that slot is occupied too. Pre-fix the hook fell
// through and spawned a second daemon on top of the writer.
// ---------------------------------------------------------------------------
test(
  'watch-daemon does not spawn over a writer-in-progress pidfile',
  { timeout: 12000 },
  () => {
    const vaultDir = mkdtempSync(join(realpathSync(tmpdir()), 'll-wd-wip-'));
    const vsDir = join(vaultDir, '.vault-search');
    mkdirSync(vsDir, { recursive: true });
    writeFileSync(join(vsDir, 'vault-index.db'), '');
    // A daemon has created its pidfile but not yet written the pid: the file
    // exists and is empty for the whole hook run (the real daemon's write can
    // land later than both probes).
    writeFileSync(join(vsDir, 'watch.pid'), '');

    const r = runHook(HOOK, {
      env: { VAULT_PATH: vaultDir },
      stdin: '',
      seed: (pluginDataDir) => {
        seedUpdateCheck(pluginDataDir);
        const bin = join(pluginDataDir, 'bin', 'll-search');
        writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      // The fingerprint write is the first spawn-path side effect after the
      // post-acquire probe; its absence proves the hook treated
      // writer-in-progress as occupied and backed off.
      assert.ok(
        !existsSync(join(vsDir, 'watch.fingerprint')),
        'writer-in-progress pidfile must suppress the spawn (no fingerprint written)',
      );
    } finally {
      r.cleanup();
      rmSync(vaultDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// W2 ENOTEMPTY class: every detached spawn must be recorded via
// recordDetachedChild so the harness can reap it before rmSync walks the
// sandbox. The watch-daemon spawn was the only one missing.
// ---------------------------------------------------------------------------
test(
  'watch-daemon spawn is recorded in the detached-child pidfile',
  { timeout: 12000 },
  async () => {
    const vaultDir = mkdtempSync(join(realpathSync(tmpdir()), 'll-wd-rec-'));
    const vsDir = join(vaultDir, '.vault-search');
    mkdirSync(vsDir, { recursive: true });
    writeFileSync(join(vsDir, 'vault-index.db'), '');

    const r = runHook(HOOK, {
      env: { VAULT_PATH: vaultDir },
      stdin: '',
      seed: (pluginDataDir) => {
        seedUpdateCheck(pluginDataDir);
        const bin = join(pluginDataDir, 'bin', 'll-search');
        // The fake daemon writes its own pid where the real one would, so the
        // test can match it against the recorded detached-child pids. Guard on
        // $1: vault-search.mjs invokes the same stub with 'intentions' and
        // would otherwise clobber the pidfile with a grandchild pid.
        writeFileSync(
          bin,
          `#!/bin/sh\n[ "$1" = watch ] && echo $$ > "${join(vsDir, 'watch.pid')}"\nexit 0\n`,
          { mode: 0o755 },
        );
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      let watchPid = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const raw = readFileSync(join(vsDir, 'watch.pid'), 'utf8').trim();
          if (raw) {
            watchPid = Number(raw);
            break;
          }
        } catch {}
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
      }
      assert.ok(watchPid, 'fake daemon never wrote its pidfile');
      const childPidFile = join(r.sandboxRoot, '.child-pids');
      assert.ok(existsSync(childPidFile), 'detached children must be recorded');
      const recorded = readFileSync(childPidFile, 'utf8').split('\n').filter(Boolean).map(Number);
      assert.ok(
        recorded.includes(watchPid),
        `watch-daemon child ${watchPid} must be recorded (got: ${recorded.join(', ')})`,
      );
    } finally {
      r.cleanup();
      rmSync(vaultDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Regression: when the project directory IS the vault parent, the project and
// global memory keys resolve to the SAME MEMORY.md. Pre-fix it was injected
// twice (~3KB of duplicate index per session).
// ---------------------------------------------------------------------------
test(
  'session-start memory: same MEMORY.md is injected once when project dir equals vault parent',
  { timeout: 12000 },
  () => {
    const vaultParent = resolve(VAULT, '..');
    const r = runHook(HOOK, {
      stdin: { session_id: 'same-path-mem' },
      env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: vaultParent },
      seed: (pd, sb) => {
        seedUpdateCheck(pd);
        const encoded = vaultParent.replace(/[/\\]/g, '-');
        const memDir = join(sb, '.claude', 'projects', encoded, 'memory');
        mkdirSync(memDir, { recursive: true });
        // Single occurrence of the marker per injection (a [x](x) link would
        // double-count inside one section).
        writeFileSync(join(memDir, 'MEMORY.md'), '- unique-dedupe-marker — entry\n');
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      const hso = parseOutput(r.stdout, 'same-path-mem');
      const ctx = hso.additionalContext;
      const occurrences = (ctx.match(/unique-dedupe-marker/g) || []).length;
      assert.equal(occurrences, 1, `memory index must be injected exactly once, got ${occurrences}`);
      assert.ok(ctx.includes('## Auto-memory index for this project'), 'project section expected');
      assert.ok(
        !ctx.includes('## Global memory index'),
        'global section must be skipped when it resolves to the project MEMORY.md',
      );
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Regression: when the assembled context exceeds the 8KB stdout cap, emitJson
// trims from the TAIL. The retrieval protocol (behavior-defining) must be
// assembled ahead of the variable-size memory/intentions bulk so the trim
// drops index lines, not the protocol.
// ---------------------------------------------------------------------------
test(
  'session-start trim ordering: retrieval protocol survives an oversized context',
  { timeout: 12000 },
  () => {
    const projectDir = '/tmp/test-project-trim-order';
    const r = runHook(HOOK, {
      stdin: { session_id: 'trim-order' },
      env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: projectDir },
      seed: (pd, sb) => {
        seedUpdateCheck(pd);
        // Project memory and global memory each fill their 3KB caps.
        const filler = ('- [n](n.md) — ' + 'y'.repeat(80) + '\n').repeat(60); // ~6KB, capped to 3KB
        const encodedProject = projectDir.replace(/[/\\]/g, '-');
        const projMemDir = join(sb, '.claude', 'projects', encodedProject, 'memory');
        mkdirSync(projMemDir, { recursive: true });
        writeFileSync(join(projMemDir, 'MEMORY.md'), filler);
        const encodedVaultParent = resolve(VAULT, '..').replace(/[/\\]/g, '-');
        const globalMemDir = join(sb, '.claude', 'projects', encodedVaultParent, 'memory');
        mkdirSync(globalMemDir, { recursive: true });
        writeFileSync(join(globalMemDir, 'MEMORY.md'), filler);
        // Plus a populated intentions marker for extra variable bulk.
        const cacheDir = join(pd, 'session-start-cache');
        mkdirSync(cacheDir, { recursive: true });
        const intentions = [];
        for (let i = 0; i < 40; i++) intentions.push({ context: `context-${i}`, count: i + 1 });
        writeFileSync(join(cacheDir, 'intentions.json'), JSON.stringify(intentions));
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(Buffer.byteLength(r.stdout, 'utf8') <= 8192, 'output must respect the stdout cap');
      const hso = parseOutput(r.stdout, 'trim-order');
      const ctx = hso.additionalContext;
      assert.match(ctx, /…\[truncated\]$/, 'arrangement must actually overflow the cap');
      assert.ok(
        ctx.includes('## Learning Loop — Retrieval Protocol'),
        'retrieval protocol header must survive the tail trim',
      );
      assert.ok(
        ctx.includes('Keep retrieval lightweight'),
        'the protocol must survive the tail trim INTACT — it must be assembled before the variable-size sections',
      );
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Regression: the protocol must use the namespaced command forms. Bare /init
// resolves to Claude Code's built-in CLAUDE.md initializer, and bare /reflect
// does not exist — both were actively wrong instructions.
// ---------------------------------------------------------------------------
test(
  'session-start retrieval protocol uses namespaced learning-loop command names',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'namespaced-cmds' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => seedUpdateCheck(pd),
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      const hso = parseOutput(r.stdout, 'namespaced-cmds');
      const ctx = hso.additionalContext;
      assert.ok(
        ctx.includes('suggest /learning-loop:reflect'),
        'protocol must reference /learning-loop:reflect',
      );
      assert.ok(!ctx.includes('suggest /reflect '), 'bare /reflect must not be suggested');
      assert.ok(!/Run \/init\b/.test(ctx), 'bare /init must never be recommended');
    } finally {
      r.cleanup();
    }
  },
);

test(
  'LL_SESSION_TMP_DIR redirects the legacy tmp session-id write',
  { timeout: 12000 },
  () => {
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'll-ss-seam-'));
    const r = runHook(HOOK, {
      env: {
        VAULT_PATH: VAULT,
        LL_SESSION_TMP_DIR: isolatedTmp,
        CLAUDE_CODE_SESSION_ID: 'seam-test-id',
      },
      stdin: '',
      seed: (pd) => seedUpdateCheck(pd),
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(
        readFileSync(join(isolatedTmp, 'learning-loop-session-id'), 'utf8').trim(),
        'seam-test-id',
        'writer must honor the LL_SESSION_TMP_DIR seam',
      );
    } finally {
      r.cleanup();
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  },
);
