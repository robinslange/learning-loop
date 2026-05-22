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

  // --- Host ---
  HOME: homeBase,
  USERPROFILE: pick('USERPROFILE', homeBase),
  PATH: pick('PATH', ''),

  // --- Diagnostics ---
  LL_HOOK_DEBUG: isTruthy(process.env.LL_HOOK_DEBUG),

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
    0.35,
  ),

  // --- Distribution / build ---
  LL_REPO: pick('LL_REPO', 'robinslange/learning-loop'),
  LL_BENCH_REAL_ONNX: isTruthy(process.env.LL_BENCH_REAL_ONNX),

  // --- Ollama / model ---
  OLLAMA_URL: pick('OLLAMA_URL', 'http://localhost:11434'),
  MODEL: pick('MODEL', 'gemma4:e2b'),

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
