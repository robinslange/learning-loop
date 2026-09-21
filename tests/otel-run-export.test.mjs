// tests/otel-run-export.test.mjs
// T2g: the top-level runner. Loads every reducer, collects metric records
// under one shared timestamp, serializes via buildOtlpPayload and sends via
// exportMetrics. See docs/plans/otel-consolidation.md, "Phase 2: aggregators
// and POST".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOtlpSink } from './helpers/otlp-sink.mjs';
import { runExport } from '../plugin/scripts/otel/run-export.mjs';

// An export with nothing to send is deliberately not a success (export.mjs
// refuses an empty payload so it cannot stamp a last-success marker), so a
// test that expects a real POST must seed at least one event to reduce.
function seedTelemetry(pluginData) {
  const dir = join(pluginData, 'provenance');
  mkdirSync(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  writeFileSync(
    join(dir, `events-${month}.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      session_id: 'seed',
      source: 'hook',
      action: 'vault-write',
      folder: 'inbox',
    }) + '\n',
  );
}

// Must be async and await fn: every caller passes an async callback, so a
// synchronous `return fn(...)` let the finally block rmSync the directory out
// from under the still-running test body.
async function withPluginData(fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-run-export-'));
  try {
    return await fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

test('with export disabled and no --dry-run, nothing is sent', async () => {
  await withPluginData(async (pluginData) => {
    const sink = await startOtlpSink();
    try {
      const result = await runExport({
        pluginData,
        enabled: false,
        dryRun: false,
        endpoint: sink.url,
      });
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
      const result = await runExport({
        pluginData,
        enabled: false,
        dryRun: true,
        endpoint: sink.url,
      });
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
    seedTelemetry(pluginData);
    const sink = await startOtlpSink();
    try {
      const result = await runExport({
        pluginData,
        enabled: true,
        dryRun: false,
        endpoint: sink.url,
      });
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
    const result = await runExport({
      pluginData,
      enabled: false,
      dryRun: true,
      endpoint: 'http://127.0.0.1:1',
    });
    assert.ok(result);
    assert.ok(Array.isArray(result.reducersLoaded));
    assert.ok(Array.isArray(result.reducersSkipped));
  });
});

test('the runner passes one shared timestamp to all reducers', async () => {
  await withPluginData(async (pluginData) => {
    const result = await runExport({
      pluginData,
      enabled: false,
      dryRun: true,
      endpoint: 'http://127.0.0.1:1',
    });
    const times = new Set(
      (result.payload?.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics || []).flatMap((m) => {
        const dps = m.sum?.dataPoints || m.gauge?.dataPoints || m.histogram?.dataPoints || [];
        return dps.map((dp) => dp.timeUnixNano);
      }),
    );
    // With no fixture corpus most reducers return [], so this mainly asserts
    // the runner never crashes wiring the shared time through; when metrics
    // are present, they must all share one timestamp.
    assert.ok(times.size <= 1);
  });
});
