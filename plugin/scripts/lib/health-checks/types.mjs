// Shared shapes and enums for the health-check library.

export const SEVERITIES = Object.freeze({
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
});

export const CHECK_IDS = Object.freeze({
  // quick checks
  'vault-path': 'vault-path',
  'vault-folders': 'vault-folders',
  'vault-system-files': 'vault-system-files',
  'binary-exists': 'binary-exists',
  'binary-version-file': 'binary-version-file',
  'shims-exist': 'shims-exist',
  'local-bin-on-path': 'local-bin-on-path',
  'claudemd-section-present': 'claudemd-section-present',
  'claudemd-section-current': 'claudemd-section-current',
  'installed-plugins-readable': 'installed-plugins-readable',
  'plugin-cache-version-present': 'plugin-cache-version-present',
  'search-index-exists': 'search-index-exists',
  'nli-socket-fresh': 'nli-socket-fresh',
  'duplicate-gate-health': 'duplicate-gate-health',
  'hook-errors': 'hook-errors',
  'injection-shadow-gate': 'injection-shadow-gate',
  'abi-drift': 'abi-drift',
  // full-only checks
  'node-version': 'node-version',
  'claude-version': 'claude-version',
  'episodic-memory-installed': 'episodic-memory-installed',
  'learning-loop-installed': 'learning-loop-installed',
  'binary-runs': 'binary-runs',
  'watch-daemon-status': 'watch-daemon-status',
  'offline-mode': 'offline-mode',
});

/**
 * Construct a Check result. Always returns the same shape so consumers
 * never have to defend against missing fields.
 *
 * @param {object} opts
 * @param {string} opts.id - must be from CHECK_IDS
 * @param {string} opts.name - human-readable label
 * @param {'ok'|'warn'|'fail'} opts.status - current state
 * @param {'ok'|'warn'|'fail'} opts.severity - consequence class if status !== 'ok'
 * @param {string} opts.detail - short string for display
 * @param {string|null} opts.fix - imperative fix message, or null when status==='ok'
 * @returns {{id, name, status, severity, detail, fix}}
 */
export function makeCheck({ id, name, status, severity, detail, fix }) {
  return {
    id,
    name,
    status,
    severity,
    detail,
    fix: status === SEVERITIES.ok ? null : (fix ?? null),
  };
}
