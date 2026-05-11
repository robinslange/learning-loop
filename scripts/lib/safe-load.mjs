// scripts/lib/safe-load.mjs : read-and-validate a JSON file without throwing.
//
// Audit (plugin-patterns.md §3) found 22 JSON.parse(readFileSync(...)) sites
// with bare catches. This helper centralises:
//   1. file existence check
//   2. BOM-safe read + JSON.parse
//   3. optional caller-provided validator function
//   4. consistent { value, error? } return shape
//
// On any failure, value === opts.fallback (default null) and error is a string.
// Callers may log the error via scripts/lib/log.mjs.
//
// The `atomic` option is intentionally absent: atomic *reads* on POSIX are
// already atomic at the syscall level for files <= PIPE_BUF. Atomic *writes*
// belong on a safeSave helper (out of scope for 0C).

import { readFileSync, existsSync } from 'node:fs';

/**
 * @typedef {(v: unknown) => true | string} Validator
 * Returns `true` if the value is valid, or a human-readable reason string
 * if invalid.
 */

/**
 * Read and parse a JSON file, returning a `{ value, error? }` pair.
 * Never throws.
 *
 * @param {string} path  Absolute or resolvable path to the JSON file.
 * @param {{
 *   schema?: Validator,
 *   fallback?: unknown,
 * }} [opts]
 * @returns {{ value: unknown, error?: string }}
 */
export function safeLoad(path, opts = {}) {
  const fallback = 'fallback' in opts ? opts.fallback : null;

  if (!path) return { value: fallback, error: 'no path' };
  if (!existsSync(path)) return { value: fallback, error: 'enoent' };

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return { value: fallback, error: `read: ${e.code || e.message}` };
  }

  // Strip BOM if present.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { value: fallback, error: `parse: ${e.message}` };
  }

  if (opts.schema) {
    let verdict;
    try {
      verdict = opts.schema(parsed);
    } catch (e) {
      return { value: fallback, error: `schema-threw: ${e.message}` };
    }
    if (verdict !== true) {
      return { value: fallback, error: `schema: ${verdict || 'invalid'}` };
    }
  }

  return { value: parsed };
}
