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

// Read the last complete line of a file without loading the whole thing.
// Provenance files are append-only and can grow to multi-MB; this reads at
// most TAIL_BYTES from the end, which comfortably covers one JSON line.
const TAIL_BYTES = 8192;

function lastLine(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// Consecutive-duplicate suppression for provenance emitters only (not a
// general JSONL policy -- other callers of appendJsonlLine, e.g. retrieval
// logs, keep unconditional-append semantics). Provenance records always
// carry a fresh `ts` on every emit, so two calls with an otherwise-identical
// caller payload never produce byte-identical JSON; comparison excludes `ts`
// and compares the rest of the record.
//
// Compares against the LAST LINE ALREADY ON DISK (not in-memory state):
// provenance-emit.js runs as a fresh subprocess per call, so an in-memory
// cache would never see across calls. Reading the file tail is the only
// dedup check that works for both the in-process hook path and the
// per-invocation CLI path.
const DUP_WINDOW_MS = 2000;

// agent-result records (emitted from subagent-stop.js on the SubagentStop
// hook event) carry only { action, session_id, transcript_path } -- and
// session_id/transcript_path are identical across every subagent in a
// session, so the record has no field that distinguishes one subagent's
// completion from another's. Two real, distinct subagents finishing within
// the dedup window (the modal case for parallel dispatch) would fingerprint
// identically and the second would be wrongly dropped. Every other action
// type carries a discriminating field (target, subagent_type, skill name,
// ...), so this exemption is scoped to agent-result specifically rather than
// weakening dedup generally.
export function appendJsonlLineDeduped(path, record, now = Date.now()) {
  if (record.action === 'agent-result') {
    appendJsonlLine(path, record);
    return true;
  }
  const { ts: _ts, ...rest } = record;
  const fingerprint = JSON.stringify(rest);
  const prev = lastLine(path);
  if (prev !== null) {
    try {
      const parsed = JSON.parse(prev);
      const { ts: prevTs, ...prevRest } = parsed;
      const prevAt = Date.parse(prevTs);
      if (
        JSON.stringify(prevRest) === fingerprint &&
        Number.isFinite(prevAt) &&
        now - prevAt < DUP_WINDOW_MS
      ) {
        return false;
      }
    } catch {
      // Malformed last line: fall through and append normally.
    }
  }
  appendJsonlLine(path, record);
  return true;
}
