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

export function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch (unlinkErr) {
      if (unlinkErr?.code !== 'ENOENT') logError('write-atomic.unlink', unlinkErr, { tmp });
    }
    throw err;
  }
}
