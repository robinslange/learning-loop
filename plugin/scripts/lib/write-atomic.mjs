// scripts/lib/write-atomic.mjs : replace a file so a reader sees the old
// contents or the new, never a torn write.
//
// The tmp name carries the pid and a random suffix, so two writers on one
// path never share a tmp file even outside a lock. A write that throws takes
// its tmp file with it. A process killed between write and rename still
// orphans one; session-ledger.js sweeps those in the vault.

import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { logError } from './log.mjs';
import { syncSleep } from './file-lock.mjs';

// Windows refuses to rename over a file another process has open, or one a
// concurrent rename has just replaced, with EPERM, EACCES or EBUSY. Both
// clear within milliseconds, so the rename backs off and retries, as
// graceful-fs does, for about half a second at most.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 10;

function renameOver(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const retry =
        process.platform === 'win32' &&
        RENAME_RETRY_CODES.has(err.code) &&
        attempt < RENAME_ATTEMPTS;
      if (!retry) throw err;
      syncSleep(10 * attempt);
    }
  }
}

export function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameOver(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch (unlinkErr) {
      if (unlinkErr?.code !== 'ENOENT') logError('write-atomic.unlink', unlinkErr, { tmp });
    }
    throw err;
  }
}
