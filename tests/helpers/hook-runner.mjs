// tests/helpers/hook-runner.mjs
// Hermetic hook runner for characterisation tests.
// Each invocation gets a fresh temp sandbox for HOME and plugin-data.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolvePluginData } from '../../scripts/lib/config.mjs';

const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

const SANDBOX_PREFIX = 'll-hook-sb-';
const STALE_SANDBOX_MS = 60 * 60 * 1000;

/**
 * Delete leftover ll-hook-sb-* sandboxes older than 1h. Killed test runs
 * (SIGKILL skips both finally and the exit handler) leak sandboxes; this
 * sweep at module load reclaims them. 1h margin means a concurrently-running
 * suite's live sandboxes are never touched.
 */
export function sweepStaleSandboxes(now = Date.now()) {
  let removed = 0;
  for (const dir of new Set([tmpdir(), '/tmp'])) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.startsWith(SANDBOX_PREFIX)) continue;
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > STALE_SANDBOX_MS) {
          rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Already gone (parallel sweep) or unreadable — skip.
      }
    }
  }
  return removed;
}
sweepStaleSandboxes();

// At exit, re-reap EVERY sandbox this process allocated — never removed from
// the set by cleanup(). Covers both sandboxes whose cleanup() never ran
// (assertion threw before finally, runner aborted) and sandboxes a hook's
// detached child (e.g. the session-start provenance emitter) resurrected
// AFTER cleanup() ran rmSync. Children that outlive the whole test process
// can still leak, and SIGKILL skips this handler — both residues are what
// the 1h startup sweep above is for.
const allSandboxes = new Set();
process.on('exit', () => {
  for (const p of allSandboxes) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

// Resolve a real ll-search binary to symlink into sandboxes. Lookup mirrors
// scripts/lib/binary.mjs: installed plugin-data first, dev build second.
let realBinaryResolved = false;
let realBinaryPath = null;
function resolveRealBinary() {
  if (realBinaryResolved) return realBinaryPath;
  realBinaryResolved = true;
  const candidates = [];
  try {
    const pd = resolvePluginData();
    if (pd) candidates.push(join(pd, 'bin', 'll-search'));
  } catch {}
  candidates.push(fileURLToPath(new URL('../../native/target/release/ll-search', import.meta.url)));
  realBinaryPath = candidates.find((c) => existsSync(c)) || null;
  return realBinaryPath;
}

/**
 * Reap a watch daemon by reading a pidfile, SIGTERM-ing the pid, briefly
 * waiting, then SIGKILL if still alive. Removes the pidfile last. Safe to
 * call on a non-existent pidfile or a pidfile naming a dead pid.
 *
 * @param {string} pidPath
 */
function reapPidfile(pidPath) {
  let pid = null;
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      try {
        process.kill(parsed, 0);
        pid = parsed;
      } catch {
        // Already dead.
      }
    }
  } catch {
    // No pidfile.
  }
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    // Sync wait up to ~200ms for graceful exit.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited cleanly.
    }
  }
  try {
    rmSync(pidPath, { force: true });
  } catch {}
}

/**
 * Run a hook script in a hermetic sandbox.
 *
 * @param {string} hookPath   Absolute path to the hook .js file.
 * @param {object} opts
 *   stdin        {string|object}  Hook stdin. Objects are JSON.stringify'd.
 *   env          {Record<string,string>}  Extra env vars (merged on top of minimal set).
 *   cwd          {string}         Working directory for the child process.
 *   timeoutMs    {number}         Kill timeout (default 8000).
 *   seed         {(pluginDataDir: string, sandboxRoot: string) => void}
 *                                 Called BEFORE spawning; use to write fixture files
 *                                 into the sandbox (e.g. update-check.json).
 *
 * @returns {{
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number,
 *   signal: string|null,
 *   pluginDataDir: string,
 *   sandboxRoot: string,
 *   tmpKeys: string[],
 *   cleanup: () => void,
 * }}
 */
