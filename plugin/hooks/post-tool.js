#!/usr/bin/env node
// hooks/post-tool.js : coalesced post-tool dispatcher.
//
// Single Node entry replacing the four PostToolUse hooks
// (provenance, reflect-track, autolink, edge-infer). One stdin read, one snapshot load,
// fixed module order, per-module failure isolation.

import { basename, join } from 'node:path';
import { readPayload, isVaultNote } from './lib/common.mjs';
import { sessionIdFrom } from '../scripts/lib/session.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { normalizeWrites } from './lib/tool-payload.mjs';
import { runAutolink } from './modules/autolink.mjs';
import { runEdgeInfer } from './modules/edge-infer.mjs';
import { runProvenance } from './modules/provenance.mjs';
import { runReflectTrack } from './modules/reflect-track.mjs';
import { getPluginData, getVaultPath } from '../scripts/lib/config.mjs';
import { resolveMemoryDir } from '../scripts/lib/memory-paths.mjs';
import { appendMemoryWrite } from '../scripts/lib/marker-cache.mjs';
import { env } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';

// Record the CREATION of an auto-memory file against THIS session's write log,
// so stop-nudge can count what this session actually added rather than diffing
// the shared memory dir (which conflates concurrent sessions). Only `Write`
// counts: `Edit` requires the file to already exist, so it can never add one,
// and stop-nudge renders this log as "created N new memory files". Counting
// edits reported six creations to a session that had only updated six existing
// memories. Birthtime cannot stand in for the check, because an Edit rewrites
// the file and resets btime on macOS. The memory dir is
// ~/.claude/projects/<encoded-project-dir>/memory. Fail-open: any error here
// must not disturb the enrichment modules below.
//
// Known gap: a `Write` that overwrites an existing memory still counts as a
// creation. PostToolUse fires after the write, so existsSync cannot tell the
// two apart, and the session-start memory snapshot that could have was removed
// when the concurrent-session conflation was fixed.
function recordMemoryWriteIfApplicable(filePath, tool, sessionId) {
  try {
    if (!sessionId) return;
    if (tool !== 'Write') return;
    if (!filePath || !filePath.endsWith('.md')) return;
    const memoryDir = resolveMemoryDir(env.CLAUDE_PROJECT_DIR);
    if (!memoryDir) return;
    const pluginData = getPluginData();
    if (!pluginData) return;
    if (filePath !== join(memoryDir, basename(filePath))) return;
    appendMemoryWrite(pluginData, sessionId, basename(filePath));
  } catch (err) {
    logError('post-tool.recordMemoryWrite', err);
  }
}

const raw = await readPayload('post-tool');
if (!raw) process.exit(0);

const ctx = {
  tool: raw.tool_name,
  input: raw.tool_input || {},
  response: raw.tool_response,
  raw,
  // Session id for the reflect-track marker. The replay path
  // (sweep-hook-replay.mjs, /reflect Step 4.4) sets LL_REFLECT_SID to the
  // calling reflect session, since sub-agent writes can carry another id.
  // A live hook keys on its own payload: getSessionId() alone can fall back
  // to the machine-wide session/id file, which names whichever session
  // started last.
  sessionId: env.LL_REFLECT_SID || sessionIdFrom(raw) || null,
  vaultRoot: getVaultPath(),
  snapshot: null,
};

// Claude Code delivers one file per Write/Edit call. Codex delivers a whole
// apply_patch, which can touch several files at once. normalizeWrites flattens
// both into the same Write/Edit shape, so the chain below runs once per file on
// either harness and no module has to know the difference.
const writes = normalizeWrites(raw).filter((w) => w.tool !== 'Delete');

// A tool call that touches no file (Task, Agent, Skill) still records provenance.
const passes = writes.length ? writes.map((w) => ({ ...ctx, tool: w.tool, input: w })) : [ctx];

// Only autolink + edge-infer consume the snapshot, and both early-return on
// non-vault files. Gating the load on the same predicate keeps every non-vault
// Write/Edit — the common case while a vault is configured — from reading and
// parsing the multi-hundred-KB snapshot just to throw it away. One patch can
// carry several vault notes, so the load is memoised across passes.
let vaultSnapshot;
const loadSnapshotOnce = () => (vaultSnapshot ??= loadVaultSnapshot(ctx.vaultRoot));

for (const pass of passes) {
  const isWriteEdit = pass.tool === 'Write' || pass.tool === 'Edit';
  if (isWriteEdit) {
    recordMemoryWriteIfApplicable(pass.input.file_path, pass.tool, sessionIdFrom(raw));
    if (pass.vaultRoot && isVaultNote(pass.input.file_path, pass.vaultRoot)) {
      pass.snapshot = loadSnapshotOnce();
    }
  }

  // Cheap load-bearing modules first (provenance reads tool_input; reflect-track
  // appends a marker): if the outer hooks.json deadline ever SIGKILLs mid-loop,
  // only enrichment (autolink, edge-infer) is lost. Autolink stays ahead of
  // edge-infer: on the Edit path edge-infer reads the note from disk, where
  // autolink's appended links land. (On the Write path edge-infer reads
  // input.content, not disk — there the link append is only seen by replayed
  // runs, which snapshot the on-disk body into input.content.)
  const modules = isWriteEdit
    ? [runProvenance, runReflectTrack, runAutolink, runEdgeInfer]
    : [runProvenance];

  for (const mod of modules) {
    try {
      await mod(pass);
    } catch (err) {
      logError(`post-tool.${mod.name}`, err, { code: 'module_failed' });
      if (env.LL_HOOK_DEBUG) {
        process.stderr.write(`[post-tool] ${mod.name} failed: ${err.message}\n`);
      }
    }
  }
}
