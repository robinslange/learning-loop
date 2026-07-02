// scripts/lib/retrieval.mjs — single canonical retrieval ledger writer.
//
// One record shape across all event types. The `prefix` selects the output
// file name (queries-, reads-, episodic-queries-, shadow-injection-, etc.)
// but the record shape is uniform.
//
// Replaces two prior call-site implementations:
//   - scripts/vault-search.mjs:logRetrieval — vault-side query/rerank/similar
//   - hooks/lib/common.mjs:emitRetrieval — hook-side reads/episodic/shadow
//
// Pre-migration the two writers produced incompatible shapes into the same
// PLUGIN_DATA/retrieval/ directory. Downstream consumers now see one shape.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonlLine } from './jsonl.mjs';
import { getSessionId } from './session.mjs';
import { logError } from './log.mjs';
import { DATA_PATHS } from './paths.mjs';
import { deriveOrigin } from './row-origin.mjs';

function monthStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Write one retrieval event.
 *
 * @param {object} opts
 * @param {string} opts.pluginData  Plugin-data root. Caller resolves; writer
 *                                  does not guess. Null/undefined is a silent
 *                                  no-op (matches the previous emitRetrieval
 *                                  early-return when resolvePluginData() is
 *                                  unset — hooks can fire before plugin-data
 *                                  is resolved).
 * @param {string} opts.prefix      File prefix (queries / reads /
 *                                  episodic-queries / shadow-injection / ...).
 * @param {string} opts.command     Event command label (query / similar /
 *                                  rerank / memory-read / episodic-search /
 *                                  shadow-injection / ...).
 * @param {string} opts.query       The query text, or filename for read events.
 * @param {Array|null} opts.results Result array. null/non-array =>
 *                                  result_count=0, top_paths=[].
 * @param {object} [opts.meta]      Caller-specific extra fields merged into
 *                                  the record. Keys collide-last-wins with
 *                                  the canonical fields above.
 */
export function writeRetrieval(opts) {
  try {
    const { pluginData, prefix, command, query, results, meta = {} } = opts;
    if (!pluginData) return;
    const dir = DATA_PATHS.retrieval(pluginData);
    mkdirSync(dir, { recursive: true });
    const topRows = Array.isArray(results) ? results.slice(0, 10) : [];
    const topPaths = topRows.map((r) => r.path || r.note_a || '');
    const peerCount = topRows.filter((r) => deriveOrigin(r).origin === 'peer').length;
    const record = {
      ts: new Date().toISOString(),
      session_id: getSessionId(),
      command,
      query,
      result_count: Array.isArray(results) ? results.length : 0,
      peer_results: peerCount,
      top_paths: topPaths,
      ...meta,
    };
    const file = join(dir, `${prefix}-${monthStr()}.jsonl`);
    appendJsonlLine(file, record);
  } catch (err) {
    logError('lib.retrieval.writeRetrieval', err);
  }
}
