#!/usr/bin/env node
// hooks/post-tool.js : coalesced post-tool dispatcher.
//
// Single Node entry replacing the three previous PostToolUse hooks
// (autolink, edge-infer, provenance). One stdin read, one snapshot load,
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
  //     resolves from the canonical getSessionId() — the same resolver the
  //     skill's bash runs via resolve-paths.mjs SESSION_ID. We must NOT use
  //     raw.session_id (the harness UUID, a different id system) or the two
  //     sides re-split and the marker silently breaks.
  //   - Replay path (sweep-hook-replay.mjs, invoked by /reflect Step 4.4 for
  //     subagent-written notes): LL_REFLECT_SID carries the CALLING reflect
  //     session's id explicitly, because getSessionId() can't attribute a write
  //     to the right session when multiple /reflect runs overlap (the unsuffixed
  //     plugin-data `id` is last-writer-wins). The skill sets it; the replay
  //     forwards it; we honor it here as the explicit override reflect-track.mjs
  //     already supports.
  sessionId: env.LL_REFLECT_SID || null,
  vaultRoot: resolveVaultPath(),
  snapshot: null,
};

const isWriteEdit = ctx.tool === 'Write' || ctx.tool === 'Edit';
if (isWriteEdit && ctx.vaultRoot) {
  ctx.snapshot = loadVaultSnapshot(ctx.vaultRoot);
}

const modules = isWriteEdit
  ? [runAutolink, runEdgeInfer, runProvenance, runReflectTrack]
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
