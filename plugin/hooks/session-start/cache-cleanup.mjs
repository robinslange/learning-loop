// hooks/session-start/cache-cleanup.mjs : stale cache version prune + shim installer
// + binary auto-update.
// Removes plugin-data directories strictly older than the running version, ensures
// ll-watch and ll-search shims are installed, and triggers a detached binary
// download when the installed ll-search version diverges from the plugin's
// manifest (.claude-plugin/plugin.json) version (plugin auto-update bumps the
// marketplace files but the native binary lags otherwise).

import {
  readdirSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError, debug } from '../../scripts/lib/log.mjs';
import { semverCmp, isPlainSemver } from '../../scripts/lib/semver.mjs';
import { home, recordDetachedChild } from '../lib/common.mjs';
import { DATA_FILES, DATA_PATHS } from '../../scripts/lib/paths.mjs';
import { resolvePluginData } from '../../scripts/lib/config.mjs';
import { spawnEnv } from '../../scripts/lib/env.mjs';

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

  // Stale-artifact sweep in the live plugin-data dir. Two leftovers accumulate
  // here that the version-prune above never reaches (they live in the *current*
  // version's data, not an old version dir):
  //   1. bin/ll-search.*-bak — orphaned binary backups (~290M each) from the
  //      old delta-patch updater. That code path is gone, but installs that
  //      passed through it still carry the backups; nothing ever removed them.
  //   2. convergence/*.json older than the TTL — regenerable discovery/verify
  //      session telemetry. The knowledge it produced already lives in the vault.
  // Best-effort: any failure is logged and skipped, never blocks session-start.
  try {
    const pluginData = resolvePluginData();
    if (pluginData) {
      const binDir = DATA_PATHS.bin(pluginData);
      try {
        for (const name of readdirSync(binDir)) {
          if (/^ll-search\..*-bak$/.test(name)) {
            unlinkSync(join(binDir, name));
          }
        }
      } catch (err) {
        debug('session-start.stale-artifact-sweep', 'bin sweep skipped', { err: err?.code });
      }

      const convergenceDir = DATA_PATHS.convergence(pluginData);
      const cutoff = Date.now() - HookConfig.CONVERGENCE_TTL_MS;
      try {
        for (const name of readdirSync(convergenceDir)) {
          const fp = join(convergenceDir, name);
          try {
            const st = statSync(fp);
            if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(fp);
          } catch (err) {
            debug('session-start.stale-artifact-sweep', 'entry skipped', { err: err?.code });
          }
        }
      } catch (err) {
        debug('session-start.stale-artifact-sweep', 'convergence sweep skipped', {
          err: err?.code,
        });
      }
    }
  } catch (err) {
    logError('session-start.stale-artifact-sweep', err);
  }

  // Binary auto-update: when the installed ll-search version lags the running
  // plugin version, spawn a detached download. Fire-and-forget — the current
  // session keeps using whatever binary is on disk; the *next* session boots
  // with the fresh binary. One-session lag is acceptable; blocking session-start
  // on a multi-megabyte download is not.
  //
  // Failure mode this guards against: plugin auto-update bumps marketplace
  // files (plugin.json, agents, skills, hooks) but the native ll-search
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
    // Pass the resolved environment explicitly: the child's getPluginData()
    // must see CLAUDE_PLUGIN_DATA. Relying on default inheritance is implicit
    // and a future spawn-option change could silently drop it, re-creating the
    // stuck-auto-update loop (the child throws on null plugin-data).
    const child = spawn(process.execPath, [downloader], {
      detached: true,
      stdio: 'ignore',
      env: spawnEnv({ CLAUDE_PLUGIN_DATA: pluginData }),
    });
    child.on('error', () => {});
    child.unref();
    recordDetachedChild(child.pid);
  } catch (err) {
    logError('session-start.binary-update', err);
  }
}
