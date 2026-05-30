// hooks/modules/reflect-track.mjs : per-write tracking for /reflect Step 4.
//
// Handshake with skills/reflect/SKILL.md Step 4:
//   - Step 4 init creates an empty marker file at the session-keyed path
//     ${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-reflect-new-notes.txt.
//     The skill's bash resolves the session id from $CLAUDE_CODE_SESSION_ID;
//     this hook resolves it from the stdin payload's `session_id` (see
//     reflectNewNotesPath below) so the two sides agree even when the hook
//     subprocess doesn't inherit the env var.
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

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vaultRelPath } from '../lib/common.mjs';

// Mirror the exact path expansion used by skills/reflect/SKILL.md Step 4.
// Any drift here silently breaks the handshake: the hook would write to
// one path and the skill would read another.
//
// Session id: the skill's bash runs in the Bash tool, which reliably has
// $CLAUDE_CODE_SESSION_ID. This hook runs in a PostToolUse subprocess, which
// does NOT reliably inherit that env var — when it's absent the old code fell
// back to the literal 'session', wrote to a path the skill never read, and the
// handshake broke silently (empty marker, no error). The harness DOES pass the
// real id as `session_id` in the hook's stdin payload, so we prefer that
// (threaded in as the `sessionId` argument). Env var stays as a fallback for
// direct/legacy callers; 'session' is the last resort. TMPDIR is read from
// process.env directly (not the frozen env snapshot) so it tracks per-session
// and per-test overrides.
export function reflectNewNotesPath(sessionId) {
  const tmp = process.env.TMPDIR || tmpdir();
  const sid = sessionId || process.env.CLAUDE_CODE_SESSION_ID || 'session';
  return join(tmp, `ll-${sid}-reflect-new-notes.txt`);
}

export function runReflectTrack(ctx) {
  const { tool, input, vaultRoot, sessionId } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!vaultRoot) return;
  if (!input || !input.file_path) return;

  const rel = vaultRelPath(input.file_path, vaultRoot);
  if (!rel) return;

  const marker = reflectNewNotesPath(sessionId);
  if (!existsSync(marker)) return;

  appendFileSync(marker, input.file_path + '\n');
}
