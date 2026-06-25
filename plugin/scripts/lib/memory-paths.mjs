// scripts/lib/memory-paths.mjs : resolve the auto-memory dir and list its note files.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, encodeProjectDir } from './paths.mjs';

// Files in the memory dir that are NOT individual memories.
const NON_MEMORY = new Set(['MEMORY.md', '_dream_log.md']);

/**
 * Resolve the auto-memory dir for a project. Slug derivation matches
 * hooks/lib/dream-gate.js exactly so all consumers agree on the path.
 * @param {string | undefined} projectDir
 * @param {string} [homeDir]  defaults to home(); param for testability
 * @returns {string | null} the memory dir, or null when projectDir is absent
 */
export function resolveMemoryDir(projectDir, homeDir = home()) {
  if (!projectDir) return null;
  const encodedPath = encodeProjectDir(projectDir);
  return join(homeDir, '.claude', 'projects', encodedPath, 'memory');
}

/**
 * List individual memory note files in a memory dir (top level only).
 * Excludes the index, the dream log, dotfiles, and underscore-prefixed files.
 * @param {string} memDir
 * @returns {{ name: string, path: string }[]}
 */
export function listMemoryFiles(memDir) {
  let entries;
  try {
    entries = readdirSync(memDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith('.md'))
    .filter((n) => !n.startsWith('_'))
    .filter((n) => !n.startsWith('.'))
    .filter((n) => !NON_MEMORY.has(n))
    .map((name) => ({ name, path: join(memDir, name) }));
}

/** Read a memory file's raw text. */
export function readMemoryFile(path) {
  return readFileSync(path, 'utf8');
}
