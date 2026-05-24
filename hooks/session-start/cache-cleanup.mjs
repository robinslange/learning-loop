// hooks/session-start/cache-cleanup.mjs : stale cache version prune + shim installer
// + binary auto-update.
// Removes plugin-data directories strictly older than the running version, ensures
// ll-watch and ll-search shims are installed, and triggers a detached binary
// download when the installed ll-search version diverges from the plugin's
// package.json version (plugin auto-update bumps the marketplace files but the
// native binary lags otherwise).

import { readdirSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { semverCmp, isPlainSemver } from '../../scripts/lib/semver.mjs';
import { home } from '../lib/common.mjs';
import { DATA_FILES } from '../../scripts/lib/paths.mjs';
import { resolvePluginData } from '../../scripts/lib/config.mjs';

function stripV(s) {
  return typeof s === 'string' && s.startsWith('v') ? s.slice(1) : s;
}

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

  // Binary auto-update: when the installed ll-search version lags the running
  // plugin version, spawn a detached download. Fire-and-forget — the current
  // session keeps using whatever binary is on disk; the *next* session boots
  // with the fresh binary. One-session lag is acceptable; blocking session-start
  // on a multi-megabyte download is not.
  //
  // Failure mode this guards against: plugin auto-update bumps marketplace
  // files (package.json, agents, skills, hooks) but the native ll-search
  // binary is only refreshed by download-binary.mjs, which historically only
  // ran on /learning-loop:init. Robin's machine sat on v1.20.2 for five
  // releases this way until the v1.25 retrieval/reflect-scan path tripped
  // the pre-fix leak shape and surfaced the gap.
  try {
    const pluginData = resolvePluginData();
    if (!pluginData) return;
    const versionFile = DATA_FILES.binVersion(pluginData);
    const installedRaw = existsSync(versionFile) ? readFileSync(versionFile, 'utf-8').trim() : '';
    const installed = stripV(installedRaw);
    const running = stripV(ctx.pluginVersion);
    if (installed === running) return;
    const downloader = join(ctx.pluginDir, 'scripts', 'download-binary.mjs');
    if (!existsSync(downloader)) return;
    const child = spawn('node', [downloader], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    logError('session-start.binary-update', err);
  }
}
