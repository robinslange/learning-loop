// hooks/lib/io.mjs : bounded stdout helpers for hooks.
//
// Hook stdout is Claude Code's contract surface. Plugins must not flood it.
// emit(text) writes text to stdout but truncates to HOOK_STDOUT_MAX_BYTES (8 KiB)
// when over the cap, appending '\n[TRUNCATED]' as a clear marker.
// emitJson(obj) guarantees valid JSON under the cap or no output at all,
// trimming hookSpecificOutput.additionalContext when the payload is too big.
// Both swallow stdout write errors — losing stdout cannot crash a hook.

import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';

const MAX = HookConfig.HOOK_STDOUT_MAX_BYTES;
const TRUNC = '\n[TRUNCATED]';
const TRUNC_BYTES = Buffer.byteLength(TRUNC, 'utf8');

/**
 * Write text to stdout, truncating to HOOK_STDOUT_MAX_BYTES if needed.
 * @param {string | unknown} text
 */
export function emit(text) {
  try {
    let payload = typeof text === 'string' ? text : String(text ?? '');
    if (Buffer.byteLength(payload, 'utf8') > MAX) {
      const room = MAX - TRUNC_BYTES;
      while (Buffer.byteLength(payload, 'utf8') > room) {
        payload = payload.slice(0, -1);
      }
      payload += TRUNC;
    }
    process.stdout.write(payload);
  } catch (err) {
    logError('hooks/lib/io', err);
  }
}

const FIELD_TRUNC = '…[truncated]';

function writeRaw(text) {
  try {
    process.stdout.write(text);
  } catch (err) {
    logError('hooks/lib/io', err);
  }
}

/**
 * JSON.stringify obj and write it, guaranteeing the output is either valid
 * JSON within HOOK_STDOUT_MAX_BYTES or nothing at all. Oversized payloads are
 * shrunk by trimming hookSpecificOutput.additionalContext (the one
 * variable-length field hooks emit); a payload that cannot be shrunk that way
 * is dropped with a logged error — corrupt JSON is never written.
 */
export function emitJson(obj) {
  let text;
  try {
    text = JSON.stringify(obj);
  } catch (err) {
    logError('hooks/lib/io.emitJson.stringify', err);
    return;
  }
  if (Buffer.byteLength(text, 'utf8') <= MAX) {
    writeRaw(text);
    return;
  }

  const ctx = obj?.hookSpecificOutput?.additionalContext;
  if (typeof ctx === 'string') {
    const build = (keep) =>
      JSON.stringify({
        ...obj,
        hookSpecificOutput: {
          ...obj.hookSpecificOutput,
          additionalContext: ctx.slice(0, keep) + FIELD_TRUNC,
        },
      });
    // Binary-search the largest prefix that fits. slice() cannot split a
    // surrogate pair into invalid JSON (lone surrogates serialize as escapes),
    // but trim one extra char when the boundary lands mid-pair to keep the
    // emoji whole.
    let lo = 0;
    let hi = ctx.length;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Buffer.byteLength(build(mid), 'utf8') <= MAX) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0) {
      let keep = best;
      const tail = ctx.charCodeAt(keep - 1);
      if (keep > 0 && tail >= 0xd800 && tail <= 0xdbff) keep -= 1;
      writeRaw(build(keep));
      return;
    }
  }

  logError(
    'hooks/lib/io.emitJson',
    new Error(
      `payload ${Buffer.byteLength(text, 'utf8')}B exceeds ${MAX}B with no trimmable additionalContext; emitted nothing`,
    ),
  );
}
