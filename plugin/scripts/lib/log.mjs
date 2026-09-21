// scripts/lib/log.mjs : structured stderr logging for hooks and scripts.
//
// All output goes to stderr (hook stdout is the contract surface for Claude
// Code). Each line is a single JSON object so tests can grep + parse; humans
// can tail with jq. Error-level records ALSO go to a durable sink file
// (PLUGIN_DATA/logs/log-YYYY-MM.jsonl) since stderr evaporates once the
// process exits and nothing else was reading it.
//
// The module deliberately swallows its own write errors -- losing a log line
// must never crash a hook.
//
// debug() is gated on env.LL_HOOK_DEBUG. logError() and info() always emit.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.mjs';
import { pluginId } from './plugin-meta.mjs';
import { appendJsonlLine } from './jsonl.mjs';
import { DATA_PATHS } from './paths.mjs';

function monthStr(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Reads env.CLAUDE_PLUGIN_DATA directly rather than config.mjs's
// getPluginData()/pluginDataExists(): config.mjs imports logError from this
// module, so importing it back here would be a cycle. This misses config.mjs's
// legacy marker-file fallback, but that fallback exists for CLI/cron paths
// without the env var set; a hook process (the hot path this sink serves)
// always has CLAUDE_PLUGIN_DATA set by the harness.
function sinkPluginData() {
  const pd = env.CLAUDE_PLUGIN_DATA;
  return pd && existsSync(pd) ? pd : null;
}

// Compatibility copy for callers that carry a `code`: pre-write-check's
// duplicate-gate issues and post-tool's module failures used to hand-roll this
// exact record into hook-errors-YYYY-MM.jsonl themselves. quick.mjs's
// duplicate-gate health check (health-checks/quick.mjs:695-735) still reads
// that file and matches on `code`, and existing installs carry months of it,
// so logError keeps writing it rather than migrating readers to the new sink.
function hookErrorsCompatLine(pd, line) {
  const { scope, msg, meta } = line;
  const { code, source, err, ...rest } = meta;
  if (code === undefined) return;
  appendJsonlLine(join(pd, `hook-errors-${monthStr()}.jsonl`), {
    ts: line.ts,
    module: scope,
    code,
    source,
    message: msg,
    ...rest,
  });
}

// Best-effort durable copy of an error record. Never throws: a sink failure
// (missing dir, full disk, permissions) must degrade to stderr-only, silently.
// This is one of the three files excluded from no-empty-catch precisely
// because it is an error-absorbing boundary; see rules/no-empty-catch.mjs.
function sink(line) {
  try {
    const pd = sinkPluginData();
    if (!pd) return;
    appendJsonlLine(join(DATA_PATHS.logs(pd), `log-${monthStr()}.jsonl`), line);
    if (line.meta) hookErrorsCompatLine(pd, line);
  } catch {}
}

function safePluginId() {
  try {
    return pluginId();
  } catch {
    return 'learning-loop@unknown';
  }
}

function emit(level, scope, msg, meta) {
  try {
    const line = {
      ts: new Date().toISOString(),
      level,
      plugin: safePluginId(),
      scope,
      msg,
    };
    if (meta !== undefined && meta !== null && typeof meta === 'object') {
      Object.assign(line, { meta });
    }
    process.stderr.write(JSON.stringify(line) + '\n');
    if (level === 'error') sink(line);
  } catch {
    // Defensive fallback: write a minimal plain-text line when JSON.stringify
    // fails (e.g. circular references in meta) or stderr is unavailable.
    try {
      process.stderr.write(`[log.mjs] dropped ${level} ${scope}\n`);
    } catch {}
  }
}

/**
 * Record an error with stack and code.
 *
 * @param {string} scope     Module or feature name (e.g. 'session-start').
 * @param {Error | string} err Error instance or string message.
 * @param {object} [meta]    Optional structured context.
 */
export function logError(scope, err, meta) {
  const errPayload =
    err instanceof Error
      ? { name: err.name, message: err.message, code: err.code, stack: err.stack }
      : { message: String(err) };
  emit('error', scope, errPayload.message, { ...meta, err: errPayload });
}

/**
 * Debug message; only emitted when LL_HOOK_DEBUG=1.
 *
 * @param {string} scope
 * @param {string} msg
 * @param {object} [meta]
 */
export function debug(scope, msg, meta) {
  if (!env.LL_HOOK_DEBUG) return;
  emit('debug', scope, msg, meta);
}

/**
 * Informational message; always emitted.
 *
 * @param {string} scope
 * @param {string} msg
 * @param {object} [meta]
 */
export function info(scope, msg, meta) {
  emit('info', scope, msg, meta);
}
