// Shared shapes and ids for the health-check library.

export const CHECK_IDS = new Set([
  // quick checks
  'vault-path',
  'vault-folders',
  'vault-system-files',
  'binary-exists',
  'binary-version-file',
  'shims-exist',
  'local-bin-on-path',
  'claudemd-section-present',
  'claudemd-section-current',
  'installed-plugins-readable',
  'plugin-cache-version-present',
  'search-index-exists',
  'dup-scan-socket-fresh',
  'duplicate-gate-health',
  'hook-errors',
  'injection-shadow-gate',
  'abi-drift',
  'otel-export-status',
  'otel-error-log',
  'federation-sync-health',
  // full-only checks
  'node-version',
  'claude-version',
  'episodic-memory-installed',
  'learning-loop-installed',
  'binary-runs',
  'watch-daemon-status',
  'invalidated-adoption',
  'offline-mode',
  'edges-backfill',
  'contradiction-cycles',
]);

/**
 * Bind a check's fixed identity once; each branch then only supplies what
 * changes. Every result has the same six fields, and fix is null exactly when
 * the check passed.
 *
 * @param {string} id - must be in CHECK_IDS
 * @param {string} name - human-readable label
 * @param {'warn'|'fail'} severity - consequence class when the check fails
 */
export function checker(id, name, severity) {
  if (!CHECK_IDS.has(id)) throw new Error(`unknown health-check id: ${id}`);
  if (severity !== 'warn' && severity !== 'fail') {
    throw new Error(`health-check ${id}: severity must be warn or fail, got ${severity}`);
  }
  return {
    ok: (detail) => ({ id, name, status: 'ok', severity, detail, fix: null }),
    fail: (detail, fix) => ({ id, name, status: 'fail', severity, detail, fix }),
  };
}