export function runHook(hookPath, opts = {}) {
  const {
    stdin = '',
    env = {},
    cwd,
    timeoutMs = 8000,
    seed,
  } = opts;

  // Allocate per-call sandbox so nothing leaks across tests.
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'll-hook-sb-'));
  allSandboxes.add(sandboxRoot);
  const pluginDataDir = join(sandboxRoot, 'plugin-data');
  mkdirSync(pluginDataDir, { recursive: true });

  // Seed bin/.version with the running plugin version BEFORE anything else:
  // an absent .version makes session-start's cache-cleanup treat the sandbox
  // as a fresh install and spawn a DETACHED download-binary.mjs that outlives
  // cleanup() and re-creates the sandbox with a 290MB binary (the 2026-06
  // $TMPDIR leak + Gatekeeper-rescan flake mechanism).
  const binDir = join(pluginDataDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, '.version'), `v${PKG_VERSION}\n`);

  // Seed callback fires before spawn.
  if (typeof seed === 'function') {
    seed(pluginDataDir, sandboxRoot);
  }

  // Symlink (never copy) a real binary AFTER the seed callback and only when
  // the test didn't provide its own stub: writeFileSync onto a symlink writes
  // through to the target, so linking first would let a stub clobber the real
  // binary. Symlinks don't trigger fresh Gatekeeper assessments.
  const sandboxBin = join(binDir, 'll-search');
  if (!existsSync(sandboxBin)) {
    const real = resolveRealBinary();
    if (real) {
      try {
        symlinkSync(real, sandboxBin);
      } catch {}
    }
  }

  // On macOS, tmpdir() may return /var/folders/... while child processes that
  // inherit a normal env return /tmp (the symlink). Scan both so we don't miss
  // marker files written by the hook child.
  const tmp = tmpdir();
  const altTmp = '/tmp';
  function listTmpKeys() {
    const keys = new Set();
    for (const dir of new Set([tmp, altTmp])) {
      try {
        for (const n of readdirSync(dir)) {
          if (n.startsWith('learning-loop-')) keys.add(n);
        }
      } catch {}
    }
    return keys;
  }

  const beforeKeys = listTmpKeys();

  const stdinStr = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);

  const result = spawnSync(process.execPath, [hookPath], {
    input: stdinStr,
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: cwd || resolve(hookPath, '../..'),
    env: {
      // Minimal inheritable env — no HOME bleed.
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH || '',
      // Hermeticity: redirect home() calls to sandboxRoot.
      HOME: sandboxRoot,
      USERPROFILE: sandboxRoot,
      // Silence debug output by default.
      LL_HOOK_DEBUG: '0',
      // Inject plugin data dir so resolvePluginData() finds it.
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      // Consumer-provided overrides (VAULT_PATH, CLAUDE_PROJECT_DIR, etc.).
      ...env,
    },
  });

  const afterKeys = listTmpKeys();
  const tmpKeys = [...afterKeys].filter((k) => !beforeKeys.has(k));

  function cleanup() {
    // Reap any watch daemons this test caused to spawn. Two locations:
    // (1) the sandbox's plugin-data (legacy pidfile location);
    // (2) the vault's .vault-search/ if a VAULT_PATH was supplied (current
    //     pidfile location). Without this, detached daemons survive the test
    //     and accumulate as zombies.
    reapPidfile(join(pluginDataDir, 'watch.pid'));
    const vaultPath = env.VAULT_PATH;
    if (vaultPath) {
      reapPidfile(join(vaultPath, '.vault-search', 'watch.pid'));
    }
    // Remove sandbox. Intentionally NOT removed from allSandboxes — the exit
    // handler re-reaps it in case a detached child resurrects it later.
    rmSync(sandboxRoot, { recursive: true, force: true });
    // Remove any learning-loop-* tmp files this run created (check both dirs).
    for (const key of tmpKeys) {
      for (const dir of new Set([tmp, altTmp])) {
        try {
          rmSync(join(dir, key), { recursive: true, force: true });
        } catch {}
      }
    }
  }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? (result.signal ? 1 : 0),
    signal: result.signal || null,
    pluginDataDir,
    sandboxRoot,
    tmpKeys,
    cleanup,
  };
}
