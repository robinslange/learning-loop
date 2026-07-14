// scripts/lib/jsonl.mjs : single-writer JSONL append helper.
//
// Atomic-ish line append for line-buffered telemetry files. Uses openSync('a')
// + writeSync + closeSync so the kernel writes the full line in one syscall.
// On POSIX this is atomic up to PIPE_BUF (4 KB) for a regular file in O_APPEND
// mode; concurrent writers cannot interleave bytes within a single line.
// fs.appendFileSync, in contrast, uses multiple syscalls under the hood and
// is not atomic on Windows (multiple sessions can interleave bytes mid-line
// and break downstream JSON.parse).
//
// Use this helper for every JSONL telemetry append (provenance, retrieval
// logs, librarian logs, hook errors, retraction outbox). Do not use it for
// markdown body appends in vault notes; those have different consistency
// requirements (handled by snapshot.mjs and the daemon).

import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendJsonlLine(path, obj) {
  const line = JSON.stringify(obj) + '\n';
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {}
  let fd;
  try {
    fd = openSync(path, 'a');
    writeSync(fd, line);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function appendJsonlLineSafe(path, obj) {
  try {
    appendJsonlLine(path, obj);
    return true;
  } catch {
    return false;
  }
}
