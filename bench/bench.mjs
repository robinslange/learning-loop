#!/usr/bin/env node
/**
 * Bench harness entry point — Track 0E.
 *
 * Runs all Rust (Criterion) + plugin hook benches and produces a structured
 * JSON output suitable for comparison and baseline storage.
 *
 * Usage:
 *   node bench/bench.mjs                    # full bench (long)
 *   node bench/bench.mjs --quick            # 1k notes, fewer iterations
 *   node bench/bench.mjs --save-baseline    # write to bench/baselines/YYYY-MM-DD.json
 *   node bench/bench.mjs --compare <path>   # compare against saved baseline
 *   node bench/bench.mjs --rust-only        # skip plugin bench
 *   node bench/bench.mjs --plugin-only      # skip Rust bench
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { env as pluginEnv, spawnEnv } from '../plugin/scripts/lib/env.mjs';
import { logError } from '../plugin/scripts/lib/log.mjs';
import { safeLoad } from '../plugin/scripts/lib/safe-load.mjs';

const BENCH_DIR = import.meta.dirname;
const REPO_ROOT = resolve(BENCH_DIR, '..');
const NATIVE_DIR = join(REPO_ROOT, 'native');
const BASELINES_DIR = join(BENCH_DIR, 'baselines');

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI parse
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function hasFlag(name) {
  return args.includes(`--${name}`);
}
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}

const QUICK = hasFlag('quick');
const SAVE_BASELINE = hasFlag('save-baseline');
const COMPARE_PATH = getArg('compare', null);
const RUST_ONLY = hasFlag('rust-only');
const PLUGIN_ONLY = hasFlag('plugin-only');
const REAL_ONNX = pluginEnv.LL_BENCH_REAL_ONNX;

// ---------------------------------------------------------------------------
// Machine info (using spawnSync to avoid exec injection lint)
// ---------------------------------------------------------------------------

function runCommand(cmd, args_list, cwd) {
  const r = spawnSync(cmd, args_list, { encoding: 'utf8', cwd: cwd ?? REPO_ROOT, timeout: 5000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : 'unknown';
}

function machineInfo() {
  const cpu = cpus()[0]?.model ?? 'unknown';
  const memGb = parseFloat((totalmem() / 1024 ** 3).toFixed(1));
  const rustc = runCommand('rustc', ['--version']);
  const node = process.version;
  const osVersion =
    process.platform === 'darwin' ? runCommand('sw_vers', ['-productVersion']) : process.platform;
  return { os: osVersion, arch: process.arch, cpu, memGb, rustc, node };
}

function gitSha() {
  return runCommand('git', ['rev-parse', 'HEAD']);
}

// ---------------------------------------------------------------------------
// Criterion JSON parser
// ---------------------------------------------------------------------------

/**
 * Criterion 0.5 stores results at two possible paths depending on whether
 * bench_function or bench_with_input was used:
 *
 *   bench_function("name"):
 *     target/criterion/{name}/new/estimates.json
 *
 *   bench_with_input(BenchmarkId::new("name", param), ...):
 *     target/criterion/{name}/{param}/new/estimates.json
 *
 * This parser tries both paths and merges them.
 */
function parseCriterionVariant(variantDir) {
  // Try flat: criterion/{variantDir}/new/estimates.json
  const flat = join(variantDir, 'new', 'estimates.json');
  if (existsSync(flat)) {
    const { value: raw } = safeLoad(flat);
    if (raw) {
      return {
        mean_ns: raw.mean?.point_estimate ?? null,
        stddev_ns: raw.mean?.standard_error ?? null,
        median_ns: raw.median?.point_estimate ?? null,
      };
    }
  }

  // Try parametrised: criterion/{variantDir}/{param}/new/estimates.json
  // Pick the highest-param subdirectory (most notes = most representative)
  let best = null;
  try {
    const subs = readdirSync(variantDir).filter(
      (s) => s !== 'report' && statSync(join(variantDir, s)).isDirectory(),
    );
    for (const sub of subs) {
      const nested = join(variantDir, sub, 'new', 'estimates.json');
      if (existsSync(nested)) {
        const { value: raw } = safeLoad(nested);
        if (raw) {
          const est = {
            mean_ns: raw.mean?.point_estimate ?? null,
            stddev_ns: raw.mean?.standard_error ?? null,
            median_ns: raw.median?.point_estimate ?? null,
            param: sub,
          };
          if (!best || parseFloat(sub) > parseFloat(best.param ?? '0')) {
            best = est;
          }
        }
      }
    }
  } catch (err) {
    logError('bench.parseCriterionVariant.readdirSync', err);
  }
  return best;
}

