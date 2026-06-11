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

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSessionId, resolvePluginData, vaultRelPath } from '../lib/common.mjs';
import { DATA_PATHS } from '../../scripts/lib/paths.mjs';

// Mirror the exact path expansion used by skills/reflect/SKILL.md Step 4.
// Any drift here silently breaks the handshake: the hook would write to
// one path and the skill would read another.
//
// Anchor: the marker dir is plugin-data/reflect-scratch — NOT tmp. os.tmpdir()
// honors $TMPDIR, and a hook subprocess does NOT inherit the interactive shell's
// $TMPDIR, so a tmp anchor put the writer (hook, $TMPDIR unset → /tmp) and the
// reader (skill bash, $TMPDIR=/tmp/claude-501) in different dirs → empty marker,
// refinement silently skipped, no error. plugin-data resolves identically in
// both processes (getPluginData() reads $CLAUDE_PLUGIN_DATA or its persisted
// marker file), so both sides meet. Only when plugin-data can't be resolved
// (bare CLI/test) do we fall back to tmpdir() — acceptable since the skill isn't
// running there. Both sides resolve the dir the same way: this hook via
// reflectScratchDir(), the skill's bash via resolve-paths.mjs PLUGIN_DATA.
//
// Session id keys the file within that dir, via the canonical getSessionId()
// (the same resolver the skill runs through resolve-paths.mjs SESSION_ID). An
// explicit `sessionId` arg still wins for tests/direct callers; getSessionId()
// returns the 'unknown' sentinel outside a Claude Code session.
export function reflectScratchDir() {
  const pd = resolvePluginData();
  return pd ? DATA_PATHS.reflectScratch(pd) : tmpdir();
}

export function reflectNewNotesPath(sessionId) {
  const sid = sessionId || getSessionId();
  return join(reflectScratchDir(), `ll-${sid}-reflect-new-notes.txt`);
}

export function runReflectTrack(ctx) {
  const { tool, input, vaultRoot, sessionId } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!vaultRoot) return;
  if (!input || !input.file_path) return;

  const rel = vaultRelPath(input.file_path, vaultRoot);
  if (!rel) return;

  // sessionId is honored only as an explicit override (tests/direct callers);
  // in production it is undefined here so the path resolves from getSessionId()
  // — the same resolver the skill's bash runs via resolve-paths.mjs SESSION_ID.
  const marker = reflectNewNotesPath(sessionId);
  if (!existsSync(marker)) return;

  appendFileSync(marker, input.file_path + '\n');
}
