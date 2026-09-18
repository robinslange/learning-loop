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
    // The read starts mid-line, so drop that fragment and open on a whole
    // record. If the retained tail has no newline in it at all -- one very
    // long line, or a daemon killed mid-write -- there is no whole record to
    // find, and dropping to the first newline would write an empty file. That
    // destroys exactly the output the caller reads after a failed start, so
    // the fragment is kept instead: opening mid-line is the smaller loss.
    // A multibyte character split by the byte-offset read decodes to one
    // replacement char at the head, which is likewise better than no log.
    const text = buf.toString('utf-8');
    const nl = text.indexOf('\n');
    writeFileSync(path, nl === -1 ? text : text.slice(nl + 1));
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
