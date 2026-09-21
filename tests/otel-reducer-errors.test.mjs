// tests/otel-reducer-errors.test.mjs
// T2e: the hook-errors + logs reducer. Reads the whole hook-errors corpus and
// the whole log.mjs sink corpus, recomputes counts and histograms from
// scratch, returns metric records in otlp.mjs's input shape, one set stamped
// stream: 'hook-errors', the other stream: 'logs'. See
// docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST" and the
// "Coverage" section's T1i subsection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceErrors } from '../plugin/scripts/otel/reducers/errors.mjs';
import { validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

function withCorpus({ hookErrors, logs }, fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-errors-'));
  try {
    if (hookErrors) {
      writeFileSync(join(pluginData, 'hook-errors-2026-05.jsonl'), hookErrors.map((e) => JSON.stringify(e)).join('\n'));
    }
    if (logs) {
      const dir = join(pluginData, 'logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'log-2026-05.jsonl'), logs.map((e) => JSON.stringify(e)).join('\n'));
    }
    return fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

function named(metrics, name) {
  return metrics.filter((m) => m.name === `ll.${name}`);
}

const hookErrorFixture = [
  { ts: '2026-05-01T00:00:00Z', module: 'pre-write-check', code: 'DAEMON_TIMEOUT', source: 'daemon-socket', message: 'timed out', latency_ms: 430, budget_ms: 500, elapsed_ms: 431 },
  { ts: '2026-05-01T00:00:01Z', module: 'pre-write-check', code: 'DAEMON_TIMEOUT', source: 'subprocess-fallback', message: 'timed out', latency_ms: 900, budget_ms: 500, elapsed_ms: 901 },
  { ts: '2026-05-01T00:00:02Z', module: 'post-tool', code: 'PROVENANCE_FAIL', source: 'daemon-socket', message: 'boom', latency_ms: 20, budget_ms: 60, elapsed_ms: 22 },
];

const logsFixture = [
  { ts: '2026-05-01T00:00:00Z', level: 'error', plugin: 'learning-loop', scope: 'watch.stop.unlinkPid', msg: 'failed to unlink', meta: { err: { message: 'ENOENT', stack: 'at x' } } },
  { ts: '2026-05-01T00:00:01Z', level: 'error', plugin: 'learning-loop', scope: 'watch.stop.unlinkPid', msg: 'failed to unlink', meta: {} },
  { ts: '2026-05-01T00:00:02Z', level: 'error', plugin: 'learning-loop', scope: 'provenance.invalidAction', msg: 'unknown action', meta: {} },
];

test('counts hook-errors by module and code', () => {
  withCorpus({ hookErrors: hookErrorFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    const byModule = named(metrics, 'hook_error_module');
    const byCode = named(metrics, 'hook_error_code');

    const preWrite = byModule.find((m) => m.attributes.module === 'pre-write-check');
    const postTool = byModule.find((m) => m.attributes.module === 'post-tool');
    assert.strictEqual(preWrite.value, 2);
    assert.strictEqual(postTool.value, 1);

    const daemonTimeout = byCode.find((m) => m.attributes.code === 'DAEMON_TIMEOUT');
    const provenanceFail = byCode.find((m) => m.attributes.code === 'PROVENANCE_FAIL');
    assert.strictEqual(daemonTimeout.value, 2);
    assert.strictEqual(provenanceFail.value, 1);
  });
});

test('counts logs by scope', () => {
  withCorpus({ logs: logsFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    const byScope = named(metrics, 'log_error_scope');

    const unlinkPid = byScope.find((m) => m.attributes.scope === 'watch.stop.unlinkPid');
    const invalidAction = byScope.find((m) => m.attributes.scope === 'provenance.invalidAction');
    assert.strictEqual(unlinkPid.value, 2);
    assert.strictEqual(invalidAction.value, 1);
  });
});

test('counts logs by level', () => {
  withCorpus({ logs: logsFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    const byLevel = named(metrics, 'log_level');
    const error = byLevel.find((m) => m.attributes.level === 'error');
    assert.strictEqual(error.value, 3);
  });
});

test('latency_ms histogram satisfies bucket invariants', () => {
  withCorpus({ hookErrors: hookErrorFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    const [hist] = named(metrics, 'hook_error_latency_ms');
    assert.ok(hist, 'expected a latency_ms histogram');
    assert.strictEqual(hist.bucketCounts.length, hist.explicitBounds.length + 1);
    assert.strictEqual(hist.count, hist.bucketCounts.reduce((a, b) => a + b, 0));
  });
});

test('elapsed_ms histogram satisfies bucket invariants', () => {
  withCorpus({ hookErrors: hookErrorFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    const [hist] = named(metrics, 'hook_error_elapsed_ms');
    assert.ok(hist, 'expected an elapsed_ms histogram');
    assert.strictEqual(hist.bucketCounts.length, hist.explicitBounds.length + 1);
    assert.strictEqual(hist.count, hist.bucketCounts.reduce((a, b) => a + b, 0));
  });
});

test('message, msg and meta never leak into attributes', () => {
  withCorpus({ hookErrors: hookErrorFixture, logs: logsFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    for (const m of metrics) {
      const attrs = m.attributes || {};
      assert.ok(!('message' in attrs));
      assert.ok(!('msg' in attrs));
      assert.ok(!('meta' in attrs));
      assert.ok(!('stack' in attrs));
      assert.ok(!('plugin' in attrs));
    }

    const byModule = named(metrics, 'hook_error_module');
    assert.deepStrictEqual(Object.keys(byModule[0].attributes).sort(), ['module']);

    const byScope = named(metrics, 'log_error_scope');
    assert.deepStrictEqual(Object.keys(byScope[0].attributes).sort(), ['scope']);
  });
});

test('running the reducer twice returns identical output', () => {
  withCorpus({ hookErrors: hookErrorFixture, logs: logsFixture }, (pluginData) => {
    const timeUnixMs = 1234567890;
    const first = reduceErrors({ pluginData, timeUnixMs });
    const second = reduceErrors({ pluginData, timeUnixMs });
    assert.deepStrictEqual(first, second);
  });
});

test('absent hook-errors files and absent logs dir both return [] without throwing', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-errors-missing-'));
  try {
    assert.doesNotThrow(() => {
      const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
      assert.deepStrictEqual(metrics, []);
    });
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('every returned record passes phase 0 attribute validation for its stream', () => {
  withCorpus({ hookErrors: hookErrorFixture, logs: logsFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.ok(m.stream === 'hook-errors' || m.stream === 'logs');
      assert.doesNotThrow(() => validateExportRecord(m.stream, m.attributes || {}));
    }
  });
});

test('the output serializes through buildOtlpPayload without throwing', () => {
  withCorpus({ hookErrors: hookErrorFixture, logs: logsFixture }, (pluginData) => {
    const metrics = reduceErrors({ pluginData, timeUnixMs: Date.now() });
    assert.doesNotThrow(() => buildOtlpPayload(metrics));
  });
});
