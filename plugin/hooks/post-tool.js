#!/usr/bin/env node
// hooks/post-tool.js : coalesced post-tool dispatcher.
//
// Single Node entry replacing the four PostToolUse hooks
// (provenance, reflect-track, autolink, edge-infer). One stdin read, one snapshot load,
// fixed module order, per-module timeout isolation.

import { basename, join } from 'node:path';
import { home, readStdin, resolveVaultPath, getSessionId, isVaultNote } from './lib/common.mjs';
import { monthStr } from '../scripts/lib/retrieval.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { normalizeWrites } from './lib/tool-payload.mjs';
import { runAutolink } from './modules/autolink.mjs';
import { runEdgeInfer } from './modules/edge-infer.mjs';
import { runProvenance } from './modules/provenance.mjs';
import { runReflectTrack } from './modules/reflect-track.mjs';
import { getPluginData } from '../scripts/lib/config.mjs';
import { encodeProjectDir } from '../scripts/lib/paths.mjs';
import { appendJsonlLineSafe } from '../scripts/lib/jsonl.mjs';
import { appendMemoryWrite } from '../scripts/lib/marker-cache.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { env } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';

// Record a Write/Edit into the auto-memory dir against THIS session's write
// log, so stop-nudge can count what this session actually wrote rather than
// diffing the shared memory dir (which conflates concurrent sessions). The
// memory dir is ~/.claude/projects/<encoded-project-dir>/memory. Fail-open:
// any error here must not disturb the enrichment modules below.
function recordMemoryWriteIfApplicable(filePath) {
  try {
    if (!filePath || !filePath.endsWith('.md')) return;
    const projectDir = env.CLAUDE_PROJECT_DIR;
    if (!projectDir) return;
    const pluginData = getPluginData();
    if (!pluginData) return;
    const encodedPath = encodeProjectDir(projectDir);
    const memoryDir = join(home(), '.claude', 'projects', encodedPath, 'memory');
    if (filePath !== join(memoryDir, basename(filePath))) return;
    let sid = getSessionId();
    if (sid === 'unknown') sid = '';
    appendMemoryWrite(pluginData, sid, basename(filePath));
  } catch (err) {
    logError('post-tool.recordMemoryWrite', err);
  }
}

function logHookError(moduleName, err) {
  const pluginData = getPluginData();
  if (!pluginData) return;
  appendJsonlLineSafe(join(pluginData, `hook-errors-${monthStr()}.jsonl`), {
    ts: new Date().toISOString(),
    module: moduleName,
    message:
      err && err.message
        ? String(err.message).slice(0, HookConfig.ERROR_MSG_MAX_CHARS)
        : String(err).slice(0, HookConfig.ERROR_MSG_MAX_CHARS),
  });
}

function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

let raw;
try {
  raw = JSON.parse(await readStdin());
} catch {
  process.exit(0);
}

const ctx = {
  tool: raw.tool_name,
  input: raw.tool_input || {},
  response: raw.tool_response,
  raw,
  // Session id for the reflect-track marker. Two cases:
  //   - Normal main-thread Write hook: null here, so reflectNewNotesPath()
  //     resolves from the canonical getSessionId(), which returns the harness
  //     $CLAUDE_CODE_SESSION_ID — the SAME id the skill's bash resolves via
  //     resolve-paths.mjs SESSION_ID (it reads the same env var, or the
  //     session/id file SessionStart stamped from it). Both sides agree by
  //     construction, so the marker meets. (raw.session_id is that same harness
  //     id; we don't need it here because getSessionId() already returns it.)
  //   - Replay path (sweep-hook-replay.mjs, invoked by /reflect Step 4.4 for
  //     subagent-written notes): LL_REFLECT_SID carries the CALLING reflect
  //     session's id explicitly. Sub-agent writes can run under a different
  //     harness session id, so the override pins the write to the reflect run's
  //     marker. The skill sets it; the replay forwards it; we honor it here as
  //     the explicit override reflect-track.mjs already supports.
  sessionId: env.LL_REFLECT_SID || null,
  vaultRoot: resolveVaultPath(),
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
    recordMemoryWriteIfApplicable(pass.input.file_path);
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
      await withTimeout(
        Promise.resolve(mod(pass)),
        HookConfig.POST_TOOL_MODULE_TIMEOUT_MS,
        mod.name,
      );
    } catch (err) {
      logHookError(mod.name, err);
      if (env.LL_HOOK_DEBUG) {
        process.stderr.write(`[post-tool] ${mod.name} failed: ${err.message}\n`);
      }
    }
  }
}
