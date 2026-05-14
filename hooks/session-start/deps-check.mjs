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
      const required = issues.filter(([, v]) => v.required);
      const optional = issues.filter(([, v]) => !v.required);

      const renderLine = ([name, info]) =>
        `- **${name}** (${info.status}): \`claude plugin install ${name}@${info.marketplace}\`\n` +
        (info.reason ? `  Reason: ${info.reason}\n` : '');

      if (required.length > 0) {
        ctx.depsAllSatisfied = false;
        ctx.depsMissing += '\n## Missing Required Dependencies\n';
        ctx.depsMissing +=
          'Learning-loop cannot function correctly without these. Install before continuing.\n\n';
        for (const issue of required) ctx.depsMissing += renderLine(issue);
      }
      if (optional.length > 0) {
        ctx.depsMissing += '\n## Missing Optional Dependencies\n';
        ctx.depsMissing += 'Recommended but not required.\n\n';
        for (const issue of optional) ctx.depsMissing += renderLine(issue);
      }
      if (issues.length > 0) {
        ctx.depsMissing += '\nRun `/init` to set up all dependencies.\n';
      }
    }
  } catch (err) {
    logError('session-start.deps-check', err);
  }
}
