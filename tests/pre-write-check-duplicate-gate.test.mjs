// tests/pre-write-check-duplicate-gate.test.mjs
// Covers checkDuplicateNote in hooks/pre-write-check.js via a stub ll-search
// emitting a canned reflect-scan envelope. Contract: above-threshold non-self
// match warns; self-match is exempt; below-threshold is silent; a crashing
// binary fails OPEN (write allowed) with a logged error.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { runHook } from './helpers/hook-runner.mjs';
import { skipOnWindows } from './helpers/platform.mjs';
import { VAULT_DIRS, TITLE_INDEX_EXTRA_DIRS } from '../plugin/hooks/lib/snapshot.mjs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';
import { DUPLICATE_GATE_STALE_DAEMON_CODE } from '../plugin/hooks/pre-write-check.js';

const HOOK = fileURLToPath(new URL('../plugin/hooks/pre-write-check.js', import.meta.url));
const UDS_SERVER = fileURLToPath(new URL('./helpers/uds-reflect-server.mjs', import.meta.url));

const SKIP = skipOnWindows('UDS socket: filesystem sockets not supported on win32');
let VAULT;

function reflectEnvelope(similarity, path, title) {
  return JSON.stringify({
    queries: [
      {
        query: 'Sleep consolidates memory',
        top_match_similarity: similarity,
        results: [{ path, title }],
      },
    ],
    confusable_pairs: [],
  });
}

// Spawn the standalone UDS server on `socketPath` and block (sync poll) until
// the socket file appears, so the hook child can connect immediately. Returns
// the child so the test can SIGTERM it after.
function startUdsServer(socketPath, mode) {
  const child = spawn(process.execPath, [UDS_SERVER, socketPath, mode], { stdio: 'ignore' });
  // unref the handle so the server child can never keep the test runner's event
  // loop alive: a ChildProcess handle holds the loop open until its async 'exit'
  // lands, which can race past end-of-tests and wedge `node --test`. Cleanup is
  // explicit via stopUdsServer; this only removes the loop-keepalive.
  child.unref();
  const deadline = Date.now() + 4000;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(socketPath) && Date.now() < deadline) {
    // Sleep ~5ms between polls (listen() on a UDS is sub-millisecond, but the
    // child process needs a beat to start). Atomics.wait yields the CPU.
    Atomics.wait(sab, 0, 0, 5);
  }
  return child;
}

// SIGTERM the server child and block until it actually exits. server.kill() is
// fire-and-forget; without waiting, an in-flight 'hang'-mode connection can keep
// the orphaned child alive past worker teardown and wedge `node --test`
// (process isolation waits on every descendant). Bounded poll on child.exitCode.
function stopUdsServer(child) {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 3000;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    Atomics.wait(sab, 0, 0, 5);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function readHookErrorsByCode(pluginDataDir, code) {
  let count = 0;
  let names = [];
  try {
    names = readdirSync(pluginDataDir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!n.startsWith('hook-errors-') || !n.endsWith('.jsonl')) continue;
    let raw = '';
    try {
      raw = readFileSync(join(pluginDataDir, n), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).code === code) count++;
      } catch {
        /* skip */
      }
    }
  }
  return count;
}

function readHookErrorTimeouts(pluginDataDir) {
  return readHookErrorsByCode(pluginDataDir, 'duplicate-gate-timeout');
}

// Note content with a # title (triggers the gate) and no wikilinks (no
// broken-link noise in additionalContext).
const NOTE =
  '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\n\n# Sleep consolidates memory\n\nClean body.\n';

