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

import { openSync, writeSync, readSync, closeSync, mkdirSync, fstatSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendJsonlLine(path, obj) {
  const line = JSON.stringify(obj) + '\n';
  try {
    mkdirSync(dirname(path), { recursive: true });
    // eslint-disable-next-line learning-loop/no-empty-catch -- dir already exists or is uncreatable; the openSync below surfaces the real failure.
  } catch {}
  let fd;
  try {
    fd = openSync(path, 'a');
    writeSync(fd, line);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        // eslint-disable-next-line learning-loop/no-empty-catch -- fd already gone; nothing left to close.
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

// Read at most maxBytes from the end of a file, opened/seeked/closed once.
// Shared by every caller that needs a bounded tail of an append-only file
// instead of loading the whole thing (provenance's lastLine below, and the
// shadow-injection / otel-error-log health checks). Returns { text: '',
// truncated: false } on an empty or unreadable file (missing, permission
// denied, etc.).
//
// size and the read both come from the same fd (one fstatSync, one readSync
// between open and close), so `truncated` reflects the file's length at the
// moment of this read. A caller that stats the file separately before
// calling in can observe a size that has already grown by the time the read
// happens, understating truncation and letting a partial first line through.
export function readTailBytes(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return { text: '', truncated: false };
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } catch {
    return { text: '', truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        // eslint-disable-next-line learning-loop/no-empty-catch -- fd already gone; nothing left to close.
      } catch {}
    }
  }
}

// Provenance files are append-only and can grow to multi-MB; this reads at
// most TAIL_BYTES from the end, which comfortably covers one JSON line.
const TAIL_BYTES = 8192;

// Test seam only: counts calls to lastLine, so a test can assert the disk
// tail-read happens at most once per path per process rather than on every
// deduped append. See _dedupeStats/_resetDedupeCache below.
let lastLineCalls = 0;

function lastLine(path) {
  lastLineCalls++;
  const lines = readTailBytes(path, TAIL_BYTES).text.split('\n').filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

// Consecutive-duplicate suppression for provenance emitters only (not a
// general JSONL policy -- other callers of appendJsonlLine, e.g. retrieval
// logs, keep unconditional-append semantics). Provenance records always
// carry a fresh `ts` on every emit, so two calls with an otherwise-identical
// caller payload never produce byte-identical JSON; comparison excludes `ts`
// and compares the rest of the record.
//
// Compares against the last record THIS PROCESS wrote (see lastWritten
// below), falling back to a disk read only when this process has not
// written to `path` yet: the hook path is one long-lived node process across
// many calls, so its own last write already is the tail. provenance-emit.js
// runs as a fresh subprocess per call and reads disk exactly once, then
// dedupes in-memory for any later call in that same process.
const DUP_WINDOW_MS = 2000;

// Provenance fan-out actions are exempt from dedup. A uniform parallel
// dispatch emits byte-identical payloads bar `ts`: three Explore agents with
// the same description (agent-spawn), one skill invoked twice (skill-invoke),
// two subagents finishing (agent-result, whose session_id/transcript_path are
// identical across the session). None carries a field that separates one call
// from the next, so fingerprint dedup would collapse a real fan-out into one
// line and undercount volume in the provenance report. Both emitters
// (common.mjs and provenance.mjs) write the SAME events-*.jsonl stream; what
// dedup still guards is every non-exempt action on it (score, session-start,
// verify, vault-write, ...), where a repeated identical payload is a genuine
// consecutive double-emit, not distinct concurrent work — the live log shows
// thousands of those against a handful of exempt-action pairs.
const DEDUP_EXEMPT_ACTIONS = new Set([
  'agent-result',
  'agent-spawn',
  'skill-invoke',
  'session-summary',
]);

// path -> { fingerprint, at } of the last record this process wrote via
// appendJsonlLineDeduped. Seeded from disk on first use per path (see
// lastRecord), then kept current in-process so later calls never tail the
// file again.
//
// Paths are monthly stream files, so in practice this holds a handful of
// entries -- capped anyway, evicting the oldest inserted key (Map preserves
// insertion order), so a process that somehow churns through many distinct
// paths cannot grow this without bound.
const LAST_WRITTEN_MAX = 32;
const lastWritten = new Map();

function rememberLastWritten(path, value) {
  lastWritten.delete(path); // re-insert at the end, marking it most-recent
  lastWritten.set(path, value);
  if (lastWritten.size > LAST_WRITTEN_MAX) {
    lastWritten.delete(lastWritten.keys().next().value);
  }
}

function lastRecord(path) {
  const cached = lastWritten.get(path);
  if (cached !== undefined) return cached;
  const prev = lastLine(path);
  if (prev === null) return null;
  try {
    const parsed = JSON.parse(prev);
    const { ts: prevTs, ...prevRest } = parsed;
    const seeded = { fingerprint: JSON.stringify(prevRest), at: Date.parse(prevTs) };
    rememberLastWritten(path, seeded);
    return seeded;
  } catch {
    return null;
  }
}

export function appendJsonlLineDeduped(path, record, now = Date.now()) {
  if (DEDUP_EXEMPT_ACTIONS.has(record.action)) {
    appendJsonlLine(path, record);
    return true;
  }
  const { ts: _ts, ...rest } = record;
  const fingerprint = JSON.stringify(rest);
  const prev = lastRecord(path);
  if (
    prev !== null &&
    prev.fingerprint === fingerprint &&
    Number.isFinite(prev.at) &&
    now - prev.at < DUP_WINDOW_MS
  ) {
    return false;
  }
  appendJsonlLine(path, record);
  rememberLastWritten(path, { fingerprint, at: now });
  return true;
}

// Test seam only: clears the in-memory dedup cache and lastLine call count,
// so a test can start each case from a clean slate without the module being
// reloaded per-file (dedup.mjs is a singleton within a process by design).
export function _resetDedupeCache() {
  lastWritten.clear();
  lastLineCalls = 0;
}

// Test seam only: how many times lastLine has actually tailed the file since
// the last _resetDedupeCache(), proving the in-memory fingerprint is what
// answers repeat calls, not a fresh disk read every time.
export function _dedupeStats() {
  return { lastLineCalls };
}

// Test seam only: current size of the bounded lastWritten cache.
export function _lastWrittenSize() {
  return lastWritten.size;
}
