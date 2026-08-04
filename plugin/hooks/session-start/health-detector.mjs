// hooks/session-start/health-detector.mjs — session-start health detector.
// Reads cache or runs quickChecks; emits a single line to ctx.context when
// any fail-severity check is failing. Populates ctx.depsAllSatisfied +
// ctx.depsMissing for context-assembly downstream.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from '../../scripts/lib/log.mjs';
import { home, resolveConfig } from '../lib/common.mjs';
import { runQuickChecks, formatMissingDeps } from '../../scripts/health-check.mjs';
import {
  readHealthCache,
  writeHealthCache,
  isCacheStale,
} from '../../scripts/lib/health-checks/cache.mjs';
import { abiDriftSummary } from '../../scripts/check-deps-impl.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { env } from '../../scripts/lib/env.mjs';

const TEMPLATE_VERSION_PATH = 'templates/claudemd-section.version';

function readTemplateVersion(pluginDir) {
  try {
    return readFileSync(join(pluginDir, TEMPLATE_VERSION_PATH), 'utf-8').trim();
  } catch {
    return '1';
  }
}

function readInstalledVersion(homeDir) {
  try {
    const p = join(homeDir, '.claude/plugins/installed_plugins.json');
    if (!existsSync(p)) return '0.0.0';
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    const plugins = data?.plugins || data || {};
    const entries = plugins['learning-loop@learning-loop-marketplace'];
    return entries?.[0]?.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function run(ctx) {
  if (env.LL_DISABLE_DETECTOR) return;

  try {
    let result;

    // Try cache first
    const cache = readHealthCache({ pluginData: ctx.pluginData });
    if (cache && !isCacheStale(cache)) {
      result = cache;
    } else {
      // Run quickChecks and write cache, bounded by DETECTOR_TIMEOUT_MS
      const homeDir = home();
      const checkCtx = {
        pluginData: ctx.pluginData,
        vaultRoot: ctx.vaultRoot,
        home: homeDir,
        pathEnv: env.PATH,
        installedVersion: readInstalledVersion(homeDir),
        pluginVersion: ctx.pluginVersion,
        templateVersion: readTemplateVersion(ctx.pluginDir),
        abiDriftResult: abiDriftSummary(),
        injectionMode: resolveConfig().injection_mode,
        injectionNudge: resolveConfig().injection_nudge,
      };

      const TIMEOUT_SENTINEL = Symbol('timeout');
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), HookConfig.DETECTOR_TIMEOUT_MS),
      );
      const raced = await Promise.race([runQuickChecks(checkCtx), timeoutPromise]);

      if (raced === TIMEOUT_SENTINEL) {
        logError(
          'session-start.health-detector',
          new Error(`quickChecks exceeded ${HookConfig.DETECTOR_TIMEOUT_MS}ms`),
        );
        return;
      }
      result = raced;
      writeHealthCache({ pluginData: ctx.pluginData, result });
    }

    // Count fail-severity failures
    const fails = result.checks.filter((c) => c.status === 'fail' && c.severity === 'fail');

    // Detector line: exactly one line on fails > 0
    if (fails.length > 0) {
      ctx.context += `⚠ learning-loop: ${fails.length} issue${fails.length === 1 ? '' : 's'} — run /learning-loop:doctor\n`;
    }

    // Shadow-gate nudge: one line when shadow-mode data clears the go-live
    // gate. The flip itself stays consent-gated behind /doctor.
    const shadowGate = result.checks.find(
      (c) => c.id === 'injection-shadow-gate' && c.status === 'fail',
    );
    if (shadowGate) {
      ctx.context += `learning-loop: ${shadowGate.detail} — run /learning-loop:doctor to apply\n`;
    }

    // Preserve context-assembly contract (replaces deps-check.mjs output)
    if (fails.length > 0) ctx.depsAllSatisfied = false;
    const md = formatMissingDeps(result);
    if (md) ctx.depsMissing += md;
  } catch (err) {
    logError('session-start.health-detector', err);
  }
}
