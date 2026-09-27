import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTruthy, coerceNumber, env, isOffline } from '../plugin/scripts/lib/env.mjs';

const MOD = JSON.stringify(new URL('../plugin/scripts/lib/env.mjs', import.meta.url).href);

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

test('isOffline reflects LL_OFFLINE truthy coercion (subprocess)', () => {
  for (const [val, expected] of [
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['', false],
  ]) {
    const out = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        const m = await import(${MOD});
        console.log(JSON.stringify({ flag: m.env.LL_OFFLINE, helper: m.isOffline() }));
      `,
      ],
      { env: { ...process.env, LL_OFFLINE: val } },
    );
    assert.equal(out.status, 0, out.stderr.toString());
    const { flag, helper } = JSON.parse(out.stdout.toString());
    assert.equal(flag, expected, `LL_OFFLINE=${JSON.stringify(val)} -> env.LL_OFFLINE`);
    assert.equal(helper, expected, `LL_OFFLINE=${JSON.stringify(val)} -> isOffline()`);
  }
});

test('isOffline defaults to false when LL_OFFLINE unset (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${MOD});
      console.log(JSON.stringify({ flag: m.env.LL_OFFLINE, helper: m.isOffline() }));
    `,
    ],
    { env: { ...process.env, LL_OFFLINE: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { flag, helper } = JSON.parse(out.stdout.toString());
  assert.equal(flag, false);
  assert.equal(helper, false);
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
    [
      '--input-type=module',
      '-e',
      `
      delete process.env.LL_HOOK_DEBUG;
      delete process.env.LEARNING_LOOP_INJECTION_THRESHOLD;
      delete process.env.LEARNING_LOOP_INJECTION_RACE_CAP_MS;
      delete process.env.LEARNING_LOOP_INJECTION_MODE;
      delete process.env.LEARNING_LOOP_INJECTION_MIN_SPECIFICITY;
      delete process.env.OLLAMA_URL;
      delete process.env.MODEL;
      delete process.env.LL_REPO;
      const m = await import(${MOD});
      console.log(JSON.stringify({
        debug: m.env.LL_HOOK_DEBUG,
        threshold: m.env.LEARNING_LOOP_INJECTION_THRESHOLD,
        raceCap: m.env.LEARNING_LOOP_INJECTION_RACE_CAP_MS,
        mode: m.env.LEARNING_LOOP_INJECTION_MODE,
        minSpecificity: m.env.LEARNING_LOOP_INJECTION_MIN_SPECIFICITY,
        ollama: m.env.OLLAMA_URL,
        model: m.env.MODEL,
        repo: m.env.LL_REPO,
        forceError: m.env.LEARNING_LOOP_INJECTION_FORCE_ERROR,
      }));
    `,
    ],
    {
      env: {
        ...process.env,
        LL_HOOK_DEBUG: undefined,
        LEARNING_LOOP_INJECTION_THRESHOLD: undefined,
        LEARNING_LOOP_INJECTION_RACE_CAP_MS: undefined,
        LEARNING_LOOP_INJECTION_MODE: undefined,
        LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: undefined,
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
  // null, not the default: consumers layer config.json between the env var
  // and the default (`injection_threshold`, `librarian.ollama_url`), which a
  // pre-defaulted value would shadow.
  assert.equal(parsed.threshold, null);
  assert.equal(parsed.raceCap, null);
  assert.equal(parsed.mode, null);
  assert.equal(parsed.minSpecificity, null);
  assert.equal(parsed.ollama, null);
  assert.equal(parsed.model, null);
  assert.equal(parsed.repo, 'robinslange/learning-loop');
  assert.equal(parsed.forceError, false);
});

test('injectionSetting takes the env var, then config.json, then the default (subprocess)', () => {
  const home = mkdtempSync(join(tmpdir(), 'll-injection-setting-'));
  try {
    const pluginData = join(home, 'plugin-data');
    mkdirSync(pluginData);
    writeFileSync(
      join(pluginData, 'config.json'),
      // An empty config value counts as unset, so the floor falls to the default.
      JSON.stringify({
        injection_threshold: 0.4,
        injection_mode: 'live',
        injection_min_prompt_specificity: '',
      }),
    );
    const read = (extra) => {
      const out = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
          const { env } = await import(${MOD});
          const { injectionSetting } = await import(${JSON.stringify(new URL('../plugin/scripts/lib/config.mjs', import.meta.url).href)});
          console.log(JSON.stringify({
            threshold: injectionSetting(env.LEARNING_LOOP_INJECTION_THRESHOLD, 'injection_threshold', 0.9),
            mode: injectionSetting(env.LEARNING_LOOP_INJECTION_MODE, 'injection_mode', 'shadow'),
            floor: injectionSetting(env.LEARNING_LOOP_INJECTION_MIN_SPECIFICITY, 'injection_min_prompt_specificity', 2),
          }));
        `,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            USERPROFILE: home,
            CLAUDE_PLUGIN_DATA: pluginData,
            ...extra,
          },
        },
      );
      assert.equal(out.status, 0, out.stderr.toString());
      return JSON.parse(out.stdout.toString());
    };

    assert.deepEqual(read({}), { threshold: 0.4, mode: 'live', floor: 2 });
    assert.deepEqual(
      read({
        LEARNING_LOOP_INJECTION_THRESHOLD: '0',
        LEARNING_LOOP_INJECTION_MODE: 'off',
        LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
      }),
      { threshold: 0, mode: 'off', floor: 0 },
      'an env var set to 0 still wins over config and the default',
    );
    assert.deepEqual(
      read({ LEARNING_LOOP_INJECTION_MODE: '', LEARNING_LOOP_INJECTION_THRESHOLD: 'abc' }),
      { threshold: 0.4, mode: 'live', floor: 2 },
      'an empty or non-numeric env var counts as unset, so config applies',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('env reflects overrides from process.env (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${MOD});
      console.log(JSON.stringify({
        debug: m.env.LL_HOOK_DEBUG,
        threshold: m.env.LEARNING_LOOP_INJECTION_THRESHOLD,
        mode: m.env.LEARNING_LOOP_INJECTION_MODE,
      }));
    `,
    ],
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
    [
      '--input-type=module',
      '-e',
      `
      const { homedir } = await import('node:os');
      const m = await import(${MOD});
      console.log(JSON.stringify({ home: m.env.HOME, expected: homedir() }));
    `,
    ],
    { env: { ...process.env, HOME: undefined, USERPROFILE: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { home, expected } = JSON.parse(out.stdout.toString());
  assert.equal(home, expected);
});

test('env.VAULT_PATH is null when not set (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${MOD});
      console.log(JSON.stringify({ vp: m.env.VAULT_PATH }));
    `,
    ],
    { env: { ...process.env, VAULT_PATH: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { vp } = JSON.parse(out.stdout.toString());
  assert.equal(vp, null);
});

test('env.CLAUDE_PROJECT_DIR defaults to empty string (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${MOD});
      console.log(JSON.stringify({ cpd: m.env.CLAUDE_PROJECT_DIR }));
    `,
    ],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { cpd } = JSON.parse(out.stdout.toString());
  assert.equal(cpd, '');
});
