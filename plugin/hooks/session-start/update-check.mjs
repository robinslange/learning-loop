// hooks/session-start/update-check.mjs : background update check (throttled).
// Spawns a detached child to fetch the latest release from GitHub.
// Results are cached in plugin-data/update-check.json with a 1-hour TTL.

import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { recordDetachedChild } from '../lib/common.mjs';

export async function run(ctx) {
  if (!ctx.updateCacheFile) return;

  let shouldCheck = true;
  try {
    const { value: cached } = safeLoad(ctx.updateCacheFile, { fallback: null });
    if (cached?.checked && Date.now() / 1000 - cached.checked < HookConfig.VERSION_CHECK_TTL_SECS) {
      shouldCheck = false;
    }
  } catch (err) {
    logError('session-start.update-check.readCache', err);
  }

  if (!shouldCheck) return;

  try {
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, 'update-check-worker.mjs'),
        ctx.updateCacheFile,
        ctx.pluginVersion,
      ],
      { stdio: 'ignore', detached: true },
    );
    child.unref();
    recordDetachedChild(child.pid);
  } catch (err) {
    logError('session-start.update-check.spawn', err);
  }
}
