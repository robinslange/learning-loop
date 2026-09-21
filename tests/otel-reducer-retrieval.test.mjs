// tests/otel-reducer-retrieval.test.mjs
// T2d: the retrieval reducer. Reads the four retrieval streams (queries,
// reads, injections, shadow-injection), recomputes counts and histograms from
// scratch, returns metric records in otlp.mjs's input shape. See
// docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST", signal
// mapping: "retrieval streams to counters plus result_count histograms,
// labelled by command, via, level, federated."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceRetrieval } from '../plugin/scripts/otel/reducers/retrieval.mjs';
import { validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

function withCorpus(files, fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-retrieval-'));
  try {
    const dir = join(pluginData, 'retrieval');
    mkdirSync(dir, { recursive: true });
    for (const [name, records] of Object.entries(files)) {
      writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join('\n'));
    }
    return fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

function metricsNamed(metrics, name) {
  return metrics.filter((m) => m.name === `ll.${name}`);
}

test('counts by command across a multi-stream, multi-month fixture', () => {
  const files = {
    'queries-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:00Z',
        session_id: 's1',
        command: 'search',
        query: 'x',
        result_count: 3,
      },
    ],
    'queries-2026-06.jsonl': [
      {
        ts: '2026-06-01T00:00:00Z',
        session_id: 's1',
        command: 'search',
        query: 'y',
        result_count: 5,
      },
    ],
    'reads-2026-05.jsonl': [
      {
        ts: '2026-05-02T00:00:00Z',
        session_id: 's1',
        command: 'read',
        query: 'z',
        result_count: 1,
        type: 'note',
      },
    ],
    'shadow-injection-2026-05.jsonl': [
      {
        ts: '2026-05-03T00:00:00Z',
        session_id: 's1',
        command: 'shadow',
        result_count: 2,
        latency_ms: 120,
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    const byCommand = metricsNamed(metrics, 'retrieval_command');
    const search = byCommand.find((m) => m.attributes.command === 'search');
    const read = byCommand.find((m) => m.attributes.command === 'read');
    const shadow = byCommand.find((m) => m.attributes.command === 'shadow');
    assert.strictEqual(search.value, 2);
    assert.strictEqual(read.value, 1);
    assert.strictEqual(shadow.value, 1);
  });
});

test('the latency_ms histogram satisfies both invariants', () => {
  const files = {
    'shadow-injection-2026-05.jsonl': [
      { ts: '2026-05-01T00:00:00Z', session_id: 's1', command: 'shadow', latency_ms: 12 },
      { ts: '2026-05-01T00:00:01Z', session_id: 's1', command: 'shadow', latency_ms: 340 },
      { ts: '2026-05-01T00:00:02Z', session_id: 's1', command: 'shadow', latency_ms: 6000 },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    const [hist] = metricsNamed(metrics, 'retrieval_latency_ms');
    assert.ok(hist, 'expected a latency_ms histogram');
    assert.strictEqual(hist.bucketCounts.length, hist.explicitBounds.length + 1);
    assert.strictEqual(
      hist.count,
      hist.bucketCounts.reduce((a, b) => a + b, 0),
    );
  });
});

test('running the reducer twice returns identical output', () => {
  const files = {
    'queries-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:00Z',
        session_id: 's1',
        command: 'search',
        query: 'x',
        result_count: 3,
        federated: true,
      },
    ],
    'injections-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:01Z',
        session_id: 's1',
        path: '/vault/note.md',
        via: 'auto',
        level: 'permanent',
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const timeUnixMs = 1234567890;
    const first = reduceRetrieval({ pluginData, timeUnixMs });
    const second = reduceRetrieval({ pluginData, timeUnixMs });
    assert.deepStrictEqual(first, second);
  });
});

