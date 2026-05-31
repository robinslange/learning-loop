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
  // Intentionally NOT raw.session_id: the reflect-track handshake keys the
  // marker on the plugin's own id (the unsuffixed learning-loop-session-id
  // file), which the skill's bash also reads. raw.session_id is the harness
  // UUID — a different id system — so threading it here would re-split the two
  // sides and silently break the marker. Leaving sessionId null lets
  // reflectNewNotesPath() resolve from the shared file.
  sessionId: null,
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