function criterionResults(_benchName) {
  const criterionDir = join(NATIVE_DIR, 'target', 'criterion');
  if (!existsSync(criterionDir)) return {};
  const results = {};
  try {
    for (const entry of readdirSync(criterionDir)) {
      if (entry === 'report') continue;
      const entryPath = join(criterionDir, entry);
      if (!statSync(entryPath).isDirectory()) continue;
      const est = parseCriterionVariant(entryPath);
      if (est) results[entry] = est;
    }
  } catch (err) {
    logError('bench.criterionResults', err);
  }
  return results;
}

// Variant-to-bench-file mapping (from bench definitions)
const BENCH_VARIANTS = {
  query_hot_path: ['cold_first_call', 'warm_reused_context', 'warm_with_recency_filter'],
  embed_throughput: ['preprocess_only', 'real_onnx'],
  index_reindex: ['cold_preprocess_only', 'cold_full_onnx', 'warm_no_changes'],
};

// ---------------------------------------------------------------------------
// Rust bench runner
// ---------------------------------------------------------------------------

function runRustBenches() {
  if (PLUGIN_ONLY) return { skipped: 'plugin-only flag set' };

  const env = spawnEnv();
  if (QUICK) env.CARGO_BENCH_QUICK = '1';

  const results = {};

  for (const bench of Object.keys(BENCH_VARIANTS)) {
    process.stderr.write(`[rust] Running ${bench}${QUICK ? ' (quick)' : ''}...\n`);
    const r = spawnSync(
      'cargo',
      ['bench', '-p', 'll-search', '--bench', bench, '--', ...(QUICK ? ['--quick'] : [])],
      {
        cwd: NATIVE_DIR,
        env,
        timeout: QUICK ? 300_000 : 1800_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    if (r.status !== 0) {
      const stderr = r.stderr?.toString() ?? '';
      results[bench] = {
        skipped: `cargo bench failed (exit ${r.status})`,
        stderr: stderr.slice(-500),
      };
    } else {
      // Only read variants belonging to this bench file
      const benched = {};
      for (const variant of BENCH_VARIANTS[bench]) {
        const variantDir = join(NATIVE_DIR, 'target', 'criterion', variant);
        if (existsSync(variantDir)) {
          const est = parseCriterionVariant(variantDir);
          if (est) {
            benched[variant] = est;
          } else {
            benched[variant] = { skipped: 'no estimates.json (variant may be ONNX-gated)' };
          }
        } else {
          benched[variant] = {
            skipped: 'no criterion directory (variant may be ONNX-gated or skipped)',
          };
        }
      }
      results[bench] = benched;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Plugin bench runner
// ---------------------------------------------------------------------------

function runPluginBenches() {
  if (RUST_ONLY) return { skipped: 'rust-only flag set' };

  const iterations = QUICK ? 10 : 50;
  process.stderr.write(`[plugin] Running hook benches (${iterations} iterations)...\n`);

  const r = spawnSync(
    process.execPath,
    [join(BENCH_DIR, 'plugin-hooks.mjs'), '--iterations', String(iterations), '--json'],
    {
      cwd: REPO_ROOT,
      timeout: QUICK ? 180_000 : 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (r.status !== 0) {
    return {
      skipped: `plugin-hooks failed (exit ${r.status})`,
      stderr: r.stderr?.toString().slice(-500) ?? '',
    };
  }

  try {
    return JSON.parse(r.stdout.toString());
  } catch (err) {
    logError('bench.parseResult', err);
    return { skipped: 'JSON parse error', raw: r.stdout?.toString().slice(-200) };
  }
}

// ---------------------------------------------------------------------------
// Budget definitions (from baseline-2026-05-11.md Part 1.4)
// ---------------------------------------------------------------------------

const BUDGETS = {
  rust: {
    'query_hot_path/warm_reused_context': { p50_ns: 20_000_000, p95_ns: 50_000_000 },
    'query_hot_path/cold_first_call': { p50_ns: 80_000_000, p95_ns: 150_000_000 },
  },
  plugin: {
    'session-start': { p50_ms: 200, p95_ms: 500 },
    'post-tool': { p50_ms: 50, p95_ms: 150 },
    'pre-write-check': { p50_ms: 30, p95_ms: 80 },
  },
};

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

function compareBaselines(current, baseline) {
  const report = { regressions: [], improvements: [] };

  function check(name, curr, prev, thresholdPct = 20) {
    if (curr == null || prev == null || prev === 0) return;
    const pct = ((curr - prev) / prev) * 100;
    if (pct > thresholdPct) {
      report.regressions.push({ name, prev, curr, pct: pct.toFixed(1) });
    } else if (pct < -thresholdPct) {
      report.improvements.push({ name, prev, curr, pct: pct.toFixed(1) });
    }
  }

  for (const [bench, variants] of Object.entries(current.rust ?? {})) {
    if (variants.skipped) continue;
    for (const [variant, est] of Object.entries(variants)) {
      const prev = baseline.rust?.[bench]?.[variant];
      if (prev && est?.mean_ns != null) {
        check(`rust/${bench}/${variant}`, est.mean_ns, prev.mean_ns);
      }
    }
  }

  const currHooks = current.plugin?.hooks ?? {};
  const prevHooks = baseline.plugin?.hooks ?? {};
  for (const [hook, curr] of Object.entries(currHooks)) {
    const prev = prevHooks[hook];
    if (prev?.p50_ms != null && curr?.p50_ms != null) {
      check(`plugin/${hook}/p50_ms`, curr.p50_ms, prev.p50_ms);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write(`Bench harness (quick=${QUICK}, real-onnx=${REAL_ONNX})\n`);
  process.stderr.write(`Repo: ${REPO_ROOT}\n\n`);

  const machine = machineInfo();
  const sha = gitSha();

  const rustResults = runRustBenches();
  const pluginResults = runPluginBenches();

  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    gitSha: sha,
    quick: QUICK,
    realOnnx: REAL_ONNX,
    machine,
    rust: rustResults,
    plugin: pluginResults,
    budgets: BUDGETS,
    notes: [
      'Rust benches: Criterion 0.5, synthetic in-memory DB, pre-computed embeddings.',
      'embed_throughput/real_onnx and index_reindex/*_onnx require LL_BENCH_REAL_ONNX=1.',
      'Plugin benches: child_process.spawn per iteration, sandboxed tempdir, no real cache writes.',
      'All timings are machine-specific. Compare only within same machine profile.',
    ],
  };

  if (COMPARE_PATH && existsSync(COMPARE_PATH)) {
    const { value: baseline, error: baselineError } = safeLoad(COMPARE_PATH);
    if (baselineError) {
      output.comparison = { error: baselineError };
    } else {
      output.comparison = compareBaselines(output, baseline);
    }
  }

  const json = JSON.stringify(output, null, 2);
  process.stdout.write(json + '\n');

  if (SAVE_BASELINE) {
    mkdirSync(BASELINES_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const outPath = join(BASELINES_DIR, `${date}.json`);
    writeFileSync(outPath, json);
    process.stderr.write(`\nBaseline saved to: ${outPath}\n`);
  }

  const regressions = output.comparison?.regressions ?? [];
  if (regressions.length > 0) {
    process.stderr.write(`\nWARNING: ${regressions.length} regression(s) detected (soft gate)\n`);
    for (const r of regressions) {
      process.stderr.write(`  ${r.name}: +${r.pct}%\n`);
    }
  }
  // Soft gate: exit 0. Phase 1 flips to hard fail.
}

main().catch((err) => {
  process.stderr.write(`bench/bench.mjs failed: ${err.message}\n`);
  process.exit(1);
});
