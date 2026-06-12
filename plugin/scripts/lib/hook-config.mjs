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
  QUERY_TIMEOUT_MS: 2000,
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
  // Cutoff for vault-snapshot's stale per-session artifact sweeps (three
  // targets: retrieval/session-dedupe entries, plugin-data markers/, legacy
  // tmp markers).
  SESSION_SWEEP_TTL_MS: 604_800_000, // 7 days
  // edges.db.<pid>.tmp orphans (crash between saveDb's write and rename).
  EDGES_TMP_ORPHAN_TTL_MS: 3_600_000, // 1 hour
  CONVERGENCE_TTL_MS: 604_800_000, // 7 days
  AUTOLINK_ML_TIMEOUT_MS: 1000,
  STDIN_TIMEOUT_MS: 3000,
  SWEEP_HOOK_TIMEOUT_MS: 15000,
  NPM_INSTALL_TIMEOUT_MS: 10000,

  // --- Cooldowns (seconds) ---
  // A dream lock whose recorded pid is dead is considered abandoned after
  // this age. Skill bash pids die when the Bash tool call returns, so the
  // age floor — not pid liveness — is the real staleness mechanism (M5).
  DREAM_LOCK_STALE_SECS: 3600,
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
  // session-label reads only this much of the transcript tail per prompt;
  // transcripts embed full tool outputs and reach tens of MB, while only the
  // last RECENT_MSG_WINDOW lines are ever consumed.
  TRANSCRIPT_TAIL_BYTES: 262_144,
  // Stop-nudge "substantial session" gate. Transcripts embed full tool
  // outputs, so small thresholds fire within the first few tool-heavy turns
  // — mid-task, not at wind-down. 500KB / 200 events approximates a genuinely
  // long working session.
  SESSION_SIZE_THRESHOLD_BYTES: 512_000,
  HOOK_STDOUT_MAX_BYTES: 8192,
  MEMORY_INDEX_MAX_BYTES: 3072,

  // --- Per-module post-tool timeout (ms) ---
  POST_TOOL_MODULE_TIMEOUT_MS: 2000,

  // --- Stop-nudge message count threshold (JSONL transcript lines) ---
  STOP_NUDGE_MESSAGE_COUNT: 200,

  // --- ML thresholds / weights ---
  // INJECTION_THRESHOLD gates the JIT injection pipeline (session-label.js).
  // UNIT: raw RRF fusion sum as returned by `ll-search query` — NOT a cosine
  // similarity. With RRF_K=5 each signal contributes 1/(5+rank), so a doc
  // ranked #1 in one signal scores 0.167, #1 in two signals 0.333, and #1 in
  // all five signals ~0.83. Cosine-style values (0.7+) are unreachable.
  //
  // Calibration (2026-06-12): shadow-injection logs 2026-04 → 2026-06,
  // n=18,360 healthy gate evaluations with a recorded vault_top_score.
  // Distribution: 6.8% scored 0 (no hits); every nonzero top score was
  // >= 0.3333 (top hit ranked #1 in >= 2 signals); nonzero p25=0.367,
  // p50=0.396, p75=0.446, p95=0.489, max=0.563. The previous 0.35 gate sat
  // ABOVE the two-strong-signals floor and rejected that whole cohort
  // (~10% of nonzero scores: 0.333-0.35). All logged data predates the BM25
  // OR-mode change for long queries (which shifts this distribution), so the
  // gate is derived from achievable-score math rather than a percentile:
  // 0.30 sits just below the two-strong-signals level (2/(5+1) = 0.333) and
  // above a lone single-signal #1 (1/6 = 0.167) — i.e. inject only when the
  // top hit is corroborated near the top of at least two signals.
  // Re-calibrate from post-OR-mode logs once they accumulate
  // (node scripts/review-shadow.mjs).
  INJECTION_THRESHOLD: 0.3,
  SIMILARITY_THRESHOLD: 0.85,
  COSINE_MIN: 0.74,
  COSINE_MAX: 0.92,
  MSG_WEIGHT_CURRENT: 10,
  MSG_WEIGHT_RECENT: 3,
  MSG_WEIGHT_OLDER: 1,
});
