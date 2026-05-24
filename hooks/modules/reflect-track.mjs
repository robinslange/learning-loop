// hooks/modules/reflect-track.mjs : per-write tracking for /reflect Step 4.
//
// Handshake with skills/reflect/SKILL.md Step 4:
//   - Step 4 init creates an empty marker file at the session-keyed path
//     ${TMPDIR:-/tmp}/ll-${CLAUDE_SESSION_ID:-session}-reflect-new-notes.txt.
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
// one path and the skill would read another. We read process.env directly
// (rather than the frozen `env` snapshot from scripts/lib/env.mjs) because
// TMPDIR and CLAUDE_SESSION_ID can vary per session and per test — the
// snapshot would lock us to whatever the test runner saw at import time.
export function reflectNewNotesPath() {
  const tmp = process.env.TMPDIR || tmpdir();
  const sid = process.env.CLAUDE_SESSION_ID || 'session';
  return join(tmp, `ll-${sid}-reflect-new-notes.txt`);
}

export function runReflectTrack(ctx) {
  const { tool, input, vaultRoot } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!vaultRoot) return;
  if (!input || !input.file_path) return;

  const rel = vaultRelPath(input.file_path, vaultRoot);
  if (!rel) return;

  const marker = reflectNewNotesPath();
  if (!existsSync(marker)) return;

  appendFileSync(marker, input.file_path + '\n');
}
