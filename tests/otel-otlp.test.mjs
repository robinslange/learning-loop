import { test } from 'node:test';
import assert from 'node:assert';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

// A minimal aggregated-metric shape the serializer accepts. Real reducers
// (T2b..T2g) build these; this task builds and proves the serializer alone.
function counterMetric(overrides = {}) {
  return {
    name: 'll_cache_read_total',
    type: 'counter',
    stream: 'cache-health',
    value: 42,
    unit: '1',
    startTimeUnixMs: 1_700_000_000_000,
    timeUnixMs: 1_700_000_060_000,
    attributes: { model: 'sonnet', session_id: 'abc-123' },
    ...overrides,
  };
}

function gaugeMetric(overrides = {}) {
  return {
    name: 'll_total_cost_usd',
    type: 'gauge',
    stream: 'cache-health',
    value: 1.23,
    unit: 'usd',
    timeUnixMs: 1_700_000_060_000,
    attributes: { session_id: 'abc-123' },
    ...overrides,
  };
}

function histogramMetric(overrides = {}) {
  return {
    name: 'll_turn_hit_rate',
    type: 'histogram',
    stream: 'cache-health',
    unit: '1',
    timeUnixMs: 1_700_000_060_000,
    count: 5,
    sum: 3.5,
    bucketCounts: [1, 2, 1, 1],
    explicitBounds: [0.25, 0.5, 0.75],
    attributes: { session_id: 'abc-123' },
    ...overrides,
  };
}

function firstDataPoint(payload, metricIndex = 0) {
  const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics[metricIndex];
  const kind = metric.sum ? 'sum' : metric.gauge ? 'gauge' : 'histogram';
  return { metric, kind, dataPoint: metric[kind].dataPoints[0] };
}

test('a counter serializes with cumulative temporality and isMonotonic true', () => {
  const payload = buildOtlpPayload([counterMetric()]);
  const { metric, kind } = firstDataPoint(payload);
  assert.strictEqual(kind, 'sum');
  assert.strictEqual(metric.sum.aggregationTemporality, 2);
  assert.strictEqual(metric.sum.isMonotonic, true);
});

test('a gauge has neither temporality nor isMonotonic', () => {
  const payload = buildOtlpPayload([gaugeMetric()]);
  const { metric, kind } = firstDataPoint(payload);
  assert.strictEqual(kind, 'gauge');
  assert.strictEqual(metric.gauge.aggregationTemporality, undefined);
  assert.strictEqual(metric.gauge.isMonotonic, undefined);
});

test('a histogram bucketCounts/explicitBounds are mutually consistent', () => {
  const payload = buildOtlpPayload([histogramMetric()]);
  const { dataPoint } = firstDataPoint(payload);
  assert.strictEqual(dataPoint.bucketCounts.length, dataPoint.explicitBounds.length + 1);
  const total = dataPoint.bucketCounts.reduce((a, b) => a + Number(b), 0);
  assert.strictEqual(total, Number(dataPoint.count));
});

// A receiver drops a malformed histogram silently, so the serializer must not
// pass one through. It drops that POINT and keeps the batch: an earlier version
// threw, so one bad record in one stream voided the export for all six. The
// surviving sibling is the assertion that matters.
test('a malformed histogram is dropped and the rest of the batch survives', () => {
  const payload = buildOtlpPayload([
    histogramMetric({ bucketCounts: [1, 2, 1], explicitBounds: [0.25, 0.5, 0.75] }),
    counterMetric({ name: 'healthy.sibling' }),
  ]);
  const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
  assert.deepStrictEqual(names, ['healthy.sibling']);
});

test('a histogram whose count disagrees with its buckets is dropped, batch survives', () => {
  const payload = buildOtlpPayload([
    histogramMetric({ count: 999 }),
    counterMetric({ name: 'healthy.sibling' }),
  ]);
  const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
  assert.deepStrictEqual(names, ['healthy.sibling']);
});

// A schema violation is the other class: a potential leak voids the whole
// batch rather than quietly dropping one point while the rest ships.
test('a schema violation voids the batch rather than dropping one point', () => {
  assert.throws(
    () =>
      buildOtlpPayload([
        counterMetric({ attributes: { transcript_path: '/Users/x/a.jsonl' } }),
        counterMetric({ name: 'healthy.sibling' }),
      ]),
    /is not in the export schema/,
  );
});

test('a metric with no stream is refused, so the allowlist cannot fail open', () => {
  assert.throws(
    () =>
      buildOtlpPayload([{ name: 'x', type: 'counter', value: 1, timeUnixMs: 1_700_000_000_000 }]),
    /has no stream/,
  );
});

