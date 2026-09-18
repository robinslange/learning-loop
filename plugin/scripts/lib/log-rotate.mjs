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
  // At maxBytes <= 3 the halving floors to 0, and a 0-byte read writes an empty
  // file: the cap would delete the log rather than bound it. Unreachable at the
  // shipped 4 MiB, but the function takes maxBytes as an argument.
  if (keep < 1) return;
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(keep);
    readSync(fd, buf, 0, keep, size - keep);
    closeSync(fd);
    fd = undefined;
    // The read starts mid-line, so drop that fragment and open on a whole
    // record. Two shapes leave no whole record to open on: no newline at all
    // (one very long line, or a daemon killed mid-write), and a newline that
    // is the final byte. Both slice to nothing, and writing that destroys
    // exactly the output the caller reads after a failed start, so the buffer
    // is kept whole instead: opening mid-line is the smaller loss.
    //
    // Searched and sliced on the Buffer, not on a decoded string, for two
    // reasons rather than one. watch.log is raw daemon stdout and stderr, so
    // an invalid byte decodes to a 3-byte U+FFFD: 5000 bytes of 0xFF against a
    // 1024 cap wrote 1536, breaking the bound the caller asked for and the
    // tests assert. And the byte-offset read can split a multibyte character,
    // which as bytes stays one truncated character at the head rather than
    // becoming a replacement char that then costs more than it replaced.
    const nl = buf.indexOf(0x0a);
    writeFileSync(path, nl === -1 || nl === buf.length - 1 ? buf : buf.subarray(nl + 1));
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
