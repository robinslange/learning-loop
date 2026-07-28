import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run as runHealthDetector } from '../plugin/hooks/session-start/health-detector.mjs';

const DETECTOR_PATH = fileURLToPath(
  new URL('../plugin/hooks/session-start/health-detector.mjs', import.meta.url),
);

test('health-detector: appends single line to ctx.context when fails exist', async () => {
  const ctx = {
    pluginDir: process.cwd(),
    pluginData: null,
    vaultRoot: null,
    context: '',
    depsAllSatisfied: true,
    depsMissing: '',
  };
  await runHealthDetector(ctx);
  // With vaultRoot=null, multiple fail-severity checks will fire.
  assert.match(ctx.context, /⚠ learning-loop: \d+ issues — run \/learning-loop:doctor/);
});

test('health-detector: emits no line when LL_DISABLE_DETECTOR=1', () => {
  // The flag is read through the lib/env.mjs snapshot, which freezes at import
  // time, so the override must be in place before the module loads: run the
  // detector in a subprocess with the env var set.
  const script = `
    import { run } from ${JSON.stringify(pathToFileURL(DETECTOR_PATH).href)};
    const ctx = {
      pluginDir: process.cwd(),
      pluginData: null,
      vaultRoot: null,
      context: '',
      depsAllSatisfied: true,
      depsMissing: '',
    };
    await run(ctx);
    process.stdout.write(JSON.stringify({ context: ctx.context }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: 20000,
    env: { ...process.env, LL_DISABLE_DETECTOR: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).context, '');
});

test('health-detector: sets ctx.depsAllSatisfied + depsMissing for context-assembly', async () => {
  const ctx = {
    pluginDir: process.cwd(),
    pluginData: null,
    vaultRoot: null,
    context: '',
    depsAllSatisfied: true,
    depsMissing: '',
  };
  await runHealthDetector(ctx);
  // We expect depsAllSatisfied=false because vault-path fail is required-severity
  assert.equal(ctx.depsAllSatisfied, false);
});

test('health-detector: emits a one-line shadow-gate nudge when the cached check is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-detector-shadowgate-'));
  const cache = {
    ts: new Date().toISOString(),
    ran: 'quick',
    checks: [
      {
        id: 'injection-shadow-gate',
        name: 'Injection shadow gate',
        status: 'fail',
        severity: 'warn',
        detail:
          'shadow gate passing (25/105 recent healthy entries, 23.8% pass rate) — ready to flip injection_mode to live',
        fix: 'Review with `node PLUGIN/scripts/review-shadow.mjs`, then run /learning-loop:doctor to apply the flip',
      },
    ],
  };
  writeFileSync(join(dir, 'last-health.json'), JSON.stringify(cache));
  const ctx = {
    pluginDir: process.cwd(),
    pluginData: dir,
    vaultRoot: null,
    context: '',
    depsAllSatisfied: true,
    depsMissing: '',
  };
  await runHealthDetector(ctx);
  assert.match(ctx.context, /ready to flip injection_mode to live/);
  assert.match(ctx.context, /\/learning-loop:doctor/);
  // warn-severity readiness must not be counted as a failing issue
  assert.doesNotMatch(ctx.context, /⚠ learning-loop: \d+ issue/);
  rmSync(dir, { recursive: true, force: true });
});
