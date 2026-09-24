// hooks/session-start/otel-export.mjs : marker-gated trigger for the otel
// export worker (T2h). See docs/plans/otel-consolidation.md, "The trigger".
//
// Budget: a marker statSync plus a spawn. The reducers themselves must never
// run inline in session-start's 10s hook budget; runExport lives entirely
// inside the detached worker.

import { join } from 'node:path';
import { MARKER_PATHS, readMarker } from '../../scripts/lib/marker-cache.mjs';
import { isExportEnabled } from '../../scripts/otel/export.mjs';
import { spawnDetached } from '../lib/common.mjs';

// One hour, passed explicitly at the call site per the plan. Never reuse or
// mutate MARKER_TTL_MS: intentions, dreamGate and lastDream all default
// through that shared 25h constant and changing it would silently alter
// their cadence too.
// Exported so /doctor's staleness check thresholds against the SAME interval
// the trigger uses. Two copies of this number would drift, and a check that
// disagrees with the trigger is worse than no check.
export const OTEL_EXPORT_TTL_MS = 60 * 60 * 1000;

export function maybeSpawnOtelExport(ctx) {
  if (!ctx.pluginData) return;
  // A user who never configures an endpoint pays nothing: no marker stat,
  // no spawn.
  if (!isExportEnabled()) return;

  const markerPath = MARKER_PATHS.otelExport(ctx.pluginData);
  if (readMarker(markerPath, { ttlMs: OTEL_EXPORT_TTL_MS }) !== null) return;

  spawnDetached('session-start.otel-export.spawn', process.execPath, [
    join(import.meta.dirname, 'otel-export-worker.mjs'),
    ctx.pluginData,
    markerPath,
  ]);
}
