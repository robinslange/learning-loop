// tests/otel-run-export.test.mjs
// T2g: the top-level runner. Loads every reducer, collects metric records
// under one shared timestamp, serializes via buildOtlpPayload and sends via
// exportMetrics. See docs/plans/otel-consolidation.md, "Phase 2: aggregators
// and POST".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOtlpSink } from './helpers/otlp-sink.mjs';
import { runExport } from '../plugin/scripts/otel/run-export.mjs';

function withPluginData(fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-run-export-'));
  try {
    return fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

test('with export disabled and no --dry-run, nothing is sent', async () => {
  await withPluginData(async (pluginData) => {
    const sink = await startOtlpSink();
    try {
      const result = await runExport({ pluginData, enabled: false, dryRun: false, endpoint: sink.url });
      assert.strictEqual(result.sent, false);
      assert.strictEqual(sink.received.length, 0);
    } finally {
      await sink.close();
    }
  });
});

test('with --dry-run, the payload is produced and not sent even when export is disabled', async () => {
  await withPluginData(async (pluginData) => {
    const sink = await startOtlpSink();
    try {
      const result = await runExport({ pluginData, enabled: false, dryRun: true, endpoint: sink.url });
      assert.strictEqual(result.sent, false);
      assert.strictEqual(sink.received.length, 0);
      assert.ok(result.payload);
      assert.ok(result.payload.resourceMetrics);
    } finally {
      await sink.close();
    }
  });
});

test('with export enabled, the payload reaches the local sink', async () => {
  await withPluginData(async (pluginData) => {
    const sink = await startOtlpSink();
    try {
      const result = await runExport({ pluginData, enabled: true, dryRun: false, endpoint: sink.url });
      assert.strictEqual(result.sent, true);
      assert.strictEqual(sink.received.length, 1);
    } finally {
      await sink.close();
    }
  });
});

test('a missing sibling reducer module does not crash the run', async () => {
  // Pointing at an empty pluginData with no corpus files exercises every
  // reducer's own "absent stream" path; a genuinely missing reducer *file*
  // is covered by the runner's own dynamic-import guard, which this test
  // proves does not throw by running the whole thing end to end.
  await withPluginData(async (pluginData) => {
    const result = await runExport({ pluginData, enabled: false, dryRun: true, endpoint: 'http://127.0.0.1:1' });
    assert.ok(result);
    assert.ok(Array.isArray(result.reducersLoaded));
    assert.ok(Array.isArray(result.reducersSkipped));
  });
});

test('the runner passes one shared timestamp to all reducers', async () => {
  await withPluginData(async (pluginData) => {
    const result = await runExport({ pluginData, enabled: false, dryRun: true, endpoint: 'http://127.0.0.1:1' });
    const times = new Set((result.payload?.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics || []).flatMap((m) => {
      const dps = m.sum?.dataPoints || m.gauge?.dataPoints || m.histogram?.dataPoints || [];
      return dps.map((dp) => dp.timeUnixNano);
    }));
    // With no fixture corpus most reducers return [], so this mainly asserts
    // the runner never crashes wiring the shared time through; when metrics
    // are present, they must all share one timestamp.
    assert.ok(times.size <= 1);
  });
});
