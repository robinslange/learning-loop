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
  QUERY_TIMEOUT_MS: 2000,
  DEPS_CHECK_TIMEOUT_MS: 5000,
  SNAPSHOT_TIMEOUT_MS: 10000,
  REINDEX_TIMEOUT_MS: 5000,
  DAEMON_STARTUP_DEADLINE_MS: 2000,
  DAEMON_CHECK_POLL_MS: 50,
  DOWNLOAD_TIMEOUT_MS: 8000,
  POST_TOOL_TIMEOUT_MS: 5000,
  PROVENANCE_TIMEOUT_MS: 3000,
  INJECTION_RACE_CAP_MS: 1500,
  // Rerank runs AFTER fusion (it needs the gate to have passed) and is strictly
  // slower (~750ms warm at 20 candidates, measured), so it gets its own timeout
  // rather than sharing the fusion race-cap. Log-only today: a timeout drops the
  // rerank telemetry for that prompt, injection still proceeds in fusion order.
  INJECTION_RERANK_TIMEOUT_MS: 1200,
  INJECTION_RERANK_CANDIDATES: 20,
  // Per-session suppression window for re-injecting a note already shown. The
  // window is the only thing standing between the payload and a note that keeps
  // winning fusion turn after turn.
  //
  // Calibration (2026-07-31): replay of fixture-free shadow-injection rows
  // 2026-05..07, n=5,347 injections over 404 sessions
  // (scripts/dedupe-window-replay.mjs). 45.2% of injections re-showed a note
  // already injected earlier in the SAME session; 21% were back-to-back. The
  // repeat-gap distribution is short and heavy at the head: p25=18s, p50=66s,
  // p90=1823s. The prior 180_000 (3 min) caught only 66.5% of repeats, and
  // measured dedupe_filtered_count was 0 on 89.3% of injections — the cutoff
  // pruned the state faster than a working session accumulated it.
  //
  // 4h covers 95.9% of repeats (vs 99.5% at 24h) and is set at the knee: past
  // this the curve is flat, and a bounded window keeps a genuinely-new phase of
  // a long session able to re-surface a note it has moved back to. Repeats are
  // also enriched for low-value turns: repeat prompts average 8.0 words against
  // 16.6 for first-time injections, i.e. the same thin-prompt population the
  // specificity floor already targets.
  //
  // Suppression is a token-budget and habituation argument, NOT a claim that
  // repetition degrades model attention: the one controlled study of exact
  // repetition (arXiv:2412.07923) found null results. The support is that
  // massed repeats are the weakest condition in the human spacing-effect
  // literature (Cepeda et al. 2008), and that redundancy filtering measurably
  // helps RAG (ChunkRAG, arXiv:2410.19572).
  DEDUPE_WINDOW_MS: 14_400_000, // 4 hours
  // Cutoff for vault-snapshot's stale per-session artifact sweeps (three
  // targets: retrieval/session-dedupe entries, plugin-data markers/, legacy
  // tmp markers).
  SESSION_SWEEP_TTL_MS: 604_800_000, // 7 days
  // edges.db.<pid>.tmp orphans (crash between saveDb's write and rename).
  EDGES_TMP_ORPHAN_TTL_MS: 3_600_000, // 1 hour
  CONVERGENCE_TTL_MS: 604_800_000, // 7 days
  // librarian/queue.jsonl.bak.* backups (crash-safety copies taken before a
  // queue rewrite) older than this are reaped by the same TTL sweep.
  LIBRARIAN_QUEUE_BAK_TTL_MS: 604_800_000, // 7 days
  // retrieval/<prefix>-YYYY-MM.jsonl: months kept per prefix, by filename
  // month, not mtime. The current month is always kept regardless of count.
  RETRIEVAL_LOG_KEEP_MONTHS: 3,
  AUTOLINK_ML_TIMEOUT_MS: 1000,
  STDIN_TIMEOUT_MS: 3000,
  SWEEP_HOOK_TIMEOUT_MS: 15000,
  NPM_INSTALL_TIMEOUT_MS: 10000,

  // --- Pre-write duplicate-gate budget (ms) ---
  // hooks.json gives pre-write-check 3s total, and the duplicate gate can
  // spend from that budget twice: a daemon attempt, then a subprocess
  // fallback. The composition must fit inside the outer deadline or Claude
  // Code SIGKILLs the hook mid-subprocess and every warning is lost. The
  // daemon gets a short timer (the warm path answers in ~430ms); the
  // subprocess timer is computed at runtime from the remaining budget
  // (min(QUERY_TIMEOUT_MS, budget - elapsed - safety margin)) and the
  // fallback is skipped entirely when the remainder is under the measured
  // cold-start floor. PRE_WRITE_HOOK_BUDGET_MS must mirror the hooks.json
  // timeout — tests/lib-hook-config.test.mjs pins both.
  PRE_WRITE_HOOK_BUDGET_MS: 3000,
  PRE_WRITE_DAEMON_TIMEOUT_MS: 800,
  PRE_WRITE_SAFETY_MARGIN_MS: 300,
  PRE_WRITE_SUBPROCESS_FLOOR_MS: 300,

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
  // Below this length, the prompt alone doesn't carry enough of its own
  // topic to search on — blend in prior message context. At or above it,
  // prior context is stale noise that dilutes a query that's already
  // self-sufficient (2026-07 sample: 19/50 irrelevant injections were thin
  // continuations dominated by stale prior-message text).
  QUERY_SOLO_MIN_CHARS: 80,
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
  // UNIT: raw WEIGHTED RRF fusion sum as returned by `ll-search query` — NOT a
  // cosine similarity. With RRF_K=5 each lane contributes weight/(5+rank), and
  // the shipped weights are unequal (vec/bm25 1.0, prf 0.5, ppr/tag 0.05), so a
  // doc ranked #1 by vector alone scores 0.167, #1 in both retrieval lanes
  // 0.333, and #1 in all five lanes 0.4333 — the ceiling. Cosine-style values
  // (0.7+) are unreachable, and anything above 0.4333 disables the gate.
  // The history below is kept because it records why the value moved; the
  // percentiles in it were measured on the OLD unweighted scale (ceiling
  // 0.8333) and are NOT comparable to the current one. See the Rescale note.
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
  //
  // 0.30 was INTENTIONALLY PERMISSIVE: it admitted "any corroborated hit"
  // (>= two-strong-signals, 0.333) and deferred within-distribution
  // discrimination until post-epoch shadow data accumulated.
  //
  // Recalibration (2026-07-16): the post-OR-mode data now exists. On 42,241
  // healthy gate evaluations since the 2026-06-12 epoch, the passing-score
  // distribution resolved to 0.32-0.60 (p50 ~0.44), and a grounded relevance
  // study (50 injections, 10/band, LLM-judged) found top-note relevance runs
  // 30-40% in the 0.32-0.40 band and only lifts to 50-60% at 0.45+. The
  // 0.30 gate therefore shipped ~40% of its volume (the 0.32-0.40 bands,
  // ~8,800 injections) at the LEAST on-topic score band — the loud, lukewarm
  // volume that trains banner-blindness. Raising to 0.40 drops that bottom
  // ~40% at the weakest band while keeping the corroborated core. It is the
  // volume/noise cut, not the precision ceiling: score is a weak, non-monotonic
  // predictor of relevance, so the real precision lift is a reranker in the JIT
  // path (a separate lever). 0.40 sits above the two-bare-#1-signals floor
  // (0.333): the gate now requires corroboration BEYOND two lone top hits.
  //
  // Rescale (2026-08-04): weighted fusion (ll-core VEC/BM25=1.0, PPR/TAG=0.05,
  // PRF=0.5, shipped v1.40.0) changed the UNIT this constant is denominated in.
  // The achievable maximum fell from 5/(5+1)=0.8333 to 2.6/(5+1)=0.4333, so the
  // 0.40 gate inherited from the unweighted scale sat at 92% of the new ceiling
  // and passed only when vec, BM25 and PRF all ranked the same note #1
  // (1/6+1/6+0.5/6 = 0.4167). Reachable combinations under the new weights:
  //   vec#1                      0.1667
  //   vec#1 + bm25#2             0.3095
  //   vec#1 + bm25#1             0.3333   <- two-strong-lanes floor (unchanged:
  //                                          both retrieval lanes kept weight 1.0)
  //   vec#1 + bm25#1 + graph#1   0.3500
  //   vec#1 + bm25#1 + prf#1     0.4167
  //   all five lanes #1          0.4333   <- ceiling
  // 0.34 restores the ORIGINAL intent on the new scale: just above the
  // two-bare-#1 floor, so the gate still demands corroboration beyond two lone
  // top hits, without requiring a near-perfect sweep. It deliberately does not
  // sit on 0.35, which is exactly reachable by graph-lane agreement.
  //
  // This value is INTERIM. It is derived from achievable-score arithmetic, not
  // from measured relevance: every percentile quoted above was recorded under
  // unweighted fusion and says nothing about this scale. Re-derive from
  // post-epoch data before moving it again. The 0.50 candidate on
  // feat/jit-injection-quality was measured on the unweighted scale and is
  // ABOVE the current ceiling — do not merge that value without re-deriving it.
  INJECTION_THRESHOLD: 0.34,
  SIMILARITY_THRESHOLD: 0.85,
  COSINE_MIN: 0.74,
  COSINE_MAX: 0.92,
  MSG_WEIGHT_CURRENT: 10,
  MSG_WEIGHT_RECENT: 3,
  MSG_WEIGHT_OLDER: 1,
});

