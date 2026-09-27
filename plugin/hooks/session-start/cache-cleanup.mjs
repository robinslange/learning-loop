// hooks/session-start/cache-cleanup.mjs : shim installer + stale-artifact sweep
// + binary auto-update.
//
// Superseded plugin versions are NOT removed here. Claude Code marks them with
// .orphaned_at and reaps them itself after a grace period; deleting them at
// SessionStart pulled the code out from under every session still running the
// previous version and forced a reload in all of them.

import { readdirSync, readFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError, debug } from '../../scripts/lib/log.mjs';
import { spawnDetached } from '../lib/common.mjs';
import {
  DATA_FILES,
  DATA_PATHS,
  SHIM_NAMES,
  shimFileName,
  home,
} from '../../scripts/lib/paths.mjs';
import { getPluginData } from '../../scripts/lib/config.mjs';
import { spawnEnv, isOffline } from '../../scripts/lib/env.mjs';
import { renderShim } from '../../scripts/lib/shims.mjs';

function stripV(s) {
  return typeof s === 'string' && s.startsWith('v') ? s.slice(1) : s;
}

export async function run(ctx) {
  // Shim installer: rewrite the shims when any is missing or its text differs
  // from what this version renders. A shim on disk never updates itself, so an
  // existence-only check left every install on the shim it was first given.
  // Driven by SHIM_NAMES so a shim added later reaches existing installs too.
  try {
    const binDir = join(home(), '.local', 'bin');
    const stale = SHIM_NAMES.some((name) => {
      const path = join(binDir, shimFileName(name));
      return !existsSync(path) || readFileSync(path, 'utf-8') !== renderShim(name);
    });
    if (stale) {
      const installer = join(ctx.pluginDir, 'scripts', 'install-shims.mjs');
      if (existsSync(installer)) {
        mkdirSync(binDir, { recursive: true });
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
  // in the *current* version's plugin-data:
  //   1. bin/ll-search.*-bak — orphaned binary backups (~290M each) from the
  //      old delta-patch updater. That code path is gone, but installs that
  //      passed through it still carry the backups; nothing ever removed them.
  //   2. convergence/*.json older than the TTL — regenerable discovery/verify
  //      session telemetry. The knowledge it produced already lives in the vault.
  // Best-effort: any failure is logged and skipped, never blocks session-start.
  try {
    const pluginData = getPluginData();
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
  if (isOffline()) return;
  try {
    const pluginData = getPluginData();
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
    spawnDetached('session-start.binary-update', process.execPath, [downloader], {
      env: spawnEnv({ CLAUDE_PLUGIN_DATA: pluginData }),
    });
  } catch (err) {
    logError('session-start.binary-update', err);
  }
}
