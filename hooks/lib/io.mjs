// hooks/lib/io.mjs : bounded stdout helpers for hooks.
//
// Hook stdout is Claude Code's contract surface. Plugins must not flood it.
// emit(text) writes text to stdout but truncates to HOOK_STDOUT_MAX_BYTES (8 KiB)
// when over the cap, appending '\n[TRUNCATED]' as a clear marker.
// emitJson(obj) JSON.stringifies obj first, then emits.
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

/**
 * JSON.stringify obj then emit with byte cap.
 * @param {unknown} obj
 */
export function emitJson(obj) {
  let text;
  try {
    text = JSON.stringify(obj);
  } catch (err) {
    logError('hooks/lib/io.emitJson.stringify', err);
    return;
  }
  emit(text);
}
