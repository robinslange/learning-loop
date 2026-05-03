#!/usr/bin/env node
// hooks/post-tool.js : coalesced post-tool dispatcher.
//
// Single Node entry replacing the three previous PostToolUse hooks
// (autolink, edge-infer, provenance). One stdin read, one snapshot load,
// fixed module order, per-module try/catch isolation.

import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, resolveVaultPath } from './lib/common.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { runAutolink } from './modules/autolink.mjs';
import { runEdgeInfer } from './modules/edge-infer.mjs';
import { runProvenance } from './modules/provenance.mjs';
import { getPluginData } from '../scripts/lib/config.mjs';

function logHookError(moduleName, err) {
  const pluginData = getPluginData();
  if (!pluginData) return;
  const month = new Date().toISOString().slice(0, 7);
  const path = join(pluginData, `hook-errors-${month}.jsonl`);
  const entry =
    JSON.stringify({
      ts: new Date().toISOString(),
      module: moduleName,
      message: err && err.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
    }) + '\n';
  try {
    const fd = openSync(path, 'a');
    writeSync(fd, entry);
    closeSync(fd);
  } catch {}
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
  vaultRoot: resolveVaultPath(),
  snapshot: null,
};

const isWriteEdit = ctx.tool === 'Write' || ctx.tool === 'Edit';
if (isWriteEdit && ctx.vaultRoot) {
  ctx.snapshot = loadVaultSnapshot(ctx.vaultRoot);
}

const modules = isWriteEdit ? [runAutolink, runEdgeInfer, runProvenance] : [runProvenance];

for (const mod of modules) {
  try {
    await mod(ctx);
  } catch (err) {
    logHookError(mod.name, err);
    if (process.env.LL_HOOK_DEBUG === '1') {
      process.stderr.write(`[post-tool] ${mod.name} failed: ${err.message}\n`);
    }
  }
}
