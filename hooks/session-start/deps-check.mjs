// hooks/session-start/deps-check.mjs : plugin dependency check.
// Runs check-deps.mjs and populates ctx.depsAllSatisfied + ctx.depsMissing.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';

export async function run(ctx) {
  try {
    const depOutput = execFileSync('node', [join(ctx.pluginDir, 'scripts', 'check-deps.mjs')], {
      encoding: 'utf8',
      timeout: HookConfig.DEPS_CHECK_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (depOutput && depOutput !== '{}') {
      let deps;
      try {
        deps = JSON.parse(depOutput);
      } catch (err) {
        logError('session-start.deps-check.parseDeps', err);
        return;
      }
      const issues = Object.entries(deps).filter(([, v]) => v.status !== 'installed');
      if (issues.length > 0) {
        ctx.depsAllSatisfied = false;
        ctx.depsMissing += '\n## Missing Dependencies\n';
        for (const [name, info] of issues) {
          ctx.depsMissing += `- **${name}** (${info.status}): \`claude plugin install ${name}@${info.marketplace}\`\n`;
          if (info.reason) ctx.depsMissing += `  Required for: ${info.reason}\n`;
        }
        ctx.depsMissing += '\nRun `/init` to set up all dependencies.\n';
      }
    }
  } catch (err) {
    logError('session-start.deps-check', err);
  }
}
