// Ingest fan-out policy file. Currently a no-op shim: no hook reads it (Phase 5
// of the ingest-coordinator plan was skipped after the 2026-05-15 PreToolUse-on-
// subagent probe came back indeterminate). The file is still written so that if
// pre-bash-check.js / pre-write-check.js learn to enforce policy in a future
// version, the wiring is already in place. Treat the perimeter as Layer 1
// (frontmatter `tools:` allowlist) + post-fanout audit (scripts/ingest-postfanout-audit.mjs).

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function policyPath(pluginData, sessionId) {
  return join(pluginData, `ingest-fanout-policy-${sessionId}.json`);
}

export function writePolicy(pluginData, sessionId, opts) {
  mkdirSync(pluginData, { recursive: true });
  const expiresMs = (opts.expires_at_seconds ?? 600) * 1000;
  const policy = {
    session_id: sessionId,
    fanout_active: true,
    written_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiresMs).toISOString(),
    vault_root: opts.vault_root,
    ingested_repo_slug: opts.ingested_repo_slug,
    allowed_bash_prefixes: opts.allowed_bash_prefixes,
    allowed_write_dir_prefix: opts.allowed_write_dir_prefix,
  };
  writeFileSync(policyPath(pluginData, sessionId), JSON.stringify(policy, null, 2));
  return policy;
}

export function readPolicy(pluginData, sessionId) {
  const p = policyPath(pluginData, sessionId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch { return null; }
}

export function clearPolicy(pluginData, sessionId) {
  const p = policyPath(pluginData, sessionId);
  if (existsSync(p)) try { unlinkSync(p); } catch {}
}

export function isActive(policy) {
  if (!policy || !policy.fanout_active) return false;
  if (!policy.expires_at) return false;
  return new Date(policy.expires_at).getTime() > Date.now();
}
