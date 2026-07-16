import { test } from 'node:test';
import assert from 'node:assert';
import { scoreProbe, aggregate } from '../plugin/scripts/dream-eval/score.mjs';

test('scoreProbe finds rank of first expected file within K', () => {
  const p = { probe_id: '1', tier: 'forward', expected_files: ['x.md'] };
  const r = scoreProbe(p, ['a.md', 'x.md', 'b.md'], 3);
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.rank, 2);
});

test('scoreProbe misses when expected file is beyond K', () => {
  const p = { probe_id: '2', tier: 'forward', expected_files: ['x.md'] };
  const r = scoreProbe(p, ['a.md', 'b.md', 'c.md', 'x.md'], 3);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.rank, null);
});

test('aggregate computes MRR and per-tier hit rate', () => {
  const results = [
    { tier: 'forward', hit: true, rank: 1 },
    { tier: 'forward', hit: false, rank: null },
    { tier: 'reverse', hit: true, rank: 2 },
  ];
  const agg = aggregate(results);
  assert.strictEqual(agg.hit_rate, 2 / 3);
  assert.ok(Math.abs(agg.mrr - (1 + 0 + 0.5) / 3) < 1e-9);
  assert.strictEqual(agg.by_tier.forward.hit_rate, 0.5);
  assert.strictEqual(agg.by_tier.reverse.hit_rate, 1);
});