test('timeUnixNano is a string of nanoseconds, not milliseconds', () => {
  const payload = buildOtlpPayload([counterMetric({ timeUnixMs: 1_700_000_060_000 })]);
  const { dataPoint } = firstDataPoint(payload);
  assert.strictEqual(typeof dataPoint.timeUnixNano, 'string');
  assert.strictEqual(dataPoint.timeUnixNano, '1700000060000000000');
});

test('startTimeUnixNano is also a nanosecond string, on a counter', () => {
  const payload = buildOtlpPayload([counterMetric({ startTimeUnixMs: 1_700_000_000_000 })]);
  const { dataPoint } = firstDataPoint(payload);
  assert.strictEqual(typeof dataPoint.startTimeUnixNano, 'string');
  assert.strictEqual(dataPoint.startTimeUnixNano, '1700000000000000000');
});

test('string attributes use the stringValue wrapper', () => {
  const payload = buildOtlpPayload([counterMetric({ attributes: { model: 'sonnet' } })]);
  const { dataPoint } = firstDataPoint(payload);
  assert.deepStrictEqual(
    dataPoint.attributes.find((a) => a.key === 'model'),
    { key: 'model', value: { stringValue: 'sonnet' } },
  );
});

test('integer attributes use the intValue wrapper, as a string', () => {
  const payload = buildOtlpPayload([counterMetric({ attributes: { turn: 3 } })]);
  const { dataPoint } = firstDataPoint(payload);
  assert.deepStrictEqual(
    dataPoint.attributes.find((a) => a.key === 'turn'),
    { key: 'turn', value: { intValue: '3' } },
  );
});

test('float attributes use the doubleValue wrapper', () => {
  const payload = buildOtlpPayload([counterMetric({ attributes: { turn_hit_rate: 0.42 } })]);
  const { dataPoint } = firstDataPoint(payload);
  assert.deepStrictEqual(
    dataPoint.attributes.find((a) => a.key === 'turn_hit_rate'),
    { key: 'turn_hit_rate', value: { doubleValue: 0.42 } },
  );
});

test('boolean attributes use the boolValue wrapper', () => {
  const payload = buildOtlpPayload([
    counterMetric({ stream: 'retrieval', attributes: { federated: true } }),
  ]);
  const { dataPoint } = firstDataPoint(payload);
  assert.deepStrictEqual(
    dataPoint.attributes.find((a) => a.key === 'federated'),
    { key: 'federated', value: { boolValue: true } },
  );
});

test('resource attributes carry service identity', () => {
  const payload = buildOtlpPayload([counterMetric()]);
  const resourceAttrs = payload.resourceMetrics[0].resource.attributes;
  const serviceName = resourceAttrs.find((a) => a.key === 'service.name');
  assert.strictEqual(serviceName.value.stringValue, 'learning-loop');
});

test('OTEL_RESOURCE_ATTRIBUTES env var is merged into resource attributes', async (t) => {
  const prev = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=lan,host.name=pi';
  t.after(() => {
    if (prev === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = prev;
  });
  const { buildOtlpPayload: build } = await import(
    `../plugin/scripts/otel/otlp.mjs?t=${Date.now()}`
  );
  const payload = build([counterMetric()]);
  const resourceAttrs = payload.resourceMetrics[0].resource.attributes;
  assert.strictEqual(
    resourceAttrs.find((a) => a.key === 'deployment.environment').value.stringValue,
    'lan',
  );
  assert.strictEqual(resourceAttrs.find((a) => a.key === 'host.name').value.stringValue, 'pi');
});

test('a record with a NEVER_EXPORT field throws rather than serializing', () => {
  assert.throws(() => {
    buildOtlpPayload([
      counterMetric({ stream: 'provenance', attributes: { transcript_path: '/Users/x/foo' } }),
    ]);
  }, /transcript_path/);
});

test('a record with a disallowed field for its declared stream throws', () => {
  assert.throws(() => {
    buildOtlpPayload([
      counterMetric({ stream: 'provenance', attributes: { session_id: 'abc', query: 'find me' } }),
    ]);
  }, /query/);
});

test('a record with only schema-allowed fields for its declared stream passes', () => {
  assert.doesNotThrow(() => {
    buildOtlpPayload([
      counterMetric({
        stream: 'provenance',
        attributes: { session_id: 'abc', action: 'vault-write' },
      }),
    ]);
  });
});
