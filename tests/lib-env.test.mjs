import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isTruthy, coerceNumber, env } from '../plugin/scripts/lib/env.mjs';

const MOD = JSON.stringify(
  fileURLToPath(new URL('../plugin/scripts/lib/env.mjs', import.meta.url)),
);

test('isTruthy accepts canonical truthy strings', () => {
  for (const v of ['1', 'true', 'yes', 'on']) {
    assert.equal(isTruthy(v), true);
  }
  for (const v of ['0', 'false', 'no', '', undefined, null, 'TRUE']) {
    assert.equal(isTruthy(v), false);
  }
});

test('coerceNumber coerces numeric strings, falls back otherwise', () => {
  assert.equal(coerceNumber('42', 0), 42);
  assert.equal(coerceNumber('0.35', 1), 0.35);
  assert.equal(coerceNumber('', 7), 7);
  assert.equal(coerceNumber(undefined, 7), 7);
  assert.equal(coerceNumber(null, 7), 7);
  assert.equal(coerceNumber('not-a-number', 7), 7);
  assert.equal(coerceNumber('NaN', 7), 7);
  assert.equal(coerceNumber('0', 7), 0);
});

test('env is frozen', () => {
  assert.equal(Object.isFrozen(env), true);
  assert.throws(() => {
    env.LL_HOOK_DEBUG = true;
  }, TypeError);
});

test('env exposes documented defaults when env vars absent (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      delete process.env.LL_HOOK_DEBUG;
      delete process.env.LEARNING_LOOP_INJECTION_THRESHOLD;
      delete process.env.LEARNING_LOOP_INJECTION_RACE_CAP_MS;
      delete process.env.OLLAMA_URL;
      delete process.env.MODEL;
      delete process.env.LL_REPO;
      const m = await import(${MOD});
      console.log(JSON.stringify({
        debug: m.env.LL_HOOK_DEBUG,
        threshold: m.env.LEARNING_LOOP_INJECTION_THRESHOLD,
        raceCap: m.env.LEARNING_LOOP_INJECTION_RACE_CAP_MS,
        ollama: m.env.OLLAMA_URL,
        model: m.env.MODEL,
        repo: m.env.LL_REPO,
        forceError: m.env.LEARNING_LOOP_INJECTION_FORCE_ERROR,
      }));
    `],
    {
      env: {
        ...process.env,
        LL_HOOK_DEBUG: undefined,
        LEARNING_LOOP_INJECTION_THRESHOLD: undefined,
        LEARNING_LOOP_INJECTION_RACE_CAP_MS: undefined,
        OLLAMA_URL: undefined,
        MODEL: undefined,
        LL_REPO: undefined,
        LEARNING_LOOP_INJECTION_FORCE_ERROR: undefined,
      },
    },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const parsed = JSON.parse(out.stdout.toString());
  assert.equal(parsed.debug, false);
  assert.equal(parsed.threshold, 0.35);
  assert.equal(parsed.raceCap, 1500);
  assert.equal(parsed.ollama, 'http://localhost:11434');
  assert.equal(parsed.model, 'gemma4:e2b');
  assert.equal(parsed.repo, 'robinslange/learning-loop');
  assert.equal(parsed.forceError, false);
});

test('env reflects overrides from process.env (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const m = await import(${MOD});
      console.log(JSON.stringify({
        debug: m.env.LL_HOOK_DEBUG,
        threshold: m.env.LEARNING_LOOP_INJECTION_THRESHOLD,
        mode: m.env.LEARNING_LOOP_INJECTION_MODE,
      }));
    `],
    {
      env: {
        ...process.env,
        LL_HOOK_DEBUG: '1',
        LEARNING_LOOP_INJECTION_THRESHOLD: '0.7',
        LEARNING_LOOP_INJECTION_MODE: 'shadow',
      },
    },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const parsed = JSON.parse(out.stdout.toString());
  assert.equal(parsed.debug, true);
  assert.equal(parsed.threshold, 0.7);
  assert.equal(parsed.mode, 'shadow');
});

test('env.HOME falls back to os.homedir() when HOME unset (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const { homedir } = await import('node:os');
      const m = await import(${MOD});
      console.log(JSON.stringify({ home: m.env.HOME, expected: homedir() }));
    `],
    { env: { ...process.env, HOME: undefined, USERPROFILE: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { home, expected } = JSON.parse(out.stdout.toString());
  assert.equal(home, expected);
});

test('env.VAULT_PATH is null when not set (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const m = await import(${MOD});
      console.log(JSON.stringify({ vp: m.env.VAULT_PATH }));
    `],
    { env: { ...process.env, VAULT_PATH: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { vp } = JSON.parse(out.stdout.toString());
  assert.equal(vp, null);
});

test('env.CLAUDE_PROJECT_DIR defaults to empty string (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const m = await import(${MOD});
      console.log(JSON.stringify({ cpd: m.env.CLAUDE_PROJECT_DIR }));
    `],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { cpd } = JSON.parse(out.stdout.toString());
  assert.equal(cpd, '');
});
