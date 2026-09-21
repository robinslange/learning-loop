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

import { logError } from '../lib/log.mjs';
import { validateExportRecord, RESOURCE_ATTRIBUTE_ALLOWLIST } from './schema.mjs';
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

// Keys already logged as dropped, so a long-lived process (the export
// worker) does not re-log the same operator misconfiguration every run.
const loggedDroppedKeys = new Set();

// A path, an escaped shell arg, or a sentence has no business in a resource
// attribute value: OTEL resource attributes are short enum-ish labels
// (versions, namespaces, environment names), and letting through anything
// containing '/', '\', whitespace, or over 64 chars is the same
// path-injection shape service.name's removal from the allowlist closes.
const BAD_VALUE = /[/\\\s]/;
const MAX_VALUE_LEN = 64;

function buildResource() {
  const envAttrs = parseResourceAttributesEnv();
  const allowed = {};
  for (const [key, value] of Object.entries(envAttrs)) {
    const ok =
      RESOURCE_ATTRIBUTE_ALLOWLIST.has(key) &&
      !BAD_VALUE.test(value) &&
      value.length <= MAX_VALUE_LEN;
    if (ok) {
      allowed[key] = value;
      continue;
    }
    if (!loggedDroppedKeys.has(key)) {
      loggedDroppedKeys.add(key);
      logError('otel.resourceAttributeDropped', new Error('resource attribute not allowlisted'), {
        key,
      });
    }
  }
  // service.name is spread LAST: no allowed env attribute (service.name
  // itself is not in the allowlist) can ever win over the constant.
  const attrs = { ...allowed, 'service.name': SERVICE_NAME };
  return { attributes: buildAttributes(attrs) };
}

function validateMetric(m) {
  // `stream` is REQUIRED. An earlier version returned early when it was
  // absent, which made the allowlist fail OPEN: a reducer that forgot the
  // field skipped the attribute check entirely, inverting the property this
  // schema exists for. All six reducers already set it; this guards the next.
  if (!m.stream) {
    throw new Error(
      `otel serialize: metric "${m.name}" has no stream, so its attributes cannot be checked`,
    );
  }
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
  // Two failure classes, handled differently on purpose. A SCHEMA violation
  // throws and voids the batch: that is a potential leak, and shipping the
  // rest while quietly dropping the offender would hide it. A WIRE-FORMAT
  // defect drops that point and logs it: an earlier version threw here too,
  // so one malformed record in one stream voided the export for all six,
  // when a receiver would have dropped just that point anyway.
  const built = [];
  for (const m of metrics) {
    // Both of these are PROGRAMMER errors, not data defects, so they stay
    // outside the try and void the batch: a reducer that stamps a disallowed
    // attribute or names a type that does not exist is a bug to fix, not a
    // point to skip. Only the data-shaped failures below get dropped.
    validateMetric(m);
    const builder = BUILDERS[m.type];
    if (!builder) {
      throw new Error(`otel serialize: unknown metric type "${m.type}" for "${m.name}"`);
    }
    try {
      built.push(builder(m));
    } catch (err) {
      logError('otel.serialize.droppedPoint', err, { name: m.name, stream: m.stream });
    }
  }

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
