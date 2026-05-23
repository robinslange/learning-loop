// scripts/lib/session.mjs — single source of truth for session-id resolution.
//
// Tries the ppid-suffixed marker file first (current convention), then the
// unsuffixed legacy file (compat with older sessions). Returns 'unknown' when
// neither is present — expected outside a Claude Code session (CLI, cron,
// tests). Only logs when a file *exists* but cannot be read (perms, IO).

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
      return readFileSync(path, 'utf8').trim();
    } catch (err) {
      logError('lib.session.getSessionId', err, { path });
    }
  }
  return 'unknown';
}
