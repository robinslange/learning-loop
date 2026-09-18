// The retrieval-quality gate, exercised against fixtures that make it fail.
//
// Both behaviours here were verified by hand when they were written and by
// nothing since: a gate that has only ever run against passing code proves the
// code passed, not that the gate works.
//
// Scope: compareBaselines() returns the verdict; bench.mjs main() turns a
// non-empty qualityRegressions into exit 1. That last step is not covered,
// because reaching it requires generating a 500-note fixture vault and indexing
// it with real ONNX embeddings. What these tests pin is which guard fires and
// on what numbers, since every guard writes into the same array and a test that
// only counted entries could not tell a refusal from a measured drop.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareBaselines } from '../bench/bench.mjs';

const GATED = '+prf [title]';
const GATED_PPR = 'vec+bm25+ppr [title]';

// Figures from the blessed linux/x64 baseline, so a drop below is the shape of
// a real one rather than an invented scale.
const HEALTHY = { recall_at_10: 0.0667, ndcg_at_10: 0.0428, hits_at_1: 0.045 };

function funnel(title, long = HEALTHY, ppr = HEALTHY) {
  return {
    [GATED]: title,
    '+prf [long]': long,
    [GATED_PPR]: ppr,
    'vec+bm25+ppr [long]': ppr,
  };
}

function run(platform, stages) {
  return {
    quality: {
      numQueries: 200,
      provenance: { platform, modelRevision: 'e'.repeat(40), generatorVersion: 2 },
      funnel: stages,
    },
  };
}

describe('retrieval quality gate', () => {
  it('refuses a cross-platform comparison instead of measuring one', () => {
    // Every gated metric collapsed by ~98%: six hard failures if anything were
    // compared at all. Exactly one provenance entry is the proof that the
    // refusal returns before the funnel is read.
    const collapsed = { recall_at_10: 0.001, ndcg_at_10: 0.001, hits_at_1: 0.001 };

    const report = compareBaselines(
      run('linux/x64', funnel(collapsed, collapsed)),
      run('darwin/arm64', funnel(HEALTHY, HEALTHY)),
    );

    assert.equal(report.qualityRegressions.length, 1);
    const [entry] = report.qualityRegressions;
    assert.equal(entry.name, 'quality/provenance');
    assert.match(entry.error, /baseline platform \(darwin\/arm64\)/);
    assert.match(entry.error, /current \(linux\/x64\)/);
    assert.match(entry.error, /refusing to compare/);
    assert.equal(report.improvements.length, 0);
    assert.equal(report.regressions.length, 0);
  });

  it('fails on a >25% relative drop, naming the metric that dropped', () => {
    // hits@1 0.045 -> 0.015: the PRF-weighting drop that shipped, and exactly
    // the 0.03 absolute fall the old `> 0.03` test would not have fired on.
    const report = compareBaselines(
      run('linux/x64', funnel({ ...HEALTHY, hits_at_1: 0.015 })),
      run('linux/x64', funnel({ ...HEALTHY, hits_at_1: 0.045 })),
    );

    assert.equal(report.qualityRegressions.length, 1);
    const [entry] = report.qualityRegressions;
    assert.equal(entry.name, `quality/${GATED}/hits_at_1`);
    assert.equal(entry.error, undefined, 'a measured drop, not a structural refusal');
    assert.equal(entry.prev, 0.045);
    assert.equal(entry.curr, 0.015);
    assert.equal(entry.absoluteDrop, 0.03);
    assert.equal(entry.relativeDrop, 0.6667);
  });

  it('holds at exactly 25% and fires past it', () => {
    // Powers of two: the test is `relDrop > 0.25`, and decimal fixtures land
    // either side of that boundary on float noise alone.
    const atThreshold = compareBaselines(
      run('linux/x64', funnel({ ...HEALTHY, hits_at_1: 0.375 })),
      run('linux/x64', funnel({ ...HEALTHY, hits_at_1: 0.5 })),
    );
    assert.deepEqual(atThreshold.qualityRegressions, []);

    const pastThreshold = compareBaselines(
      run('linux/x64', funnel({ ...HEALTHY, hits_at_1: 0.25 })),
      run('linux/x64', funnel({ ...HEALTHY, hits_at_1: 0.5 })),
    );
    assert.equal(pastThreshold.qualityRegressions.length, 1);
    assert.equal(pastThreshold.qualityRegressions[0].relativeDrop, 0.5);
  });

  it('fires on a graph-lane drop even when the downstream +prf stages hold', () => {
    // The gate previously watched only +prf, two stages downstream of PPR, so
    // a graph-lane regression that PRF happened to wash out passed silently.
    const report = compareBaselines(
      run('linux/x64', funnel(HEALTHY, HEALTHY, { ...HEALTHY, ndcg_at_10: 0.02 })),
      run('linux/x64', funnel(HEALTHY, HEALTHY, HEALTHY)),
    );

    const pprHits = report.qualityRegressions.filter((r) => r.name.includes('ppr'));
    assert.equal(pprHits.length, 2, JSON.stringify(report.qualityRegressions));
    assert.ok(pprHits.every((r) => r.name.endsWith('/ndcg_at_10')));
    assert.equal(
      report.qualityRegressions.length,
      2,
      'healthy +prf stages must not fire alongside',
    );
  });
});
