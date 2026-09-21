#!/usr/bin/env node
// hooks/session-start/otel-export-worker.mjs : detached otel export worker.
// Runs every reducer via runExport() and, on success, stamps the otelExport
// marker so session-start does not respawn for another hour. See
// docs/plans/otel-consolidation.md, "The trigger".
//
// Spawned by hooks/session-start/otel-export.mjs; fire-and-forget, never raises.
//
// argv: <pluginData> <markerPath>
//
// Takes a file lock on the marker path so two sessions opening together
// cannot double-run the reducers (they would still be idempotent re-derives,
// but the lock avoids duplicate POSTs and wasted work, same reasoning as
// the plan's "Idempotency and the window" section).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLock, releaseLock } from '../../scripts/lib/file-lock.mjs';
import { readMarker, writeMarker } from '../../scripts/lib/marker-cache.mjs';
import { runExport } from '../../scripts/otel/run-export.mjs';
import { logError, info } from '../../scripts/lib/log.mjs';

// Two sessions opening within this window of each other are treated as "the
// same trigger": whichever worker acquires the lock second sees the first's
// fresh marker and skips its own run rather than sending a duplicate POST.
const RECENT_RUN_MS = 60_000;

const [pluginData, markerPath] = process.argv.slice(2);

if (!pluginData || !markerPath) process.exit(0);

// The lock file lives alongside the marker (`<markerPath>.lock`); O_EXCL
// cannot create it if the parent dir doesn't exist yet, so this has to
// happen before acquireLock, not just before writeMarker's own mkdir.
try {
  mkdirSync(dirname(markerPath), { recursive: true });
} catch (err) {
  logError('otel-export-worker.mkdir', err);
}

// withLock's critical section is synchronous (finally-releases as soon as fn
// returns), which would release before an awaited runExport finishes. The
// export is async, so the lock is acquired and released by hand instead.
const handle = acquireLock(markerPath, {});
if (!handle) {
  // A concurrent session's worker already holds the lock and is doing this
  // run: nothing lost, just skip.
  process.exit(0);
}
try {
  // Double-checked: a sibling worker may have run and released the lock
  // while this one was waiting to acquire it. Re-running would be harmless
  // to totals (whole-corpus re-derive) but would still duplicate the POST.
  const alreadyRan = readMarker(markerPath, { ttlMs: RECENT_RUN_MS }) !== null;
  if (!alreadyRan) {
    const result = await runExport({ pluginData });
    // Marker is written only on a successful run so a failure retries at the
    // next session-start rather than being skipped for the whole TTL.
    if (result.ok) {
      writeMarker(markerPath, true);
    } else if (result.error === 'no metrics to export') {
      // A fresh install has nothing to send yet. That is not a failure and
      // must not be logged as one: under the exportFailed scope /doctor showed
      // an empty install exactly like a dead endpoint. The marker stays
      // unstamped so the next session-start tries again.
      info('otel-export-worker.nothingToExport', 'no telemetry accumulated yet');
    } else {
      // runExport is documented never to throw, so without this the catch
      // below never fires and a dead endpoint, a 404 from a bad URL path, or
      // a timeout produced no record anywhere: the operator saw nothing in
      // /doctor and nothing in the logs. Routing it through logError puts it
      // in the durable sink, where /doctor's otel-error-log check counts it
      // by scope.
      logError('otel-export-worker.exportFailed', new Error(result.error || 'export failed'), {
        status: result.status,
        sent: result.sent,
      });
    }
  }
} catch (err) {
  logError('otel-export-worker.run', err);
} finally {
  releaseLock(handle);
}
