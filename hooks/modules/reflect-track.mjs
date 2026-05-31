// hooks/modules/reflect-track.mjs : per-write tracking for /reflect Step 4.
//
// Handshake with skills/reflect/SKILL.md Step 4:
//   - Step 4 init creates an empty marker file at the session-keyed path
//     ${TMPDIR:-/tmp}/ll-${LL_SID:-session}-reflect-new-notes.txt, where LL_SID
//     is read from the plugin's own ${TMPDIR:-/tmp}/learning-loop-session-id
//     file (written once at SessionStart). The skill's bash reads that file via
//     `cat`; this hook reads the same file (see reflectNewNotesPath below) so
//     the two sides resolve the identical path regardless of which harness env
//     vars a given subprocess happens to inherit.
//   - For every vault Write/Edit that fires during the marker's lifetime,
//     this module appends the absolute file path + newline.
//   - Step 4.6.g `rm -f` deletes the marker, ending the tracking window.
//
// The marker file's existence is the entire signal. No ambient state, no
// timestamps, no cross-process locks. `appendFileSync` with implicit
// O_APPEND is atomic per write on POSIX, so concurrent hook invocations
// from sub-agent sweeps don't corrupt lines.
//
// Background: an earlier revision of Step 4 required the agent to run
// `echo "$PATH" >> "$FILE"` after every Write. The init and per-write
// commands lived in the same fenced bash block, so agents naturally
// re-ran the whole block per write — re-truncating each time and leaving
// only the last entry. Moving the work into the hook removes the
// footgun entirely (see tests/reflect-new-notes-track.test.mjs).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vaultRelPath } from '../lib/common.mjs';

// Mirror the exact path expansion used by skills/reflect/SKILL.md Step 4.
// Any drift here silently breaks the handshake: the hook would write to
// one path and the skill would read another.
//
// Session id: the marker is keyed on the plugin's own session id, written
// once at SessionStart to the unsuffixed `learning-loop-session-id` file
// (hooks/session-start/vault-snapshot.mjs). Both sides of the handshake read
// THAT file: the skill's bash via `cat`, this hook via readSessionIdFile()
// below. They must agree on the same harness-independent source — an earlier
// design split them (skill on $CLAUDE_CODE_SESSION_ID, hook on the stdin
// payload's session_id), but those are harness UUIDs, NOT the plugin's own id,
// and the sweep-replay payload carries no session_id at all — so the marker
// paths diverged and the handshake broke silently (empty marker, no error).
// An explicit `sessionId` arg still wins for tests/direct callers; 'session'
// is the last resort when the file is missing (CLI/cron/tests). TMPDIR is read
// from process.env directly (not the frozen env snapshot) so it tracks
// per-session and per-test overrides.
function tmpDir() {
  // eslint-disable-next-line learning-loop/no-process-env-outside-env-module
  return process.env.TMPDIR || tmpdir();
}

function readSessionIdFile() {
  const path = join(tmpDir(), 'learning-loop-session-id');
  if (!existsSync(path)) return null;
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function reflectNewNotesPath(sessionId) {
  const sid = sessionId || readSessionIdFile() || 'session';
  return join(tmpDir(), `ll-${sid}-reflect-new-notes.txt`);
}

export function runReflectTrack(ctx) {
  const { tool, input, vaultRoot, sessionId } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!vaultRoot) return;
  if (!input || !input.file_path) return;

  const rel = vaultRelPath(input.file_path, vaultRoot);
  if (!rel) return;

  // sessionId is honored only as an explicit override (tests/direct callers);
  // in production it is undefined here so the path resolves from the shared
  // learning-loop-session-id file — the same source the skill's bash reads.
  const marker = reflectNewNotesPath(sessionId);
  if (!existsSync(marker)) return;

  appendFileSync(marker, input.file_path + '\n');
}
