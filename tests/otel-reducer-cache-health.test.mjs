// tests/otel-reducer-cache-health.test.mjs
// See docs/plans/otel-consolidation.md, Phase 2 "Signal mapping": cache-health
// is the only genuinely metric-shaped stream today, so this reducer sums
// token counters, histograms the hit rates, counts session_busts and gauges
// total_cost_usd, all keyed by whole-corpus re-derive per reduce.mjs's contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceCacheHealth } from '../plugin/scripts/otel/reducers/cache-health.mjs';
import { validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

function record(overrides) {
  return {
    ts: '2026-09-18T05:02:06.578Z',
    session_id: 'sess-a',
    turn: 1,
    cache_read: 100,
    cache_creation: 10,
    uncached_input: 5,
    output_tokens: 0,
    total_input: 115,
    turn_hit_rate: 0.8696,
    window_hit_rate: 1,
    lifetime_hit_rate: 0.8696,
    session_busts: 0,
    ...overrides,
  };
}

function writeMonth(dir, name, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function makePluginData() {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-cachehealth-'));
  return { pluginData, retrievalDir: join(pluginData, 'retrieval') };
}

test('sums token counters across a multi-record, multi-month fixture', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-08.jsonl', [
      record({ ts: '2026-08-01T00:00:00.000Z', cache_read: 100, cache_creation: 10, uncached_input: 5, output_tokens: 1 }),
    ]);
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [
      record({ ts: '2026-09-01T00:00:00.000Z', cache_read: 200, cache_creation: 20, uncached_input: 15, output_tokens: 2 }),
    ]);

    const metrics = reduceCacheHealth({ pluginData, timeUnixMs: Date.now() });

    const cacheRead = metrics.find((m) => m.name === 'll.cache_health.cache_read' && m.type === 'counter');
    assert.equal(cacheRead.value, 300);
    const cacheCreation = metrics.find((m) => m.name === 'll.cache_health.cache_creation' && m.type === 'counter');
    assert.equal(cacheCreation.value, 30);
    const uncached = metrics.find((m) => m.name === 'll.cache_health.uncached_input' && m.type === 'counter');
    assert.equal(uncached.value, 20);
    const output = metrics.find((m) => m.name === 'll.cache_health.output_tokens' && m.type === 'counter');
    assert.equal(output.value, 3);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('hit-rate histograms satisfy the bucket invariants', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [
      record({ turn_hit_rate: 0.1, window_hit_rate: 0.5, lifetime_hit_rate: 0.9 }),
      record({ turn_hit_rate: 0.99, window_hit_rate: 0.2, lifetime_hit_rate: 0.3 }),
    ]);

    const metrics = reduceCacheHealth({ pluginData, timeUnixMs: Date.now() });
    for (const name of ['turn_hit_rate', 'window_hit_rate', 'lifetime_hit_rate']) {
      const hist = metrics.find((m) => m.name === `ll.cache_health.${name}` && m.type === 'histogram');
      assert.ok(hist, `expected a histogram for ${name}`);
      assert.equal(hist.bucketCounts.length, hist.explicitBounds.length + 1);
      assert.equal(hist.bucketCounts.reduce((a, b) => a + b, 0), hist.count);
    }
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('running the reducer twice returns identical output', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [record({}), record({ session_id: 'sess-b', cache_read: 50 })]);
    const timeUnixMs = Date.now();

    const first = reduceCacheHealth({ pluginData, timeUnixMs });
    const second = reduceCacheHealth({ pluginData, timeUnixMs });

    assert.deepStrictEqual(second, first);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('an absent retrieval directory returns an empty array without throwing', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-cachehealth-empty-'));
  try {
    assert.deepStrictEqual(reduceCacheHealth({ pluginData, timeUnixMs: Date.now() }), []);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('records missing model, version and total_cost_usd produce no undefined labels or NaN values', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [record({})]);

    const metrics = reduceCacheHealth({ pluginData, timeUnixMs: Date.now() });
    for (const m of metrics) {
      if (m.attributes) {
        for (const [k, v] of Object.entries(m.attributes)) {
          assert.notEqual(v, undefined, `attribute ${k} on ${m.name} is undefined`);
          assert.notEqual(v, 'undefined', `attribute ${k} on ${m.name} stringified to "undefined"`);
        }
      }
      if (typeof m.value === 'number') assert.ok(Number.isFinite(m.value), `${m.name} value is not finite`);
    }
    // No total_cost_usd on any record in this fixture: the gauge must not appear.
    assert.equal(metrics.find((m) => m.name === 'll.cache_health.total_cost_usd'), undefined);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('startTimeUnixMs on counters comes from the earliest record, not from now', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-08.jsonl', [record({ ts: '2026-08-05T12:00:00.000Z' })]);
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [record({ ts: '2026-09-18T05:02:06.578Z' })]);

    const metrics = reduceCacheHealth({ pluginData, timeUnixMs: Date.now() });
    const earliest = Date.parse('2026-08-05T12:00:00.000Z');
    const counters = metrics.filter((m) => m.type === 'counter');
    assert.ok(counters.length > 0);
    for (const c of counters) {
      assert.equal(c.startTimeUnixMs, earliest);
    }
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('every returned record validates against the cache-health export schema', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [
      record({ model: 'claude-x', version: '1.2.3', total_cost_usd: 0.4, used_percentage: 12 }),
      record({}),
    ]);

    const metrics = reduceCacheHealth({ pluginData, timeUnixMs: Date.now() });
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.equal(m.stream, 'cache-health');
      assert.doesNotThrow(() => validateExportRecord(m.stream, m.attributes || {}));
    }
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('output serializes through buildOtlpPayload without throwing', () => {
  const { pluginData, retrievalDir } = makePluginData();
  try {
    writeMonth(retrievalDir, 'cache-health-2026-09.jsonl', [
      record({ model: 'claude-x', version: '1.2.3', total_cost_usd: 0.4 }),
      record({ session_id: 'sess-b' }),
    ]);

    const metrics = reduceCacheHealth({ pluginData, timeUnixMs: Date.now() });
    assert.doesNotThrow(() => buildOtlpPayload(metrics));
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});