function runWithStub(
  stubScript,
  filePath,
  { allowStderrError = false, tool = 'Write', toolInput = null } = {},
) {
  const r = runHook(HOOK, {
    timeoutMs: 30000,
    stdin: {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput ?? { file_path: filePath, content: NOTE },
    },
    // Generous wall-clock budget: under a contended full-suite run the 3s
    // production default can be consumed by cold Node startup before the gate's
    // subprocess fallback runs, flaking these fallback assertions. The
    // production default is unchanged; this seam only affects the test process.
    env: { VAULT_PATH: VAULT, LL_PRE_WRITE_BUDGET_MS: '30000' },
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

// Run the hook with a live UDS server at <pluginData>/nli.sock plus a stub
// binary. `serverMode` is 'respond:<b64>' or 'hang'. Captures the
// duplicate-gate-timeout count from the hook-errors log BEFORE cleanup wipes
// the sandbox, and reaps the server child.
function runWithSocket(serverMode, filePath, { stubScript, allowStderrError = false } = {}) {
  let server = null;
  const r = runHook(HOOK, {
    timeoutMs: 30000,
    stdin: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: NOTE },
    },
    // Generous wall-clock budget so the daemon attempt plus subprocess fallback
    // complete deterministically under a contended full-suite run. Production
    // default unchanged; this seam only affects the test process.
    env: { VAULT_PATH: VAULT, LL_PRE_WRITE_BUDGET_MS: '30000' },
    seed: (pluginDataDir) => {
      const binDir = join(pluginDataDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      // Default stub fails LOUDLY if invoked, so socket-success tests prove the
      // subprocess never ran; fallback tests pass their own working stub.
      writeFileSync(
        join(binDir, 'll-search'),
        stubScript ?? '#!/bin/sh\necho "subprocess should not run" 1>&2\nexit 1\n',
      );
      chmodSync(join(binDir, 'll-search'), 0o755);
      server = startUdsServer(join(pluginDataDir, 'nli.sock'), serverMode);
    },
  });
  try {
    assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
    assert.equal(r.exitCode, 0, r.stderr);
    if (!allowStderrError) {
      assert.ok(!r.stderr.includes('"level":"error"'), `hook logged an error: ${r.stderr}`);
    }
    const timeoutCount = readHookErrorTimeouts(r.pluginDataDir);
    const out = r.stdout.trim();
    return { result: out ? JSON.parse(out) : null, stderr: r.stderr, timeoutCount };
  } finally {
    stopUdsServer(server);
    r.cleanup();
  }
}

describe('pre-write-check duplicate-note gate', { skip: SKIP }, () => {
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
    assert.equal(
      result.hookSpecificOutput.permissionDecision,
      undefined,
      'duplicate gate must warn, never deny',
    );
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
    assert.match(
      stderr,
      /pre-write-check\.checkDuplicateNote/,
      `expected the gate's logError scope in stderr; got: ${stderr}`,
    );
  });

  it('socket success: the warm daemon serves the scan and the subprocess never runs', () => {
    const b64 = Buffer.from(
      reflectEnvelope(0.92, '3-permanent/sleep-existing.md', 'Existing sleep note'),
    ).toString('base64');
    const { result } = runWithSocket(`respond:${b64}`, join(VAULT, '0-inbox', 'new-note.md'));
    assert.ok(result, 'expected a warning payload from the daemon path');
    assert.match(result.hookSpecificOutput.additionalContext, /Potential duplicate/);
    assert.match(result.hookSpecificOutput.additionalContext, /92% similar/);
  });

  it('socket absent: falls back to the subprocess and still warns', () => {
    // No nli.sock created (no server) — the gate must use the stub binary.
    const { result } = runWithStub(
      envelopeStub(0.92, '3-permanent/sleep-existing.md', 'Existing sleep note'),
      join(VAULT, '0-inbox', 'new-note.md'),
    );
    assert.ok(result, 'expected a warning payload from the subprocess fallback');
    assert.match(result.hookSpecificOutput.additionalContext, /92% similar/);
  });

  it('socket timeout: logs the distinct duplicate-gate-timeout code, then falls back to subprocess', () => {
    const { result, timeoutCount } = runWithSocket('hang', join(VAULT, '0-inbox', 'new-note.md'), {
      // Working subprocess stub so the gate still produces a warning after the
      // socket times out (proves the fallback fires).
      stubScript: envelopeStub(0.92, '3-permanent/sleep-existing.md', 'Existing sleep note'),
    });
    assert.ok(timeoutCount >= 1, 'a socket timeout must log the duplicate-gate-timeout code');
    assert.ok(result, 'subprocess fallback must still produce the duplicate warning');
    assert.match(result.hookSpecificOutput.additionalContext, /92% similar/);
  });

  it('stale daemon: logs distinct stale-daemon code and falls back to subprocess', () => {
    // A stale daemon binary replies with the old-daemon error envelope
    // ({schema_version:1,error:'parse request:...'}) — the hook must log
    // the distinct stale-daemon code and still fall back to the subprocess.
    let server = null;
    const r = runHook(HOOK, {
      timeoutMs: 30000,
      stdin: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(VAULT, '0-inbox', 'new-note.md'), content: NOTE },
      },
      // Generous budget so the subprocess fallback completes under load.
      env: { VAULT_PATH: VAULT, LL_PRE_WRITE_BUDGET_MS: '30000' },
      seed: (pluginDataDir) => {
        const binDir = join(pluginDataDir, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
          join(binDir, 'll-search'),
          envelopeStub(0.92, '3-permanent/sleep-existing.md', 'Existing sleep note'),
        );
        chmodSync(join(binDir, 'll-search'), 0o755);
        server = startUdsServer(join(pluginDataDir, 'nli.sock'), 'stale-daemon');
      },
    });
    try {
      assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
      assert.equal(r.exitCode, 0, r.stderr);
      const staleDaemonCount = readHookErrorsByCode(
        r.pluginDataDir,
        DUPLICATE_GATE_STALE_DAEMON_CODE,
      );
      assert.ok(staleDaemonCount >= 1, 'stale daemon response must log the stale-daemon code');
      const out = r.stdout.trim();
      const result = out ? JSON.parse(out) : null;
      // Subprocess fallback must still run and produce the duplicate warning.
      assert.ok(result, 'subprocess fallback must produce a warning even after stale-daemon error');
      assert.match(result.hookSpecificOutput.additionalContext, /92% similar/);
    } finally {
      stopUdsServer(server);
      r.cleanup();
    }
  });
});
