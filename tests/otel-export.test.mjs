import { test } from 'node:test';
import assert from 'node:assert';
import { startOtlpSink } from './helpers/otlp-sink.mjs';
import { exportMetrics } from '../plugin/scripts/otel/export.mjs';

function counterMetric() {
  return {
    name: 'll_cache_read_total',
    type: 'counter',
    stream: 'cache-health',
    value: 1,
    timeUnixMs: Date.now(),
    attributes: {},
  };
}

test('export is a no-op when the endpoint is unset', async () => {
  const result = await exportMetrics([counterMetric()], { endpoint: undefined, enabled: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sent, false);
});

test('export is a no-op when the opt-in flag is absent, even with an endpoint set', async () => {
  const sink = await startOtlpSink();
  try {
    const result = await exportMetrics([counterMetric()], { endpoint: sink.url, enabled: false });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(sink.received.length, 0);
  } finally {
    await sink.close();
  }
});

test('a POST to the local sink round-trips the exact serialized payload', async () => {
  const sink = await startOtlpSink();
  try {
    const metrics = [counterMetric()];
    const result = await exportMetrics(metrics, { endpoint: sink.url, enabled: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sink.received.length, 1);
    assert.deepStrictEqual(sink.received[0], result.payload);
  } finally {
    await sink.close();
  }
});

test('--dry-run prints the payload and does not POST', async () => {
  const sink = await startOtlpSink();
  const originalLog = console.log;
  let printed = '';
  console.log = (msg) => {
    printed += msg;
  };
  try {
    const result = await exportMetrics([counterMetric()], {
      endpoint: sink.url,
      enabled: true,
      dryRun: true,
    });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(sink.received.length, 0);
    assert.ok(printed.includes('resourceMetrics'));
  } finally {
    console.log = originalLog;
    await sink.close();
  }
});

test('a non-2xx response yields {ok:false} without throwing', async () => {
  const sink = await startOtlpSink({ status: 500 });
  try {
    const result = await exportMetrics([counterMetric()], { endpoint: sink.url, enabled: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 500);
  } finally {
    await sink.close();
  }
});

test('an unreachable endpoint yields {ok:false} without hanging past the timeout', async () => {
  const start = Date.now();
  const result = await exportMetrics([counterMetric()], {
    endpoint: 'http://127.0.0.1:1',
    enabled: true,
    timeoutMs: 500,
  });
  const elapsed = Date.now() - start;
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  assert.ok(elapsed < 5000, `expected export to fail fast, took ${elapsed}ms`);
});

test('a malformed metric list produces {ok:false, error} instead of throwing into the caller', async () => {
  const sink = await startOtlpSink();
  try {
    const result = await exportMetrics([{ name: 'bad', type: 'nonsense' }], {
      endpoint: sink.url,
      enabled: true,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  } finally {
    await sink.close();
  }
});
