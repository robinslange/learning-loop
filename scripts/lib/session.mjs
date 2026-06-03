// scripts/lib/session.mjs — single source of truth for session-id resolution.
//
// Resolution order, first non-empty wins:
//   0. $CLAUDE_CODE_SESSION_ID   (the harness session id — canonical)
//   1. plugin-data/session/id    (env-independent, persisted at SessionStart)
//   2. <tmpdir>/learning-loop-session-id   (legacy tmp, unsuffixed)
//
// The harness id comes FIRST and is the real key. It is the ONLY id that is
// identical across every process in a session — the SessionStart hook, the
// post-tool hook, the skill's bash-spawned node, and sub-agents all inherit the
// same $CLAUDE_CODE_SESSION_ID — and it is independent of both $TMPDIR and
// process.ppid. The reflect Step-4 marker handshake straddles the hook/shell
// boundary, so it needs an id that both sides compute identically; this is it.
//
// History — why NOT ppid: an earlier revision keyed candidates on process.ppid
// (plugin-data/session/id-<ppid>, tmp/...-<ppid>) "for per-session isolation".
// But ppid is the IMMEDIATE parent and differs per process (a hook's parent is
// the harness; the skill's node's parent is its bash), so the writer and reader
// never shared a ppid file — they only met by falling through to the unsuffixed
// `id`. Worse, id-<ppid> files accumulated forever (ppids are reused across
// sessions) and a stale one shadowed the real id, re-splitting the handshake.
// The harness id removes ppid from the equation entirely; the ppid candidates
// are gone. plugin-data/session/id (last-writer-wins) and the legacy tmp file
// remain only as fallbacks for environments where the harness var is unset.
//
// An empty value (zero bytes, or whitespace only — including a blank env var) is
// treated as absent and skipped. Returns 'unknown' when nothing usable is found
// — expected outside a Claude Code session (CLI, cron, tests). Only logs when a
// file *exists* but cannot be read (perms, IO).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logError } from './log.mjs';
import { resolvePluginData } from './config.mjs';
import { DATA_PATHS } from './paths.mjs';

export function getSessionId() {
  const harness = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (harness) return harness;

  const candidates = [];
  const pd = resolvePluginData();
  if (pd) candidates.push(join(DATA_PATHS.session(pd), 'id'));
  candidates.push(join(tmpdir(), 'learning-loop-session-id'));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    } catch (err) {
      logError('lib.session.getSessionId', err, { path });
    }
  }
  return 'unknown';
}
