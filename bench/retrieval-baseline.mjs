#!/usr/bin/env node
// retrieval-baseline.mjs — one-shot baseline for the JIT injection path.
//
// Reads the shadow-injection stream and reports the numbers any change to the
// gate, the query builder, or the fusion order has to beat. Everything here is
// derived from records the hook already writes; nothing is re-run.
//
// Two filters are on by default and both matter for an honest number:
//   · the calibration epoch — the gate threshold has moved (0.35 → 0.30 → 0.40),
//     so pre-epoch records describe a pipeline that no longer exists.
//   · fixture traffic — the session-label test suite invokes the real hook
//     without overriding CLAUDE_PLUGIN_DATA, so its prompts land in this stream
//     unflagged. Pass --with-fixtures to see the contaminated view.
//
// Usage: node bench/retrieval-baseline.mjs [--all-epochs] [--with-fixtures] [--json]

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INJECTION_CALIBRATION_EPOCH } from '../plugin/scripts/lib/hook-config.mjs';

// Prompts hard-coded in tests/session-label.test.mjs reach the production log
// because run()/runWithVault() invoke the real hook without overriding
// CLAUDE_PLUGIN_DATA. Derive the list from the test source rather than copying
// it — a hand-maintained copy silently rots as tests are added, and this filter
// is load-bearing for every number below.
function fixturePrompts() {
  const testFile = join(import.meta.dirname, '..', 'tests', 'session-label.test.mjs');
  const src = readFileSync(testFile, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/['"`]([^'"`\n]{15,200})['"`]/g)) {
    const s = m[1];
    if (/^[/.~]/.test(s) || /^[A-Z_]+$/.test(s) || s.includes('${')) continue;
    out.add(s.slice(0, 40));
  }
  return [...out];
}
const FIXTURE_PROMPTS = fixturePrompts();
const isFixture = (r) => FIXTURE_PROMPTS.some((p) => (r.prompt || '').startsWith(p));

const pluginData =
  process.env.CLAUDE_PLUGIN_DATA ||
  join(process.env.HOME, '.claude/plugins/data/learning-loop-learning-loop-marketplace');
const dir = join(pluginData, 'retrieval');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const allEpochs = args.includes('--all-epochs');
const withFixtures = args.includes('--with-fixtures');
const epochMs = allEpochs ? 0 : Date.parse(INJECTION_CALIBRATION_EPOCH);

const files = readdirSync(dir)
  .filter((f) => f.startsWith('shadow-injection-') && f.endsWith('.jsonl'))
  .sort();

const records = [];
let droppedEpoch = 0;
let droppedFixture = 0;
for (const f of files) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // truncated tail line
    }
    if (Date.parse(r.ts) < epochMs) {
      droppedEpoch++;
      continue;
    }
    if (!withFixtures && isFixture(r)) {
      droppedFixture++;
      continue;
    }
    records.push(r);
  }
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
const quantile = (sorted, q) => (sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : null);

// --- gate funnel -----------------------------------------------------------
const byType = {};
for (const r of records) byType[r.type || 'unknown'] = (byType[r.type || 'unknown'] || 0) + 1;

const considered = records.filter((r) => r.type !== 'gate-fail-fast-path');
const passed = records.filter((r) => r.type === 'gate-pass-payload');
const belowThreshold = records.filter((r) => r.type === 'gate-fail-below-threshold');
// A backend miss is indistinguishable from a genuine low score at the gate; both
// land in gate-fail-below-threshold. Separate them so the pass rate has an
// honest denominator.
const backendBroke = belowThreshold.filter((r) => r.backends?.vault?.error);
const healthyConsidered = considered.length - backendBroke.length;

// --- score separation ------------------------------------------------------
const scores = passed.map((r) => r.gate?.vault_top_score).filter(Number.isFinite).sort((a, b) => a - b);
const failScores = belowThreshold
  .filter((r) => !r.backends?.vault?.error)
  .map((r) => r.gate?.vault_top_score)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);

// --- rerank counterfactual (STEP 3 log-only data) --------------------------
const withRerank = passed.filter((r) => r.rerank?.rerank_top_path);
const rerankErrored = passed.filter((r) => r.rerank?.rerank_error);
const movedTop = withRerank.filter((r) => r.rerank.rerank_moved_top);
const rerankLatency = withRerank
  .map((r) => r.rerank.rerank_latency_ms)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);

// --- padding -------------------------------------------------------------
const paddedPasses = passed.filter((r) => r.gate?.padded);
const loadBearing = passed.filter((r) => r.gate?.padding_load_bearing);

// --- cost ----------------------------------------------------------------
const tokens = passed.map((r) => r.payload?.tokens_estimated).filter(Number.isFinite);
const totalTokens = tokens.reduce((a, b) => a + b, 0);
const liveTokens = passed
  .filter((r) => r.mode === 'live')
  .map((r) => r.payload?.tokens_estimated || 0)
  .reduce((a, b) => a + b, 0);

// --- latency (negative/absurd values are a known clock bug; excluded) ------
const vaultLatency = considered
  .map((r) => r.backends?.vault?.latency_ms)
  .filter((n) => Number.isFinite(n) && n >= 0 && n < 60_000)
  .sort((a, b) => a - b);
const badLatency = considered.filter((r) => {
  const n = r.backends?.vault?.latency_ms;
  return Number.isFinite(n) && (n < 0 || n >= 60_000);
}).length;

const report = {
  files,
  epoch: allEpochs ? 'all' : INJECTION_CALIBRATION_EPOCH,
  dropped_pre_epoch: droppedEpoch,
  dropped_fixture: droppedFixture,
  total_records: records.length,
  funnel: {
    by_type: byType,
    fast_path_skipped: byType['gate-fail-fast-path'] || 0,
    considered: considered.length,
    backend_error: backendBroke.length,
    healthy_considered: healthyConsidered,
    passed_with_payload: passed.length,
    healthy_pass_rate: passed.length / healthyConsidered,
  },
  score_separation: {
    pass_p10: quantile(scores, 0.1),
    pass_p50: quantile(scores, 0.5),
    pass_p90: quantile(scores, 0.9),
    pass_max: scores[scores.length - 1],
    fail_p50: quantile(failScores, 0.5),
    fail_max: failScores[failScores.length - 1],
    // The whole discriminative range the 0.4 gate has to work with.
    observed_span: scores.length ? scores[scores.length - 1] - (failScores[0] ?? 0) : null,
  },
  rerank_counterfactual: {
    passes_with_rerank: withRerank.length,
    rerank_errors: rerankErrored.length,
    moved_top: movedTop.length,
    moved_top_rate: withRerank.length ? movedTop.length / withRerank.length : null,
    latency_p50: quantile(rerankLatency, 0.5),
    latency_p95: quantile(rerankLatency, 0.95),
  },
  padding: {
    padded_passes: paddedPasses.length,
    padded_rate: passed.length ? paddedPasses.length / passed.length : null,
    load_bearing: loadBearing.length,
    load_bearing_rate: passed.length ? loadBearing.length / passed.length : null,
  },
  cost: {
    injections: tokens.length,
    tokens_p50: quantile([...tokens].sort((a, b) => a - b), 0.5),
    tokens_total: totalTokens,
    tokens_live: liveTokens,
  },
  latency: {
    vault_p50: quantile(vaultLatency, 0.5),
    vault_p95: quantile(vaultLatency, 0.95),
    vault_max: vaultLatency[vaultLatency.length - 1],
    impossible_values: badLatency,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const f = report.funnel;
  console.log('JIT injection baseline');
  console.log('='.repeat(60));
  console.log(`  Epoch:               ${report.epoch}`);
  console.log(`  Records:             ${report.total_records}`);
  console.log(`  Dropped pre-epoch:   ${report.dropped_pre_epoch}`);
  console.log(`  Dropped fixture:     ${report.dropped_fixture}  (test-suite traffic in the production stream)`);
  console.log('');
  console.log('Gate funnel');
  console.log(`  Fast-path skipped:   ${f.fast_path_skipped}  (${pct(f.fast_path_skipped, report.total_records)})`);
  console.log(`  Considered:          ${f.considered}`);
  console.log(`  Backend error:       ${f.backend_error}  (${pct(f.backend_error, f.considered)} — counted as fails today)`);
  console.log(`  Healthy considered:  ${f.healthy_considered}`);
  console.log(`  Passed w/ payload:   ${f.passed_with_payload}  (${pct(f.passed_with_payload, f.healthy_considered)} of healthy)`);
  console.log('');
  const s = report.score_separation;
  console.log('Gate score separation (RRF fusion score)');
  console.log(`  Passing p10/p50/p90: ${s.pass_p10?.toFixed(3)} / ${s.pass_p50?.toFixed(3)} / ${s.pass_p90?.toFixed(3)}`);
  console.log(`  Passing max:         ${s.pass_max?.toFixed(3)}`);
  console.log(`  Failing p50/max:     ${s.fail_p50?.toFixed(3)} / ${s.fail_max?.toFixed(3)}`);
  console.log(`  Whole observed span: ${s.observed_span?.toFixed(3)}  <- the range 0.4 must cut`);
  console.log('');
  const rr = report.rerank_counterfactual;
  console.log('Rerank counterfactual (cross-encoder, currently log-only)');
  console.log(`  Passes with rerank:  ${rr.passes_with_rerank}   errors: ${rr.rerank_errors}`);
  console.log(`  Would move top slot: ${rr.moved_top}  (${pct(rr.moved_top, rr.passes_with_rerank)})`);
  console.log(`  Latency p50/p95:     ${rr.latency_p50}ms / ${rr.latency_p95}ms`);
  console.log('');
  const p = report.padding;
  console.log('Query padding');
  console.log(`  Padded passes:       ${p.padded_passes}  (${pct(p.padded_passes, f.passed_with_payload)})`);
  console.log(`  Padding load-bearing:${p.load_bearing}  (${pct(p.load_bearing, f.passed_with_payload)} of passes)`);
  console.log('');
  const c = report.cost;
  console.log('Cost');
  console.log(`  Injections:          ${c.injections}`);
  console.log(`  Tokens p50:          ${c.tokens_p50}`);
  console.log(`  Tokens total:        ${c.tokens_total.toLocaleString()}  (live: ${c.tokens_live.toLocaleString()})`);
  console.log('');
  const l = report.latency;
  console.log('Latency');
  console.log(`  Vault p50/p95/max:   ${l.vault_p50}ms / ${l.vault_p95}ms / ${l.vault_max}ms`);
  console.log(`  Impossible values:   ${l.impossible_values}  (clock bug — excluded above)`);
}
