import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const MOD = JSON.stringify(new URL('../plugin/scripts/lib/log.mjs', import.meta.url).href);

function runChild(envOverrides, code) {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...envOverrides },
  });
  return { stdout: out.stdout.toString(), stderr: out.stderr.toString(), status: out.status };
}

test('logError always writes a parseable JSON line to stderr', () => {
  const { stderr, status } = runChild(
    {},
    `
    const m = await import(${MOD});
    m.logError('test-scope', new Error('boom'), { k: 'v' });
  `,
  );
  assert.equal(status, 0);
  const lines = stderr.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.scope, 'test-scope');
  assert.equal(parsed.msg, 'boom');
  assert.equal(parsed.meta.err.message, 'boom');
  assert.ok(parsed.meta.err.stack.includes('Error'));
});

test('logError accepts a string instead of an Error', () => {
  const { stderr } = runChild(
    {},
    `
    const m = await import(${MOD});
    m.logError('s', 'just a string');
  `,
  );
  const parsed = JSON.parse(stderr.trim().split('\n').filter(Boolean)[0]);
  assert.equal(parsed.msg, 'just a string');
  assert.equal(parsed.level, 'error');
});

test('logError includes custom meta fields', () => {
  const { stderr } = runChild(
    {},
    `
    const m = await import(${MOD});
    m.logError('s', new Error('x'), { requestId: 'abc' });
  `,
  );
  const parsed = JSON.parse(stderr.trim().split('\n').filter(Boolean)[0]);
  assert.equal(parsed.meta.requestId, 'abc');
});

test('debug is silent without LL_HOOK_DEBUG', () => {
  const { stderr } = runChild(
    { LL_HOOK_DEBUG: undefined },
    `
    delete process.env.LL_HOOK_DEBUG;
    const m = await import(${MOD});
    m.debug('s', 'should not appear');
  `,
  );
  assert.equal(stderr.trim(), '');
});

test('debug emits when LL_HOOK_DEBUG=1', () => {
  const { stderr, status } = runChild(
    { LL_HOOK_DEBUG: '1' },
    `
    const m = await import(${MOD});
    m.debug('s', 'hello debug');
  `,
  );
  assert.equal(status, 0);
  const parsed = JSON.parse(stderr.trim().split('\n').filter(Boolean)[0]);
  assert.equal(parsed.level, 'debug');
  assert.equal(parsed.msg, 'hello debug');
});

test('info emits unconditionally regardless of LL_HOOK_DEBUG', () => {
  const { stderr } = runChild(
    { LL_HOOK_DEBUG: undefined },
    `
    delete process.env.LL_HOOK_DEBUG;
    const m = await import(${MOD});
    m.info('s', 'always visible');
  `,
  );
  const parsed = JSON.parse(stderr.trim().split('\n').filter(Boolean)[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'always visible');
});

test('log lines include ts, plugin, scope, msg fields', () => {
  const { stderr } = runChild(
    {},
    `
    const m = await import(${MOD});
    m.info('my-scope', 'a message');
  `,
  );
  const parsed = JSON.parse(stderr.trim().split('\n').filter(Boolean)[0]);
  assert.ok(parsed.ts, 'ts must be present');
  assert.ok(parsed.plugin, 'plugin must be present');
  assert.equal(parsed.scope, 'my-scope');
  assert.equal(parsed.msg, 'a message');
});

test('logError never throws even with circular meta', () => {
  const { stdout, status } = runChild(
    {},
    `
    const m = await import(${MOD});
    const circ = {}; circ.self = circ;
    m.logError('s', new Error('x'), circ);
    console.log('survived');
  `,
  );
  assert.equal(status, 0);
  assert.ok(stdout.includes('survived'), 'logError must not throw on circular meta');
});

test('logError with Error preserves err.code when set', () => {
  const { stderr } = runChild(
    {},
    `
    const m = await import(${MOD});
    const e = new Error('code test');
    e.code = 'ENOENT';
    m.logError('s', e);
  `,
  );
  const parsed = JSON.parse(stderr.trim().split('\n').filter(Boolean)[0]);
  assert.equal(parsed.meta.err.code, 'ENOENT');
});
