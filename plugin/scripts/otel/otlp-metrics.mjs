// scripts/otel/otlp-metrics.mjs : per-metric-type OTLP dataPoint builders.
//
// Split out of otlp.mjs to keep that file under ARCHITECTURE.md invariant 7's
// 150 LOC script-entry cap. See otlp.mjs for the input shape and the wire
// format background; this file is pure serialization, no validation.

// int64 fields (timeUnixNano, startTimeUnixNano, intValue) exceed
// Number.MAX_SAFE_INTEGER once nanosecond-scale, and the OTLP/JSON spec
// represents int64 as a JSON string for exactly that reason. Passing a JS
// number here is not merely non-idiomatic, it silently loses precision.
export function msToNanoString(ms) {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function attributeValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}

export function buildAttributes(attributes) {
  return Object.entries(attributes || {}).map(([key, value]) => ({
    key,
    value: attributeValue(value),
  }));
}

// AGGREGATION_TEMPORALITY_CUMULATIVE. The other OTLP value, DELTA (1), would
// require the aggregator to track what it already sent since the last export;
// decision in the plan is whole-corpus re-derive, so every export is a fresh
// cumulative total from the corpus's own start time. Never send DELTA here.
export const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

export function buildSumMetric(m) {
  return {
    name: m.name,
    unit: m.unit || '1',
    sum: {
      dataPoints: [
        {
          startTimeUnixNano: msToNanoString(m.startTimeUnixMs ?? m.timeUnixMs),
          timeUnixNano: msToNanoString(m.timeUnixMs),
          asDouble: m.value,
          attributes: buildAttributes(m.attributes),
        },
      ],
      aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
      isMonotonic: true,
    },
  };
}

export function buildGaugeMetric(m) {
  return {
    name: m.name,
    unit: m.unit || '1',
    gauge: {
      dataPoints: [
        {
          timeUnixNano: msToNanoString(m.timeUnixMs),
          asDouble: m.value,
          attributes: buildAttributes(m.attributes),
        },
      ],
    },
  };
}

// bucketCounts[i] holds points where explicitBounds[i-1] < value <=
// explicitBounds[i], with one extra bucket at each end (below the first
// bound, above the last), hence the off-by-one: N bounds need N+1 buckets.
// A receiver that gets fewer or more buckets than bounds+1 does not error;
// it drops the point. Same for a count that disagrees with the bucket sum:
// both are asserted here so the failure is a thrown error, not a metric that
// silently never shows up on a dashboard.
export function buildHistogramMetric(m) {
  const { bucketCounts, explicitBounds, count, sum } = m;
  if (bucketCounts.length !== explicitBounds.length + 1) {
    throw new Error(
      `otel serialize: histogram "${m.name}" has bucketCounts.length (${bucketCounts.length}) !== explicitBounds.length + 1 (${explicitBounds.length + 1})`,
    );
  }
  const bucketSum = bucketCounts.reduce((a, b) => a + b, 0);
  if (bucketSum !== count) {
    throw new Error(
      `otel serialize: histogram "${m.name}" has count (${count}) !== sum of bucketCounts (${bucketSum})`,
    );
  }
  return {
    name: m.name,
    unit: m.unit || '1',
    histogram: {
      dataPoints: [
        {
          startTimeUnixNano: msToNanoString(m.startTimeUnixMs ?? m.timeUnixMs),
          timeUnixNano: msToNanoString(m.timeUnixMs),
          count: String(count),
          sum,
          bucketCounts: bucketCounts.map(String),
          explicitBounds,
          attributes: buildAttributes(m.attributes),
        },
      ],
      aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
    },
  };
}
