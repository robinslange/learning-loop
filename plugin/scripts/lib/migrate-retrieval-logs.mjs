// scripts/lib/migrate-retrieval-logs.mjs
//
// One-shot cleanup: removes pre-canonical retrieval ledger .jsonl files so the
// canonical writer (lib/retrieval.writeRetrieval) emits into a clean directory.
// Pre-migration records (from vault-search.logRetrieval and the prior
// hooks/lib/common.emitRetrieval passthrough) used incompatible shapes;
// mixing them with the canonical shape would muddy downstream analytics.
//
// CRITICAL: only delete files matching the four pre-canonical prefixes the
// canonical writer is replacing. Other plugins write their own .jsonl files
// into PLUGIN_DATA/retrieval/ — specifically plugins/omc-cache-health writes
// cache-health-YYYY-MM.jsonl (read by scripts/cache-health-report.mjs).
// Blanket .jsonl deletion would wipe Robin's accumulated cache-health history
// on every install. Always extend this list when a new canonical-shape prefix
// is introduced; never widen to a glob.
//
// Idempotent. Marked complete by writing `<pluginData>/.retrieval-migrated-v2`.
// Subsequent runs skip with reason 'already-migrated'.

import { existsSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from './log.mjs';
import { DATA_PATHS } from './paths.mjs';

const MARKER = '.retrieval-migrated-v2';

// Pre-canonical prefixes the canonical writer now owns. Files matching
// `<prefix>-YYYY-MM.jsonl` for any of these are safe to delete because the
// new writer will recreate them in the canonical shape.
const PRE_CANONICAL_PREFIXES = [
  'queries-', // vault-search.logRetrieval
  'reads-', // post-read-retrieval.js (memory-read)
  'episodic-queries-', // post-search-tracking.js (episodic-search)
  'shadow-injection-', // session-label.js (shadow injection)
];

function isPreCanonicalLog(filename) {
  if (!filename.endsWith('.jsonl')) return false;
  return PRE_CANONICAL_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

/**
 * Run the one-shot cleanup if it hasn't run for this pluginData yet.
 *
 * @param {string|null|undefined} pluginData Plugin-data root.
 * @returns {{skipped: boolean, reason?: string, removed?: number, err?: string}}
 */
export function migrateRetrievalLogsIfNeeded(pluginData) {
  if (!pluginData) return { skipped: true, reason: 'no-plugin-data' };
  const marker = join(pluginData, MARKER);
  if (existsSync(marker)) return { skipped: true, reason: 'already-migrated' };
  const retrievalDir = DATA_PATHS.retrieval(pluginData);
  let removed = 0;
  try {
    if (existsSync(retrievalDir)) {
      for (const entry of readdirSync(retrievalDir)) {
        if (isPreCanonicalLog(entry)) {
          rmSync(join(retrievalDir, entry), { force: true });
          removed += 1;
        }
      }
    } else {
      // Ensure the dir exists so post-install inspection tools that look at
      // <plugin-data>/retrieval/ find a directory rather than ENOENT.
      // The canonical writer will create it on first write anyway.
      mkdirSync(retrievalDir, { recursive: true });
    }
    writeFileSync(marker, new Date().toISOString());
    return { skipped: false, removed };
  } catch (err) {
    logError('lib.migrate-retrieval-logs', err);
    return { skipped: true, reason: 'error', err: err.message };
  }
}
