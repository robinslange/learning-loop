#!/usr/bin/env node
// hooks/post-tool.js : coalesced post-tool dispatcher.
//
// Single Node entry replacing the four PostToolUse hooks
// (provenance, reflect-track, autolink, edge-infer). One stdin read, one snapshot load,
// fixed module order, per-module timeout isolation.

import { join } from 'node:path';
import { readStdin, resolveVaultPath } from './lib/common.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { runAutolink } from './modules/autolink.mjs';
import { runEdgeInfer } from './modules/edge-infer.mjs';
import { runProvenance } from './modules/provenance.mjs';
import { runReflectTrack } from './modules/reflect-track.mjs';
import { getPluginData } from '../scripts/lib/config.mjs';
import { appendJsonlLineSafe } from '../scripts/lib/jsonl.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { env } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';

function logHookError(moduleName, err) {
  const pluginData = getPluginData();
  if (!pluginData) return;
  const month = new Date().toISOString().slice(0, 7);
  appendJsonlLineSafe(join(pluginData, `hook-errors-${month}.jsonl`), {
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

const isWriteEdit = ctx.tool === 'Write' || ctx.tool === 'Edit';
if (isWriteEdit && ctx.vaultRoot) {
  ctx.snapshot = loadVaultSnapshot(ctx.vaultRoot);
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
    await withTimeout(Promise.resolve(mod(ctx)), HookConfig.POST_TOOL_MODULE_TIMEOUT_MS, mod.name);
  } catch (err) {
    logHookError(mod.name, err);
    if (env.LL_HOOK_DEBUG) {
      process.stderr.write(`[post-tool] ${mod.name} failed: ${err.message}\n`);
    }
  }
}
