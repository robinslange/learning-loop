import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessGateReachability } from '../plugin/scripts/lib/gate-reachability.mjs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';

/** n scores spread evenly across [lo, hi]. */
function spread(lo, hi, n) {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

test('flags a gate no observed score can reach', () => {
  // The v1.40.0 regression: weighted fusion caps the sum at 0.4333 while the
  // gate sits at 0.50 (the value on feat/jit-injection-quality).
  const r = assessGateReachability({ scores: spread(0.16, 0.4333, 200), threshold: 0.5 });
  assert.equal(r.verdict, 'unreachable');
  assert.match(r.message, /NOTHING can pass/);
});

test('flags a gate pinned just under the ceiling', () => {
  // The shipped v1.40.0 state: ceiling 0.4333, gate 0.40 -> 7.7% headroom is
  // above the 5% floor, so squeeze it slightly to land in `starved`.
  const r = assessGateReachability({ scores: spread(0.16, 0.4167, 200), threshold: 0.41 });
  assert.equal(r.verdict, 'starved');
  assert.ok(r.headroom < 0.05);
});

test('accepts a gate with real headroom', () => {
  const r = assessGateReachability({ scores: spread(0.16, 0.4333, 200), threshold: 0.34 });
  assert.equal(r.verdict, 'ok');
  assert.ok(r.passRate > 0);
});

test('refuses to judge on a thin sample rather than guessing', () => {
  const r = assessGateReachability({ scores: [0.4, 0.42], threshold: 0.99 });
  assert.equal(r.verdict, 'insufficient-data');
});

test('ignores zero scores, which mean no hits rather than a low score', () => {
  const r = assessGateReachability({
    scores: [...new Array(100).fill(0), ...spread(0.3, 0.43, 60)],
    threshold: 0.34,
  });
  assert.equal(r.sample, 60);
});

test('the shipped gate is reachable under the shipped fusion weights', () => {
  // Ceiling derived from ll-core: (VEC 1.0 + BM25 1.0 + PPR 0.05 + TAG 0.05 +
  // PRF 0.5) / (RRF_K 5 + 1). If the Rust weights move, this number moves and
  // the assertion below is what notices.
  const ceiling = (1.0 + 1.0 + 0.05 + 0.05 + 0.5) / 6;
  assert.ok(
    HookConfig.INJECTION_THRESHOLD < ceiling,
    `INJECTION_THRESHOLD ${HookConfig.INJECTION_THRESHOLD} must sit below the achievable ceiling ${ceiling.toFixed(4)}`,
  );
  // And above the two-bare-#1-lanes floor, which is the documented intent.
  const twoLaneFloor = (1.0 + 1.0) / 6;
  assert.ok(
    HookConfig.INJECTION_THRESHOLD > twoLaneFloor,
    `INJECTION_THRESHOLD ${HookConfig.INJECTION_THRESHOLD} must demand more than two lone top hits (${twoLaneFloor.toFixed(4)})`,
  );
});
