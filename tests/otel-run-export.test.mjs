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
import { runExport, REDUCERS } from '../plugin/scripts/otel/run-export.mjs';

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

// A corpus with real signal in it: two collapsed session-summary records
// (provenance reducer counts these as provenance_actions too) plus one plain
// provenance action and one cache-health record, so both the provenance and
// session reducers have something to emit.
function seedCorpus(pluginData) {
  const provenanceDir = join(pluginData, 'provenance');
  const retrievalDir = join(pluginData, 'retrieval');
  mkdirSync(provenanceDir, { recursive: true });
  mkdirSync(retrievalDir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  const events = [
    {
      ts: new Date().toISOString(),
      session_id: 'seed',
      source: 'hook',
      action: 'vault-write',
      folder: 'inbox',
    },
    {
      ts: new Date().toISOString(),
      source: 'hook',
      action: 'session-summary',
      session_id: 's1',
      prompts: 3,
      tool_uses: 10,
      tool_uses_direct: 8,
      files_edited: 2,
      commits: 1,
      skills_invoked: 0,
      agents_spawned: 1,
      transcript_bytes: 40000,
      duration_ms: 120000,
      latency_ms: 90,
      git_ms: 30,
      git_state: 'dirty',
      commits_source: 'range',
      end_reason: 'open',
      project_source: 'derived',
      harness: 'claude-code',
      version: '2.1.0',
      final: false,
    },
    {
      ts: new Date().toISOString(),
      source: 'hook',
      action: 'session-summary',
      session_id: 's2',
      prompts: 5,
      tool_uses: 4,
      tool_uses_direct: 4,
      files_edited: 1,
      commits: 0,
      skills_invoked: 1,
      agents_spawned: 0,
      transcript_bytes: 12000,
      duration_ms: 60000,
      latency_ms: 50,
      git_ms: 10,
      git_state: 'clean',
      commits_source: 'since',
      end_reason: 'clear',
      project_source: 'derived',
      harness: 'claude-code',
      version: '2.1.0',
      final: true,
    },
  ];
  writeFileSync(
    join(provenanceDir, `events-${month}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  writeFileSync(
    join(retrievalDir, `cache-health-${month}.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      session_id: 'seed',
      cache_read_tokens: 100,
      cache_creation_tokens: 10,
      uncached_input_tokens: 5,
      output_tokens: 20,
      session_busts: 0,
    }) + '\n',
  );
}

test('every configured reducer loads, session included, and shares one timestamp', async () => {
  await withPluginData(async (pluginData) => {
    seedCorpus(pluginData);
    const result = await runExport({
      pluginData,
      enabled: false,
      dryRun: true,
      endpoint: 'http://127.0.0.1:1',
    });
    for (const name of REDUCERS) assert.ok(result.reducersLoaded.includes(name), name);
    assert.deepEqual(result.reducersSkipped, []);

    const metrics = result.payload.resourceMetrics[0].scopeMetrics[0].metrics;
    assert.ok(
      metrics.some((m) => m.name === 'll.session_count'),
      'session reducer produced no metrics',
    );
    const times = new Set(
      metrics.flatMap((m) => {
        const dps = m.sum?.dataPoints || m.gauge?.dataPoints || m.histogram?.dataPoints || [];
        return dps.map((dp) => dp.timeUnixNano);
      }),
    );
    assert.equal(times.size, 1, 'every metric must share one timeUnixMs');
  });
});

test('an unknown reducer name is skipped without blocking the rest of the run', async () => {
  await withPluginData(async (pluginData) => {
    seedCorpus(pluginData);
    const result = await runExport({
      pluginData,
      enabled: false,
      dryRun: true,
      endpoint: 'http://127.0.0.1:1',
      reducers: ['provenance', 'does-not-exist'],
    });
    assert.deepEqual(result.reducersLoaded, ['provenance']);
    assert.deepEqual(result.reducersSkipped, ['does-not-exist']);

    const metrics = result.payload.resourceMetrics[0].scopeMetrics[0].metrics;
    assert.ok(
      metrics.some((m) => m.name === 'll.provenance_actions'),
      'provenance reducer should still have exported',
    );
  });
});
