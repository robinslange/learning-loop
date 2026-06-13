// hooks/lib/filename-style.mjs — Vault filename-convention advisory.
//
// Detects whether a new vault note's basename matches the vault's established
// naming convention (kebab-case vs. title-with-spaces) and returns a
// non-blocking advisory string when there is a mismatch, or null when the
// write is fine or the check should be skipped.

import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { logError } from '../../scripts/lib/log.mjs';

// The three content dirs cheap enough to list without recursion.
const SAMPLE_DIRS = ['0-inbox', '1-fleeting', '3-permanent'];
const SAMPLE_CAP = 200;

/** @param {string} stem  (no .md extension) */
function hasSpaces(stem) {
  return stem.includes(' ');
}

/** Convert a stem to kebab-case (lowercase, spaces → hyphens, collapse runs). */
function toKebab(stem) {
  return stem.toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Convert a stem to Title With Spaces (capitalise each word). */
function toSpaces(stem) {
  return stem
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Cheaply detect the vault's dominant filename convention by reading up to
 * SAMPLE_CAP basenames from the three most-used content dirs.
 *
 * @returns {'kebab'|'spaces'|null}  null when the population is ambiguous.
 */
function detectVaultStyle(vaultRoot) {
  const stems = [];
  for (const dir of SAMPLE_DIRS) {
    if (stems.length >= SAMPLE_CAP) break;
    try {
      const entries = readdirSync(join(vaultRoot, dir));
      for (const e of entries) {
        if (!e.endsWith('.md')) continue;
        stems.push(e.slice(0, -3));
        if (stems.length >= SAMPLE_CAP) break;
      }
    } catch {
      // Dir absent or unreadable — skip silently.
    }
  }
  if (stems.length === 0) return null;
  const withSpaces = stems.filter(hasSpaces).length;
  const ratio = withSpaces / stems.length;
  if (ratio > 0.7) return 'spaces';
  if (1 - ratio > 0.7) return 'kebab';
  return null;
}

/**
 * Check whether the basename of a new vault note matches the expected style.
 *
 * @param {string} filePath   Absolute path being written.
 * @param {string} vaultRoot  Absolute vault root.
 * @param {object} config     Parsed config.json object (may be {}).
 * @param {boolean} fileExists  True when the file already exists on disk.
 * @param {boolean} budgetOk    True when there is still time budget to run.
 * @returns {string|null}  Advisory message, or null when no advisory is needed.
 */
export function checkFilenameStyle(filePath, vaultRoot, config, fileExists, budgetOk) {
  // Only runs on new files.
  if (fileExists) return null;
  // Skip when budget is already exhausted (mirrors duplicate-gate behaviour).
  if (!budgetOk) return null;

  // Resolve expected style.
  const raw = config.filename_style;
  let expected;
  if (raw === 'kebab' || raw === 'spaces') {
    expected = raw;
  } else {
    // 'auto' or absent: detect from vault population.
    // Re-check budget before the synchronous readdirSync calls — the guard
    // above was sampled before this call-site; slow vaults can eat budget.
    if (!budgetOk) return null;
    try {
      expected = detectVaultStyle(vaultRoot);
    } catch (err) {
      // Filesystem errors (permissions, unavailable mount) → skip advisory.
      logError('checkFilenameStyle.detectVaultStyle', err);
      return null;
    }
    if (!expected) return null;
  }

  const stem = basename(filePath, '.md');
  const actual = hasSpaces(stem) ? 'spaces' : 'kebab';
  if (actual === expected) return null;

  const suggestion = expected === 'kebab' ? toKebab(stem) : toSpaces(stem);
  // CamelCase stems produce a toSpaces() result identical to the original — no-op advisory.
  if (suggestion === stem) return null;
  return (
    `Filename convention: this vault uses ${expected}-style names. ` +
    `Consider renaming to \`${suggestion}.md\`.`
  );
}
