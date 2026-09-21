#!/usr/bin/env node
// scripts/otel/export.mjs : the POST path. Serializes aggregated metrics via
// otlp.mjs and sends them to Alloy with raw fetch. See
// docs/plans/otel-consolidation.md, "Config and consent" and "Verifying
// before the Pi exists".
//
// Export is off unless BOTH OTEL_EXPORTER_OTLP_ENDPOINT is set AND
// config.json's otel.export_enabled is true. Two knobs, not one, mirrors the
// config.json shape librarian.enabled already uses. Per the plan: this is a
// cooperative signal on a LAN, single-operator deployment, not a technical
// control. A provisioning script can set config.json exactly as it can set
// an env var. Stated plainly rather than implied as a guarantee.
//
// A caller (the aggregator worker, later T2h) must never hang or throw on a
// dead LAN endpoint, so every path here returns a structured result.

import { buildOtlpPayload } from './otlp.mjs';
import { env } from '../lib/env.mjs';
import { getConfig } from '../lib/config.mjs';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * True when export is armed: an endpoint is configured and the operator has
 * opted in via config.json. Exported so callers (health-check, the future
 * aggregator worker) can report export status without re-deriving this.
 * @returns {boolean}
 */
export function isExportEnabled() {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) && getConfig().otel?.export_enabled === true;
}

/**
 * Serialize `metrics` and send them to the OTLP endpoint, or print them under
 * --dry-run. Never throws: every failure mode (disabled, unreachable,
 * non-2xx, a malformed metric) comes back as a structured result.
 *
 * @param {object[]} metrics  aggregated records in otlp.mjs's input shape
 * @param {object} [opts]
 * @param {string} [opts.endpoint]   overrides env.OTEL_EXPORTER_OTLP_ENDPOINT (test seam)
 * @param {boolean} [opts.enabled]   overrides the config.json opt-in (test seam)
 * @param {boolean} [opts.dryRun]    print the payload instead of POSTing
 * @param {number} [opts.timeoutMs] fetch timeout, default 5000
 * @returns {Promise<{ok: boolean, status?: number, sent: boolean, error?: string, payload?: object}>}
 */
export async function exportMetrics(metrics, opts = {}) {
  const endpoint = 'endpoint' in opts ? opts.endpoint : env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // Spec-standard per-signal override: used verbatim, no path appended.
  const metricsEndpoint =
    'metricsEndpoint' in opts ? opts.metricsEndpoint : env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const enabled = 'enabled' in opts ? opts.enabled : isExportEnabled();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!(endpoint || metricsEndpoint) || !enabled) {
    return { ok: true, sent: false };
  }

  let payload;
  try {
    payload = buildOtlpPayload(metrics);
  } catch (err) {
    return { ok: false, sent: false, error: err.message };
  }

  // An empty payload is not a successful export. Reaching here with nothing to
  // send means either no telemetry exists yet, or every point was dropped as
  // malformed (buildOtlpPayload skips those per-point so one bad record cannot
  // void a whole run). POSTing an empty resourceMetrics would return 200 and
  // let the caller stamp its "last successful export" marker, which would read
  // as healthy delivery of nothing. Report it as not-sent instead, so the
  // marker stays unstamped and /doctor keeps showing the export as overdue.
  const pointCount = payload.resourceMetrics[0].scopeMetrics[0].metrics.length;
  if (pointCount === 0) {
    return { ok: false, sent: false, error: 'no metrics to export', payload };
  }

  if (opts.dryRun) {
    // The human audit of the free-text rule (plan: "Verifying before the Pi
    // exists"): pretty-printed so a reviewer can actually read every field
    // that would leave the machine, not just confirm the call was made.
    console.log(JSON.stringify(payload, null, 2));
    return { ok: true, sent: false, payload };
  }

  // Per the OTLP spec, OTEL_EXPORTER_OTLP_ENDPOINT is a BASE url and the
  // signal path is appended, so an endpoint carrying a path prefix
  // (http://pi:4318/otlp) correctly becomes /otlp/v1/metrics. That is a common
  // shape behind a reverse proxy. For a receiver mounted somewhere the suffix
  // does not fit, the spec's per-signal override takes the full url as-is.
  const url = metricsEndpoint ? metricsEndpoint : `${endpoint.replace(/\/$/, '')}/v1/metrics`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Carry an error string, not just a status: the worker logs
      // result.error, and "export failed" with no detail was indistinguishable
      // from a network failure. A 404 here almost always means the receiver is
      // not mounted where the endpoint says, which is worth saying out loud.
      const hint =
        res.status === 404
          ? `; no OTLP receiver at ${url} (set OTEL_EXPORTER_OTLP_METRICS_ENDPOINT to the full path if your receiver is mounted elsewhere)`
          : '';
      return {
        ok: false,
        sent: true,
        status: res.status,
        error: `endpoint returned HTTP ${res.status}${hint}`,
        payload,
      };
    }
    return { ok: true, sent: true, status: res.status, payload };
  } catch (err) {
    return { ok: false, sent: false, error: err.message };
  }
}
