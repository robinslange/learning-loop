// tests/otel-reducer-dream-eval.test.mjs
// T2g: the dream-eval reducer. Reads PLUGIN_DATA/dream-eval/probes.jsonl (a
// single file, not monthly-sharded), recomputes counts by tier and a
// confidence histogram from scratch. See docs/plans/otel-consolidation.md,
// "Phase 2: aggregators and POST", signal mapping: "dream-eval to counts by
// tier. No question." This stream has no ts and no session_id, unlike the
// others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceDreamEval } from '../plugin/scripts/otel/reducers/dream-eval.mjs';
import { validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

function withProbes(probes, fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-dream-eval-'));
  try {
    const dir = join(pluginData, 'dream-eval');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'probes.jsonl'), probes.map((p) => JSON.stringify(p)).join('\n'));
    return fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

function countersNamed(metrics, name) {
  return metrics.filter((m) => m.name === `ll.${name}`);
}

test('counts probes by tier', () => {
  const probes = [
    { tier: 'quick', question: 'q1', expected_files: ['a.md'], source_session: 's1', confidence: 0.4, probe_id: 'p1' },
    { tier: 'quick', question: 'q2', expected_files: ['b.md'], source_session: 's1', confidence: 0.6, probe_id: 'p2' },
    { tier: 'deep', question: 'q3', expected_files: ['c.md'], source_session: 's2', confidence: 0.9, probe_id: 'p3' },
  ];

  withProbes(probes, (pluginData) => {
    const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
    const tierCounters = countersNamed(metrics, 'dream_eval_tier');
    const quick = tierCounters.find((m) => m.attributes.tier === 'quick');
    const deep = tierCounters.find((m) => m.attributes.tier === 'deep');
    assert.strictEqual(quick.value, 2);
    assert.strictEqual(deep.value, 1);
  });
});

test('confidence histogram satisfies both invariants', () => {
  const probes = [
    { tier: 'quick', question: 'q1', expected_files: [], source_session: 's1', confidence: 0.1, probe_id: 'p1' },
    { tier: 'quick', question: 'q2', expected_files: [], source_session: 's1', confidence: 0.5, probe_id: 'p2' },
    { tier: 'deep', question: 'q3', expected_files: [], source_session: 's2', confidence: 0.95, probe_id: 'p3' },
  ];

  withProbes(probes, (pluginData) => {
    const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
    const hist = metrics.find((m) => m.name === 'll.dream_eval_confidence');
    assert.ok(hist);
    assert.strictEqual(hist.type, 'histogram');
    assert.strictEqual(hist.bucketCounts.length, hist.explicitBounds.length + 1);
    assert.strictEqual(
      hist.bucketCounts.reduce((a, b) => a + b, 0),
      hist.count,
    );
    assert.strictEqual(hist.count, 3);
  });
});

test('an absent probes file returns [] without throwing', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-dream-eval-missing-'));
  try {
    assert.doesNotThrow(() => {
      const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
      assert.deepStrictEqual(metrics, []);
    });
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('question and expected_files never appear in attributes', () => {
  const probes = [
    {
      tier: 'quick',
      question: 'what does the reflect skill do',
      expected_files: ['skills/reflect/SKILL.md'],
      source_session: 's1',
      confidence: 0.5,
      probe_id: 'p1',
    },
  ];

  withProbes(probes, (pluginData) => {
    const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
    for (const m of metrics) {
      const attrs = m.attributes || {};
      assert.ok(!('question' in attrs));
      assert.ok(!('expected_files' in attrs));
      assert.strictEqual(JSON.stringify(m).includes('what does the reflect skill do'), false);
      assert.strictEqual(JSON.stringify(m).includes('skills/reflect/SKILL.md'), false);
    }
  });
});

test('does not group by probe_id (cardinality)', () => {
  const probes = [
    { tier: 'quick', question: 'q1', expected_files: [], source_session: 's1', confidence: 0.5, probe_id: 'p1' },
    { tier: 'quick', question: 'q2', expected_files: [], source_session: 's1', confidence: 0.6, probe_id: 'p2' },
  ];

  withProbes(probes, (pluginData) => {
    const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
    for (const m of metrics) {
      assert.ok(!('probe_id' in (m.attributes || {})));
    }
  });
});

test('running the reducer twice returns identical output', () => {
  const probes = [
    { tier: 'quick', question: 'q1', expected_files: [], source_session: 's1', confidence: 0.5, probe_id: 'p1' },
    { tier: 'deep', question: 'q2', expected_files: [], source_session: 's2', confidence: 0.9, probe_id: 'p2' },
  ];

  withProbes(probes, (pluginData) => {
    const timeUnixMs = 1234567890;
    const first = reduceDreamEval({ pluginData, timeUnixMs });
    const second = reduceDreamEval({ pluginData, timeUnixMs });
    assert.deepStrictEqual(first, second);
  });
});

test('every returned record passes phase 0 attribute validation and stream is dream-eval', () => {
  const probes = [{ tier: 'quick', question: 'q1', expected_files: [], source_session: 's1', confidence: 0.5, probe_id: 'p1' }];

  withProbes(probes, (pluginData) => {
    const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.strictEqual(m.stream, 'dream-eval');
      assert.doesNotThrow(() => validateExportRecord(m.stream, m.attributes || {}));
    }
  });
});

test('the output serializes through buildOtlpPayload without throwing', () => {
  const probes = [
    { tier: 'quick', question: 'q1', expected_files: [], source_session: 's1', confidence: 0.5, probe_id: 'p1' },
    { tier: 'deep', question: 'q2', expected_files: [], source_session: 's2', confidence: 0.9, probe_id: 'p2' },
  ];

  withProbes(probes, (pluginData) => {
    const metrics = reduceDreamEval({ pluginData, timeUnixMs: Date.now() });
    assert.doesNotThrow(() => buildOtlpPayload(metrics));
  });
});
