// hooks/session-start/cache-cleanup.mjs : stale cache version prune + shim installer.
// Removes plugin-data directories strictly older than the running version, then
// ensures ll-watch and ll-search shims are installed.

import { readdirSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { semverCmp, isPlainSemver } from '../../scripts/lib/semver.mjs';
import { home } from '../lib/common.mjs';

export async function run(ctx) {
  // Stale-version cache prune: remove versions strictly older than running.
  try {
    const cacheParent = resolve(ctx.pluginDir, '..');
    for (const entry of readdirSync(cacheParent)) {
      if (!isPlainSemver(entry)) continue;
      if (semverCmp(entry, ctx.pluginVersion) < 0) {
        rmSync(join(cacheParent, entry), { recursive: true, force: true });
      }
    }
  } catch (err) {
    logError('session-start.cache-cleanup', err);
  }

  // Shim installer: ensure ll-watch and ll-search stable shell wrappers exist.
  try {
    const watchShim = join(home(), '.local', 'bin', 'll-watch');
    const searchShim = join(home(), '.local', 'bin', 'll-search');
    if (!existsSync(watchShim) || !existsSync(searchShim)) {
      const installer = join(ctx.pluginDir, 'scripts', 'install-shims.mjs');
      if (existsSync(installer)) {
        mkdirSync(join(home(), '.local', 'bin'), { recursive: true });
        execFileSync('node', [installer, '--install'], {
          stdio: 'ignore',
          timeout: HookConfig.DEPS_CHECK_TIMEOUT_MS,
        });
      }
    }
  } catch (err) {
    logError('session-start.shim-installer', err);
  }
}
