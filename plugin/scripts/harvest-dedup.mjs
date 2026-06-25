// scripts/harvest-dedup.mjs : dedup harvested notes via a local .harvested-log.
// Does NOT mutate notes — the portable marker is preserved; the log handles dedup.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @returns {string[]} previously harvested paths */
export function readHarvested(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} candidatePaths
 * @param {string[]} harvested
 * @param {boolean} all  when true, ignore the log and return all candidates
 */
export function filterUnharvested(candidatePaths, harvested, all) {
  if (all) return [...candidatePaths];
  const seen = new Set(harvested);
  return candidatePaths.filter((p) => !seen.has(p));
}

export function appendHarvested(logPath, paths) {
  if (paths.length === 0) return;
  // Ensure the parent dir exists — the SKILL appends via a catch-less .then()
  // chain, so an ENOENT here would crash and silently lose the dedup record.
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, paths.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CLI: harvest-dedup.mjs <logPath> [--all]  (candidate paths on stdin, one per line)
  // prints the unharvested subset. Does not append — appending happens after the
  // operator confirms the carry set (the skill calls appendHarvested separately).
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const logPath = args.find((a) => a !== '--all');
  const stdin = readFileSync(0, 'utf8');
  const candidates = stdin
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const filtered = filterUnharvested(candidates, readHarvested(logPath), all);
  for (const p of filtered) console.log(p);
}
