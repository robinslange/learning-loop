// scripts/lib/hook-config.mjs : numeric ceilings, thresholds, and timing
// constants used by hooks and scripts.
//
// Source of truth -- values are migrated from inline literals in:
//   hooks/session-label.js, hooks/session-start.js, hooks/stop-nudge.js,
//   hooks/pre-write-check.js, hooks/post-tool.js, scripts/review-shadow.mjs
// See .planning/inventory/coverage-and-magic.md §4 for the audit.
//
// Numbers are in their natural units; if a value is in seconds the constant
// name ends in _SECS, milliseconds in _MS, bytes or chars are explicit.
//
// Phase 0 (Track 0C): constants are defined here but hooks still use inline
// literals. Phase 1I migrates all consumers to import from this file.

/**
 * All numeric hook and script constants in one frozen object.
 * @type {Readonly<Record<string, number>>}
 */
export const HookConfig = Object.freeze({
  // --- Timeouts (ms) ---
  LABEL_TIMEOUT_MS: 3000,
  QUERY_TIMEOUT_MS: 3000,
  DEPS_CHECK_TIMEOUT_MS: 5000,
  DETECTOR_TIMEOUT_MS: 200,
  SNAPSHOT_TIMEOUT_MS: 10000,
  REINDEX_TIMEOUT_MS: 5000,
  DAEMON_STARTUP_DEADLINE_MS: 2000,
  DAEMON_CHECK_POLL_MS: 50,
  DOWNLOAD_TIMEOUT_MS: 8000,
  POST_TOOL_TIMEOUT_MS: 5000,
  PROVENANCE_TIMEOUT_MS: 3000,
  INJECTION_RACE_CAP_MS: 1500,
  DEDUPE_WINDOW_MS: 180_000,
  SESSION_DEDUPE_TTL_MS: 604_800_000, // 7 days
  CONVERGENCE_TTL_MS: 604_800_000, // 7 days
  AUTOLINK_ML_TIMEOUT_MS: 1000,
  STDIN_TIMEOUT_MS: 3000,
  SWEEP_HOOK_TIMEOUT_MS: 15000,
  NPM_INSTALL_TIMEOUT_MS: 10000,

  // --- Cooldowns (seconds) ---
  REFLECT_COOLDOWN_SECS: 300,
  DREAM_COOLDOWN_SECS: 300,
  VERSION_CHECK_TTL_SECS: 3600,

  // --- Size & length thresholds (chars / bytes) ---
  ERROR_MSG_MAX_CHARS: 500,
  LABEL_MAX_LENGTH: 35,
  MIN_LABEL_LENGTH: 20,
  PROMPT_SLICE_CHARS: 200,
  PRIOR_MSG_SLICE_CHARS: 200,
  QUERY_SLICE_CHARS: 400,
  RECENT_MSG_WINDOW: 80,
  SESSION_SIZE_THRESHOLD_BYTES: 51_200,
  HOOK_STDOUT_MAX_BYTES: 8192,

  // --- Per-module post-tool timeout (ms) ---
  POST_TOOL_MODULE_TIMEOUT_MS: 2000,

  // --- Stop-nudge message count threshold ---
  STOP_NUDGE_MESSAGE_COUNT: 25,

  // --- ML thresholds / weights ---
  INJECTION_THRESHOLD: 0.35,
  SIMILARITY_THRESHOLD: 0.85,
  COSINE_MIN: 0.74,
  COSINE_MAX: 0.92,
  MSG_WEIGHT_CURRENT: 10,
  MSG_WEIGHT_RECENT: 3,
  MSG_WEIGHT_OLDER: 1,
});
