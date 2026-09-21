import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOD = JSON.stringify(new URL('../plugin/scripts/lib/log.mjs', import.meta.url).href);

function runChild(envOverrides, code) {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...envOverrides },
  });
  return { stdout: out.stdout.toString(), stderr: out.stderr.toString(), status: out.status };
}

function monthStr(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

// --- sink: error records land in PLUGIN_DATA/logs/log-YYYY-MM.jsonl too ---

test('logError writes to both stderr and the sink file', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-log-sink-'));
  try {
    const { stderr, status } = runChild(
      { CLAUDE_PLUGIN_DATA: root },
      `
      const m = await import(${MOD});
      m.logError('sink-scope', new Error('sink boom'));
    `,
    );
    assert.equal(status, 0);
    assert.ok(stderr.trim(), 'stderr write must still happen');
    const sinkFile = join(root, 'logs', `log-${monthStr()}.jsonl`);
    assert.ok(existsSync(sinkFile), 'sink file must be created');
    const line = readFileSync(sinkFile, 'utf-8').trim().split('\n').filter(Boolean)[0];
    const parsed = JSON.parse(line);
    assert.equal(parsed.level, 'error');
    assert.equal(parsed.scope, 'sink-scope');
    assert.equal(parsed.msg, 'sink boom');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('info does not write to the sink file, only stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-log-sink-info-'));
  try {
    const { stderr, status } = runChild(
      { CLAUDE_PLUGIN_DATA: root },
      `
      const m = await import(${MOD});
      m.info('s', 'not a failure');
    `,
    );
    assert.equal(status, 0);
    assert.ok(stderr.trim());
    const sinkFile = join(root, 'logs', `log-${monthStr()}.jsonl`);
    assert.ok(!existsSync(sinkFile), 'info must not create the sink file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('debug does not write to the sink file, only stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-log-sink-debug-'));
  try {
    const { stderr, status } = runChild(
      { CLAUDE_PLUGIN_DATA: root, LL_HOOK_DEBUG: '1' },
      `
      const m = await import(${MOD});
      m.debug('s', 'not a failure either');
    `,
    );
    assert.equal(status, 0);
    assert.ok(stderr.trim());
    const sinkFile = join(root, 'logs', `log-${monthStr()}.jsonl`);
    assert.ok(!existsSync(sinkFile), 'debug must not create the sink file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logError no-ops the sink when plugin data does not exist, stderr still fires', () => {
  const { stderr, status } = runChild(
    { CLAUDE_PLUGIN_DATA: undefined },
    `
    delete process.env.CLAUDE_PLUGIN_DATA;
    const m = await import(${MOD});
    m.logError('no-plugin-data', new Error('boom'));
  `,
  );
  assert.equal(status, 0);
  assert.ok(stderr.trim(), 'stderr write must still happen with no plugin data');
});

test('logError with a meta.code also appends a compat hook-errors-YYYY-MM.jsonl line', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-log-sink-compat-'));
  try {
    const { status } = runChild(
      { CLAUDE_PLUGIN_DATA: root },
      `
      const m = await import(${MOD});
      m.logError('pre-write-check.checkDuplicateNote', new Error('gate timed out'), {
        code: 'duplicate-gate-timeout',
        source: 'daemon',
        latency_ms: 42,
      });
    `,
    );
    assert.equal(status, 0);
    const compatFile = join(root, `hook-errors-${monthStr()}.jsonl`);
    assert.ok(
      existsSync(compatFile),
      'compat hook-errors file must be written when meta carries a code',
    );
    const parsed = JSON.parse(
      readFileSync(compatFile, 'utf-8').trim().split('\n').filter(Boolean)[0],
    );
    assert.equal(parsed.code, 'duplicate-gate-timeout');
    assert.equal(parsed.source, 'daemon');
    assert.equal(parsed.latency_ms, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logError without a meta.code does not write the compat hook-errors file', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-log-sink-nocompat-'));
  try {
    const { status } = runChild(
      { CLAUDE_PLUGIN_DATA: root },
      `
      const m = await import(${MOD});
      m.logError('plain-scope', new Error('boom'));
    `,
    );
    assert.equal(status, 0);
    const compatFile = join(root, `hook-errors-${monthStr()}.jsonl`);
    assert.ok(!existsSync(compatFile), 'compat file must not appear without a code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logError sink failure does not throw and does not suppress the stderr write', () => {
  // Point CLAUDE_PLUGIN_DATA at a path that exists but cannot hold a `logs`
  // subdirectory (a file, not a directory), forcing the sink's mkdir/open to fail.
  const root = mkdtempSync(join(tmpdir(), 'll-log-sink-fail-'));
  try {
    const blocker = join(root, 'logs');
    writeFileSync(blocker, 'not a directory');
    const { stderr, status } = runChild(
      { CLAUDE_PLUGIN_DATA: root },
      `
      const m = await import(${MOD});
      m.logError('sink-fail-scope', new Error('boom'));
      console.log('survived');
    `,
    );
    assert.equal(status, 0);
    assert.ok(stderr.trim(), 'stderr write must still happen when the sink fails');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
