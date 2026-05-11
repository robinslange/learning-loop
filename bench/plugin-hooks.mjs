#!/usr/bin/env node
/**
 * Plugin hook benchmarks — Track 0E baseline.
 *
 * Spawns each hook via child_process.spawn in a sandboxed tempdir.
 * Measures wall-clock time per hook across N iterations.
 *
 * Usage:
 *   node bench/plugin-hooks.mjs
 *   node bench/plugin-hooks.mjs --iterations 20
 *   node bench/plugin-hooks.mjs --hooks session-start,post-tool
 *   node bench/plugin-hooks.mjs --json   (machine-readable output only)
 *
 * Safety: all environment overrides (XDG_DATA_HOME, HOME, CLAUDE_PROJECT_DIR)
 * point to a fresh tempdir. No writes to the user's real data directories.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const ITERATIONS = parseInt(getArg('iterations', '50'), 10);
const JSON_ONLY = hasFlag('json');
const HOOKS_ARG = getArg('hooks', null);

// ---------------------------------------------------------------------------
// Hook definitions (from hooks.json)
// ---------------------------------------------------------------------------

const ALL_HOOKS = [
  {
    name: 'session-start',
    script: 'hooks/session-start.js',
    event: 'SessionStart',
    stdin: JSON.stringify({ session_id: 'bench-session-001', hook_event_name: 'SessionStart' }),
  },
  {
    name: 'post-tool',
    script: 'hooks/post-tool.js',
    event: 'PostToolUse',
    stdin: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/bench.md', content: '# test' },
      tool_response: { success: true },
    }),
  },
  {
    name: 'pre-write-check',
    script: 'hooks/pre-write-check.js',
    event: 'PreToolUse',
    stdin: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/bench.md', content: '# test [[link]]' },
    }),
  },
  {
    name: 'stop-nudge',
    script: 'hooks/stop-nudge.js',
    event: 'Stop',
    stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'bench-session-001' }),
  },
  {
    name: 'pre-compact',
    script: 'hooks/pre-compact.js',
    event: 'PreCompact',
    stdin: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'bench-session-001' }),
  },
  {
    name: 'session-label',
    script: 'hooks/session-label.js',
    event: 'UserPromptSubmit',
    stdin: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'What is the query hot path?',
      session_id: 'bench-session-001',
    }),
  },
  {
    name: 'post-read-retrieval',
    script: 'hooks/post-read-retrieval.js',
    event: 'PostToolUse',
    stdin: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/bench.md' },
      tool_response: { content: '# test content' },
    }),
  },
  {
    name: 'post-search-tracking',
    script: 'hooks/post-search-tracking.js',
    event: 'PostToolUse',
    stdin: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_episodic-memory__search',
      tool_input: { query: 'bench query' },
      tool_response: { results: [] },
    }),
  },
];

const hooksToRun = HOOKS_ARG
  ? ALL_HOOKS.filter((h) => HOOKS_ARG.split(',').includes(h.name))
  : ALL_HOOKS;

// ---------------------------------------------------------------------------
// Sandbox setup
// ---------------------------------------------------------------------------

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'll-bench-'));
  const vaultDir = join(root, 'vault');
  const dataDir = join(root, 'data');
  const projectDir = join(root, 'project');
  const cacheDir = join(root, 'cache');

  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  // Minimal config.json so hooks that read config don't crash
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      vaultPath: vaultDir,
      pluginDataDir: dataDir,
      logLevel: 'silent',
    }),
  );

  // Minimal installed_plugins.json
  writeFileSync(join(dataDir, 'installed_plugins.json'), JSON.stringify({}));

  return {
    root,
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      LL_VAULT_PATH: vaultDir,
      LL_DATA_DIR: dataDir,
      LL_HOOK_DEBUG: '0',
      // Prevent real daemon spawning in session-start
      LL_BENCH_MODE: '1',
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function stats(samples_ns) {
  const sorted = [...samples_ns].sort((a, b) => a - b);
  const n = sorted.length;

  // trimmed mean: drop top and bottom 5%
  const trim = Math.floor(n * 0.05);
  const trimmed = sorted.slice(trim, n - trim);
  const mean_ns = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  const p50_ns = sorted[Math.floor(n * 0.5)];
  const p95_ns = sorted[Math.floor(n * 0.95)];
  const p99_ns = sorted[Math.min(Math.floor(n * 0.99), n - 1)];
  const min_ns = sorted[0];
  const max_ns = sorted[n - 1];

  const variance = trimmed.reduce((a, b) => a + (b - mean_ns) ** 2, 0) / trimmed.length;
  const stddev_ns = Math.sqrt(variance);

  return {
    samples: n,
    mean_ms: mean_ns / 1e6,
    p50_ms: p50_ns / 1e6,
    p95_ms: p95_ns / 1e6,
    p99_ms: p99_ns / 1e6,
    min_ms: min_ns / 1e6,
    max_ms: max_ns / 1e6,
    stddev_ms: stddev_ns / 1e6,
  };
}

// ---------------------------------------------------------------------------
// Run a single hook once
// ---------------------------------------------------------------------------

function runHook(hook, sandbox) {
  const script = join(PLUGIN_ROOT, hook.script);
  const start = process.hrtime.bigint();

  const result = spawnSync(process.execPath, [script], {
    input: hook.stdin,
    env: sandbox.env,
    timeout: 30_000,
    cwd: sandbox.root,
  });

  const elapsed_ns = Number(process.hrtime.bigint() - start);

  return {
    elapsed_ns,
    exit_code: result.status ?? -1,
    timed_out: result.error?.code === 'ETIMEDOUT',
    error: result.error?.message ?? null,
  };
}

// ---------------------------------------------------------------------------
// Bench a single hook
// ---------------------------------------------------------------------------

function benchHook(hook) {
  const sandbox = createSandbox();
  const samples = [];

  // 3 warm-up runs (not counted)
  for (let i = 0; i < 3; i++) {
    runHook(hook, sandbox);
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const r = runHook(hook, sandbox);
    samples.push(r.elapsed_ns);
  }

  sandbox.cleanup();
  return stats(samples);
}

// ---------------------------------------------------------------------------
// Machine info
// ---------------------------------------------------------------------------

function machineInfo() {
  const cpu = cpus()[0]?.model ?? 'unknown';
  const memGb = (totalmem() / 1024 ** 3).toFixed(1);
  let node = 'unknown';
  try {
    node = process.version;
  } catch {
    /* ignore */
  }
  return { platform: process.platform, arch: process.arch, cpu, memGb: parseFloat(memGb), node };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const results = {};
  const machine = machineInfo();

  for (const hook of hooksToRun) {
    if (!JSON_ONLY) {
      process.stderr.write(`  ${hook.name} (${ITERATIONS} iterations)...\n`);
    }
    try {
      results[hook.name] = benchHook(hook);
    } catch (err) {
      results[hook.name] = { error: err.message };
    }
  }

  const output = { machine, iterations: ITERATIONS, hooks: results };

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(output) + '\n');
  } else {
    process.stderr.write('\n');
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`bench/plugin-hooks.mjs failed: ${err.message}\n`);
  process.exit(1);
});
