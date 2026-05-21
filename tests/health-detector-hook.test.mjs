import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as runHealthDetector } from '../hooks/session-start/health-detector.mjs';

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

test('health-detector: emits no line when LL_DISABLE_DETECTOR=1', async () => {
  const prev = process.env.LL_DISABLE_DETECTOR;
  process.env.LL_DISABLE_DETECTOR = '1';
  const ctx = {
    pluginDir: process.cwd(),
    pluginData: null,
    vaultRoot: null,
    context: '',
    depsAllSatisfied: true,
    depsMissing: '',
  };
  await runHealthDetector(ctx);
  assert.equal(ctx.context, '');
  if (prev === undefined) delete process.env.LL_DISABLE_DETECTOR;
  else process.env.LL_DISABLE_DETECTOR = prev;
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
