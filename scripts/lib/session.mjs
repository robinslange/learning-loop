// scripts/lib/session.mjs — single source of truth for session-id resolution.
//
// Resolution order, first non-empty wins:
//   1. plugin-data/session/id-<ppid>   (env-independent, ppid-keyed)
//   2. plugin-data/session/id          (env-independent, last-writer-wins)
//   3. <tmpdir>/learning-loop-session-id-<ppid>   (legacy tmp, ppid-keyed)
//   4. <tmpdir>/learning-loop-session-id          (legacy tmp, unsuffixed)
//
// The plugin-data candidates come FIRST because they are env-INdependent:
// os.tmpdir() honors $TMPDIR, which a hook subprocess does NOT inherit but the
// interactive shell DOES, so the legacy tmp files made the SAME session resolve
// different ids (or 'unknown') depending on which process asked — breaking any
// handshake that straddled the hook/shell boundary (e.g. /reflect Step 4).
// plugin-data resolves identically in every subprocess. The tmp candidates are
// retained as a fallback for sessions started before this change (or when
// plugin-data can't be resolved).
//
// An empty marker (zero bytes, or whitespace only) is treated as absent and
// skipped. Returns 'unknown' when nothing usable is found — expected outside a
// Claude Code session (CLI, cron, tests). Only logs when a file *exists* but
// cannot be read (perms, IO).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logError } from './log.mjs';
import { resolvePluginData } from './config.mjs';
import { DATA_PATHS } from './paths.mjs';

export function getSessionId() {
  const tmp = tmpdir();
  const candidates = [];
  const pd = resolvePluginData();
  if (pd) {
    const sessionDir = DATA_PATHS.session(pd);
    candidates.push(join(sessionDir, `id-${process.ppid}`), join(sessionDir, 'id'));
  }
  candidates.push(
    join(tmp, `learning-loop-session-id-${process.ppid}`),
    join(tmp, 'learning-loop-session-id'),
  );
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    } catch (err) {
      logError('lib.session.getSessionId', err, { path });
    }
  }
  return 'unknown';
}