// Shadow-gate decisions logged before this timestamp were produced by a
// different pipeline (threshold 0.35, BM25 AND-mode for long queries) and say
// nothing about the gate that would go live today. The injection-shadow-gate
// readiness check only counts shadow entries with ts >= this epoch. Bump it
// whenever INJECTION_THRESHOLD or the fusion mode changes — the go-live
// criteria then reset automatically to post-change data.
// Set 2026-06-12: 0.35 -> 0.30 threshold + BM25 OR-mode for long queries.
// Bumped 2026-07-16: 0.30 -> 0.40 threshold (precision cut). The readiness
// check + review-shadow calibration now count only post-bump data.
// Bumped 2026-08-04: weighted fusion (v1.40.0) + 0.40 -> 0.34 rescale. Weighted
// fusion landed WITHOUT bumping this epoch, so scores either side of it were
// pooled on incommensurable scales; everything before this timestamp is
// unweighted-fusion data and cannot be compared to what follows.
export const INJECTION_CALIBRATION_EPOCH = '2026-08-04T00:00:00.000Z';

/**
 * Read the pre_write_fail_mode setting from a loaded config object.
 * Returns 'closed' only when explicitly set; all other values (including
 * absent, null, or any invalid string) fall back to 'open'.
 *
 * @param {object|null|undefined} config
 * @returns {'open'|'closed'}
 */
export function preWriteFailMode(config) {
  return config?.hooks?.pre_write_fail_mode === 'closed' ? 'closed' : 'open';
}
