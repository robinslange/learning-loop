// scripts/lib/session.mjs — single source of truth for session-id resolution.
//
// Tries the ppid-suffixed marker file first (current convention), then the
// unsuffixed legacy file (compat with older sessions). An empty marker (zero
// bytes, or whitespace only) is treated as absent and skipped — an empty file
// carries no information, and downstream consumers (snapshot path resolution
// in stop-nudge.js) want to fall through to the next candidate. Returns
// 'unknown' when nothing usable is found — expected outside a Claude Code
// session (CLI, cron, tests). Only logs when a file *exists* but cannot be
// read (perms, IO).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logError } from './log.mjs';

export function getSessionId() {
  const tmp = tmpdir();
  const candidates = [
    join(tmp, `learning-loop-session-id-${process.ppid}`),
    join(tmp, 'learning-loop-session-id'),
  ];
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
