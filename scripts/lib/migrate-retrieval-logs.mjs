// scripts/lib/migrate-retrieval-logs.mjs
//
// One-shot cleanup: removes pre-canonical retrieval ledger .jsonl files so the
// canonical writer (lib/retrieval.writeRetrieval) emits into a clean directory.
// Pre-migration records (from vault-search.logRetrieval and the prior
// hooks/lib/common.emitRetrieval passthrough) used incompatible shapes;
// mixing them with the canonical shape would muddy downstream analytics.
//
// Idempotent. Marked complete by writing `<pluginData>/.retrieval-migrated-v2`.
// Subsequent runs skip with reason 'already-migrated'.
//
// Non-jsonl files in the retrieval directory are preserved (no glob delete).

import { existsSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from './log.mjs';

const MARKER = '.retrieval-migrated-v2';

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
  const retrievalDir = join(pluginData, 'retrieval');
  let removed = 0;
  try {
    if (existsSync(retrievalDir)) {
      for (const entry of readdirSync(retrievalDir)) {
        if (entry.endsWith('.jsonl')) {
          rmSync(join(retrievalDir, entry), { force: true });
          removed += 1;
        }
      }
    } else {
      mkdirSync(retrievalDir, { recursive: true });
    }
    writeFileSync(marker, new Date().toISOString());
    return { skipped: false, removed };
  } catch (err) {
    logError('lib.migrate-retrieval-logs', err);
    return { skipped: true, reason: 'error', err: err.message };
  }
}
