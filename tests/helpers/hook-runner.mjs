// tests/helpers/hook-runner.mjs
// Hermetic hook runner for characterisation tests.
// Each invocation gets a fresh temp sandbox for HOME and plugin-data.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
  const pluginDataDir = join(sandboxRoot, 'plugin-data');
  mkdirSync(pluginDataDir, { recursive: true });

  // Seed callback fires before spawn.
  if (typeof seed === 'function') {
    seed(pluginDataDir, sandboxRoot);
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
    // Remove sandbox.
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
