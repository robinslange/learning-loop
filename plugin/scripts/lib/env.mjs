// scripts/lib/env.mjs : single point of process.env access for the plugin.
//
// Every other module in hooks/ and scripts/ must import from this file rather
// than reading process.env directly. The flat object below is frozen so callers
// cannot mutate it back into a side-channel; if a test needs to override a
// value, it should set process.env before importing this module.
//
// This module snapshots process.env at import time. Tests that need different
// values must run in subprocesses with the desired env set before import.
//
// Spawn-time variables (ORT_DYLIB_PATH, ORT_LIB_LOCATION) are intentionally
// excluded: those are written into child-process env by spawner code, never
// read from process.env by the plugin itself.

import { homedir } from 'node:os';
import { DEFAULT_OLLAMA_URL } from './defaults.mjs';
import { HookConfig } from './hook-config.mjs';

/**
 * Returns true for the canonical truthy env-var strings.
 * @param {string | undefined | null} v
 * @returns {boolean}
 */
export function isTruthy(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Coerces an env-var string to a finite number, returning fallback on failure.
 * @param {string | undefined | null} v
 * @param {number} fallback
 * @returns {number}
 */
export function coerceNumber(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pick(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const homeBase = process.env.HOME || process.env.USERPROFILE || homedir();

/**
 * Frozen snapshot of all env vars the plugin reads.
 * Access via `env.VAULT_PATH` etc. — do not read process.env directly.
 */
export const env = Object.freeze({
  // --- Vault & plugin data ---
  VAULT_PATH: pick('VAULT_PATH', null),
  CLAUDE_PLUGIN_DATA: pick('CLAUDE_PLUGIN_DATA', null),
  CLAUDE_PROJECT_DIR: pick('CLAUDE_PROJECT_DIR', ''),

  // --- Harness ---
  // Codex sets PLUGIN_ROOT/PLUGIN_DATA for plugin-bundled hooks, and also sets
  // CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA for compatibility with existing plugin
  // hooks. Claude Code sets only the CLAUDE_-prefixed pair. PLUGIN_ROOT is
  // therefore the discriminator. Read it via harness.mjs, not directly.
  PLUGIN_ROOT: pick('PLUGIN_ROOT', null),
  PLUGIN_DATA: pick('PLUGIN_DATA', null),
  CODEX_HOME: pick('CODEX_HOME', null),
  // Explicit harness name. Codex has no session marker in the shell env it
  // hands to commands, so install.sh writes this into
  // `shell_environment_policy.set` in ~/.codex/config.toml. That covers the
  // script path; PLUGIN_ROOT covers the hook path without any config at all.
  LL_HARNESS: pick('LL_HARNESS', null),

  // --- Host ---
  HOME: homeBase,
  USERPROFILE: pick('USERPROFILE', homeBase),
  PATH: pick('PATH', ''),

  // --- Diagnostics ---
  LL_HOOK_DEBUG: isTruthy(process.env.LL_HOOK_DEBUG),

  // Kill switch for the session-start health detector line
  // (hooks/session-start/health-detector.mjs).
  LL_DISABLE_DETECTOR: isTruthy(process.env.LL_DISABLE_DETECTOR),

  // --- Test seam ---
  // Redirects the legacy tmp session-id file (writer in
  // hooks/session-start/vault-snapshot.mjs, reader in scripts/lib/session.mjs)
  // so tests never touch the machine-global file.
  LL_SESSION_TMP_DIR: pick('LL_SESSION_TMP_DIR', ''),

  // --- Test seam ---
  // When set (hook-runner sandboxes), every detached child pid is appended to
  // this file so the harness can reap the children before removing the
  // sandbox. Unset in production.
  LL_CHILD_PID_FILE: pick('LL_CHILD_PID_FILE', ''),

  // --- Test seam ---
  // Overrides the pre-write-check wall-clock budget (default mirrors the
  // hooks.json deadline via HookConfig.PRE_WRITE_HOOK_BUDGET_MS). A contended
  // full-suite run can burn the 3s budget on cold Node startup before the
  // duplicate-gate subprocess fallback runs, flaking the fallback tests; they
  // set this to a generous value. Unset in production.
  LL_PRE_WRITE_BUDGET_MS: pick('LL_PRE_WRITE_BUDGET_MS', ''),

  // --- Test seam ---
  // Overrides autolink's similarity-exec wall-clock timeout (default
  // HookConfig.AUTOLINK_ML_TIMEOUT_MS, 1s). The 1s cap is the right production
  // fail-open budget but makes the autolink similarity test time-dependent: a
  // contended full-suite run can exceed it before the stubbed exec returns,
  // dropping the appended links. The test sets a generous value. Unset in
  // production.
  LL_AUTOLINK_ML_TIMEOUT_MS: pick('LL_AUTOLINK_ML_TIMEOUT_MS', ''),

  // --- Reflect new-notes handshake ---
  // Explicit session id for the /reflect new-notes marker. Set by the reflect
  // skill (and sweep-hook-replay, which forwards it) so a replayed Write appends
  // to the CALLING session's marker rather than whatever getSessionId() resolves
  // — the only attribution that survives concurrent /reflect runs, where the
  // unsuffixed plugin-data session `id` is last-writer-wins. Empty/unset in the
  // normal main-thread hook path, where getSessionId() is correct.
  LL_REFLECT_SID: pick('LL_REFLECT_SID', null),

  // --- Memory injection ---
  LEARNING_LOOP_ALWAYS_INJECT_MEMORY: isTruthy(process.env.LEARNING_LOOP_ALWAYS_INJECT_MEMORY),

  // --- Injection feature flags ---
  LEARNING_LOOP_INJECTION_FORCE_ERROR: isTruthy(process.env.LEARNING_LOOP_INJECTION_FORCE_ERROR),
  LEARNING_LOOP_INJECTION_MODE: pick('LEARNING_LOOP_INJECTION_MODE', null),
  LEARNING_LOOP_INJECTION_RACE_CAP_MS: coerceNumber(
    process.env.LEARNING_LOOP_INJECTION_RACE_CAP_MS,
    1500,
  ),
  LEARNING_LOOP_INJECTION_THRESHOLD: coerceNumber(
    process.env.LEARNING_LOOP_INJECTION_THRESHOLD,
    HookConfig.INJECTION_THRESHOLD,
  ),
  // Marks shadow-injection telemetry written by synthetic/calibration
  // sessions (e.g. a fixed prompt cycle run to exercise the gate) so
  // review-shadow.mjs and future calibration tooling can filter them out —
  // unlabeled synthetic traffic silently pollutes the pass-rate stats it's
  // supposed to calibrate against.
  LEARNING_LOOP_SYNTHETIC: isTruthy(process.env.LEARNING_LOOP_SYNTHETIC),

  // --- Distribution / build ---
  LL_REPO: pick('LL_REPO', 'robinslange/learning-loop'),
  LL_BENCH_REAL_ONNX: isTruthy(process.env.LL_BENCH_REAL_ONNX),

  // --- Distribution / offline ---
  // Air-gap / update-control switch. When truthy, every plugin-INITIATED network
  // call is suppressed: the GitHub update poll, the binary auto-update download,
  // and all external web-research fetches (source-resolver, /verify, /research).
  // Localhost (Ollama) is unaffected — an air-gapped box still runs its local model.
  // Gate every call site through isOffline(), not by reading this field directly.
  LL_OFFLINE: isTruthy(process.env.LL_OFFLINE),

  // --- Ollama / model ---
  // null when unset, NOT the default: consumers layer config between the env
  // var and the default, and a pre-defaulted value here is indistinguishable
  // from an explicit one, so `librarian.ollama_url` could never be reached.
  OLLAMA_URL: pick('OLLAMA_URL', null),
  MODEL: pick('MODEL', null),

  // --- Cascade-detection sentinels ---
  // True only when the var was explicitly set in the environment (not defaulted).
  // Used by callers that need to distinguish "user set this" from "we defaulted it".
  LEARNING_LOOP_INJECTION_THRESHOLD_SET:
    process.env.LEARNING_LOOP_INJECTION_THRESHOLD !== undefined,
  LEARNING_LOOP_INJECTION_MODE_SET: process.env.LEARNING_LOOP_INJECTION_MODE !== undefined,
});

/**
 * Build an env object for spawning child processes.
 * Merges the current process.env with caller-supplied ORT/spawn-time overrides.
 * This is the only permitted access to process.env spread in the plugin.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
export function spawnEnv(overrides = {}) {
  return { ...process.env, ...overrides };
}

/**
 * True when the plugin must make zero outbound network calls (air-gap /
 * update-control). The single source of truth for the offline decision: every
 * plugin-initiated egress site (update poll, binary download, web-research
 * fetch leaves) gates on this rather than reading env.LL_OFFLINE directly.
 * Localhost (Ollama) is never gated by this.
 * @returns {boolean}
 */
export function isOffline() {
  return env.LL_OFFLINE;
}
