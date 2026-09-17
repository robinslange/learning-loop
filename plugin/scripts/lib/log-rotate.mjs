import { statSync, openSync, readSync, writeFileSync, closeSync } from 'node:fs';
import { logError } from './log.mjs';

// watch.log is the daemon's stdout and stderr, opened 'a' and never closed by
// anything that would bound it. Its only reader tails the last few lines after
// a failed start, so history has a short half-life and the head is the part
// worth losing. Called at daemon start, which is the one moment nothing holds
// a write handle, so a rewrite here cannot interleave with the daemon's own
// output. Best-effort: a log that cannot be capped is not worth failing a
// daemon start over.
export function capLogFile(path, maxBytes) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  const keep = Math.floor(maxBytes / 2);
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(keep);
    readSync(fd, buf, 0, keep, size - keep);
    closeSync(fd);
    fd = undefined;
    // The read starts mid-line. Drop that fragment so the file never opens on
    // half a record.
    const text = buf.toString('utf-8');
    const nl = text.indexOf('\n');
    writeFileSync(path, nl === -1 ? '' : text.slice(nl + 1));
  } catch (err) {
    logError('lib.log-rotate.capLogFile', err);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