test('an absent retrieval directory returns [] without throwing', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-retrieval-missing-'));
  try {
    assert.doesNotThrow(() => {
      const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
      assert.deepStrictEqual(metrics, []);
    });
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('cache-health files in the same directory are not read', () => {
  const files = {
    'cache-health-2026-05.jsonl': [
      { ts: '2026-05-01T00:00:00Z', session_id: 's1', turn: 1, cache_read: 999, model: 'claude' },
    ],
    'queries-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:01Z',
        session_id: 's1',
        command: 'search',
        query: 'x',
        result_count: 1,
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    for (const m of metrics) {
      assert.ok(
        !('cache_read' in (m.attributes || {})),
        'cache-health fields must not leak into retrieval metrics',
      );
      assert.ok(!('turn' in (m.attributes || {})));
      const values = Object.values(m.attributes || {});
      assert.ok(
        !values.includes('claude'),
        'cache-health model value must not appear as a retrieval label',
      );
    }
  });
});

test('records missing optional fields do not produce undefined labels or NaN', () => {
  const files = {
    'queries-2026-05.jsonl': [
      { ts: '2026-05-01T00:00:00Z', session_id: 's1', command: 'search', query: 'x' },
    ],
    'injections-2026-05.jsonl': [
      { ts: '2026-05-01T00:00:01Z', session_id: 's1', path: '/vault/note.md' },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    for (const m of metrics) {
      for (const [key, value] of Object.entries(m.attributes || {})) {
        assert.notStrictEqual(
          value,
          'undefined',
          `attribute ${key} must not stringify a missing field`,
        );
        assert.notStrictEqual(value, 'null', `attribute ${key} must not stringify a missing field`);
      }
      if (m.type === 'histogram') {
        assert.ok(Number.isFinite(m.sum), 'histogram sum must not be NaN');
      }
    }
  });
});

test('every returned record passes phase 0 attribute validation', () => {
  const files = {
    'queries-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:00Z',
        session_id: 's1',
        command: 'search',
        query: 'x',
        result_count: 3,
        federated: true,
      },
    ],
    'reads-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:01Z',
        session_id: 's1',
        command: 'read',
        query: 'y',
        result_count: 2,
        type: 'note',
      },
    ],
    'injections-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:02Z',
        session_id: 's1',
        path: '/vault/note.md',
        via: 'auto',
        level: 'permanent',
      },
    ],
    'shadow-injection-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:03Z',
        session_id: 's1',
        command: 'shadow',
        result_count: 4,
        latency_ms: 88,
        prompt_length: 400,
        prompt: 'this is free text and must never be exported',
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.strictEqual(m.stream, 'retrieval');
      assert.doesNotThrow(() => validateExportRecord(m.stream, m.attributes || {}));
    }
  });
});

test('the output serializes through buildOtlpPayload without throwing', () => {
  const files = {
    'queries-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:00Z',
        session_id: 's1',
        command: 'search',
        query: 'x',
        result_count: 3,
      },
    ],
    'injections-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:01Z',
        session_id: 's1',
        path: '/vault/note.md',
        via: 'auto',
        level: 'permanent',
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    assert.doesNotThrow(() => buildOtlpPayload(metrics));
  });
});

test('counts queries by federated', () => {
  const files = {
    'queries-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:00Z',
        session_id: 's1',
        command: 'search',
        query: 'x',
        result_count: 1,
        federated: true,
      },
      {
        ts: '2026-05-01T00:00:01Z',
        session_id: 's1',
        command: 'search',
        query: 'y',
        result_count: 2,
        federated: false,
      },
      {
        ts: '2026-05-01T00:00:02Z',
        session_id: 's1',
        command: 'search',
        query: 'z',
        result_count: 3,
        federated: true,
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    const byFederated = metricsNamed(metrics, 'retrieval_federated');
    const yes = byFederated.find((m) => m.attributes.federated === 'true');
    const no = byFederated.find((m) => m.attributes.federated === 'false');
    assert.strictEqual(yes.value, 2);
    assert.strictEqual(no.value, 1);
  });
});

test('counts injections by via and level', () => {
  const files = {
    'injections-2026-05.jsonl': [
      {
        ts: '2026-05-01T00:00:00Z',
        session_id: 's1',
        path: '/a.md',
        via: 'auto',
        level: 'permanent',
      },
      {
        ts: '2026-05-01T00:00:01Z',
        session_id: 's1',
        path: '/b.md',
        via: 'manual',
        level: 'inbox',
      },
      {
        ts: '2026-05-01T00:00:02Z',
        session_id: 's1',
        path: '/c.md',
        via: 'auto',
        level: 'permanent',
      },
    ],
  };

  withCorpus(files, (pluginData) => {
    const metrics = reduceRetrieval({ pluginData, timeUnixMs: Date.now() });
    const byVia = metricsNamed(metrics, 'retrieval_injection_via');
    const byLevel = metricsNamed(metrics, 'retrieval_injection_level');
    const auto = byVia.find((m) => m.attributes.via === 'auto');
    const permanent = byLevel.find((m) => m.attributes.level === 'permanent');
    assert.strictEqual(auto.value, 2);
    assert.strictEqual(permanent.value, 2);
  });
});
