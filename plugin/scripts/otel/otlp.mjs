// scripts/otel/otlp.mjs : hand-rolled OTLP/HTTP+JSON metrics serializer.
//
// Turns aggregated records (one per metric per reducer run) into a valid
// resourceMetrics payload for Grafana Alloy's OTLP/HTTP receiver. See
// docs/plans/otel-consolidation.md, "T2a builds the OTLP serializer first":
// this is deliberately not "a fetch call". The wire-format quirks (nanosecond
// string timestamps, typed attribute wrappers, histogram bucket/bounds
// consistency) live in otlp-metrics.mjs, split out to keep this file under
// ARCHITECTURE.md invariant 7's 150 LOC script-entry cap.
//
// Input shape per metric (built by reducers in T2b..T2g, not this file):
//   {
//     name, type: 'counter' | 'gauge' | 'histogram', unit,
//     timeUnixMs, startTimeUnixMs? (counters only),
//     value? (counter/gauge), count?, sum?, bucketCounts?, explicitBounds? (histogram),
//     attributes: { key: string|number|boolean, ... },
//     stream?: one of schema.mjs's EXPORT_SCHEMA keys, to validate attributes
//              against phase 0's allowlist.
//   }

import { validateExportRecord } from './schema.mjs';
import {
  buildAttributes,
  buildSumMetric,
  buildGaugeMetric,
  buildHistogramMetric,
} from './otlp-metrics.mjs';

const SERVICE_NAME = 'learning-loop';
const SCOPE_NAME = 'learning-loop-otel';
const SCOPE_VERSION = '1.0.0';

const BUILDERS = {
  counter: buildSumMetric,
  gauge: buildGaugeMetric,
  histogram: buildHistogramMetric,
};

// OTEL_RESOURCE_ATTRIBUTES is the standard env var for operator-supplied
// resource attributes: comma-separated key=value pairs. Read directly (not
// via lib/env.mjs) because it is a generic OTEL convention, not a
// learning-loop-specific setting, and its value is wanted live rather than
// snapshotted at import time so tests can set it per-case.
function parseResourceAttributesEnv() {
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (!raw) return {};
  const out = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function buildResource() {
  const attrs = { 'service.name': SERVICE_NAME, ...parseResourceAttributesEnv() };
  return { attributes: buildAttributes(attrs) };
}

function validateMetric(m) {
  if (!m.stream) return;
  // Attributes go through the same phase 0 allowlist a raw JSONL record
  // would: a reducer that stamps a free-text attribute onto an otherwise
  // clean counter must fail exactly the same way.
  validateExportRecord(m.stream, m.attributes || {});
}

/**
 * Build a full OTLP/HTTP+JSON metrics payload from a list of aggregated
 * metric records. Throws on any wire-format inconsistency (bad histogram
 * shape, unknown metric type) or any attribute outside the phase 0 schema
 * for the record's declared stream: fail closed rather than ship a point
 * that a real receiver would silently drop.
 * @param {object[]} metrics
 * @returns {object} OTLP resourceMetrics payload
 */
export function buildOtlpPayload(metrics) {
  const built = metrics.map((m) => {
    validateMetric(m);
    const builder = BUILDERS[m.type];
    if (!builder)
      throw new Error(`otel serialize: unknown metric type "${m.type}" for "${m.name}"`);
    return builder(m);
  });

  return {
    resourceMetrics: [
      {
        resource: buildResource(),
        scopeMetrics: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            metrics: built,
          },
        ],
      },
    ],
  };
}
