// scripts/lib/is-main.mjs : was this module EXECUTED, or merely imported?
//
// One spelling, because there were three. Node resolves an ESM entry to its
// REALPATH for `import.meta.url`, while `process.argv[1]` keeps whatever path
// the caller spelled. So the naive comparison is false under any symlinked
// install -- a dotfile-managed ~/.claude, or a dev install pointing at a
// checkout -- and what happens next depends entirely on what the module is:
//
//   a CLI script  -> the command quietly does nothing, which is visible
//   a hook        -> the gate exits 0 having checked nothing, which is not
//
// The second one shipped. pre-write-check's guard was false under a symlink,
// so the write gate admitted every contract violation and reported success.
//
// The three spellings this replaces, for anyone auditing the rest of the tree:
// scripts/codex/generate-agents.mjs realpaths both sides (correct);
// scripts/provenance.mjs realpaths only argv[1] and compares it against a
// non-realpathed import.meta.url (still wrong under a symlink); and most of
// scripts/ realpaths neither. Converting those is a separate pass -- there the
// failure is a silent no-op rather than a disabled guard.

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True when `importMetaUrl`'s module is the entry point of this process.
 * @param {string} importMetaUrl  the caller's own `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    // Only reachable when realpathSync throws, which is ENOENT or EACCES: this
    // file or argv[1] deleted, renamed, or made unreadable mid-run. The
    // unresolved comparison is the one a symlinked install already fails, so
    // this errs toward NOT running -- the dangerous direction, accepted only
    // because reaching it requires the process to be dismantled underneath
    // itself. It is a last gasp, not a safety net.
    return importMetaUrl === pathToFileURL(process.argv[1]).href;
  }
}
