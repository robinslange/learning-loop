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
