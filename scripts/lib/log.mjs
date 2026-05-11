// scripts/lib/log.mjs : structured stderr logging for hooks and scripts.
//
// All output goes to stderr (hook stdout is the contract surface for Claude
// Code). Each line is a single JSON object so tests can grep + parse; humans
// can tail with jq.
//
// The module deliberately swallows its own write errors -- losing a log line
// must never crash a hook.
//
// debug() is gated on env.LL_HOOK_DEBUG. logError() and info() always emit.

import { env } from './env.mjs';
import { pluginId } from './plugin-meta.mjs';

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
  } catch {
    // Defensive fallback: write a minimal plain-text line when JSON.stringify
    // fails (e.g. circular references in meta) or stderr is unavailable.
    try {
      process.stderr.write(`[log.mjs] dropped ${level} ${scope}\n`);
      // eslint-disable-next-line learning-loop/no-empty-catch
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
