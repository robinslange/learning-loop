import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { scanForSecrets } from '../plugin/scripts/redact-scan.mjs';

const SCRIPT = new URL('../plugin/scripts/redact-scan.mjs', import.meta.url).pathname;

test('flags known credential prefixes (github-pat)', () => {
  const hits = scanForSecrets('token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 done');
  assert.ok(hits.some((h) => h.kind === 'github-pat'));
});

test('flags a JWT-looking eyJ token', () => {
  const hits = scanForSecrets('auth eyJhbGciOiJIUzI1Ni');
  assert.ok(hits.some((h) => h.kind === 'jwt'));
});

test('does not flag ordinary prose', () => {
  const hits = scanForSecrets('the quick brown fox jumps over the lazy dog');
  assert.equal(hits.length, 0);
});

test('flags sk- and xoxb- prefixes', () => {
  assert.ok(scanForSecrets('sk-abcd1234abcd1234abcd1234').some((h) => h.kind === 'openai-key'));
  assert.ok(scanForSecrets('xoxb-111-222-aaaaaaaaaaaa').some((h) => h.kind === 'slack-token'));
});

test('flags modern sk-proj- and sk-svcacct- OpenAI key formats', () => {
  assert.ok(
    scanForSecrets('sk-proj-abcdefghijklmnop').some((h) => h.kind === 'openai-key'),
    'sk-proj- key not detected',
  );
  assert.ok(
    scanForSecrets('sk-svcacct-abcdefghijklmnop').some((h) => h.kind === 'openai-key'),
    'sk-svcacct- key not detected',
  );
  assert.equal(
    scanForSecrets('sk-short').filter((h) => h.kind === 'openai-key').length,
    0,
    'short sk- must not flag',
  );
});

test('does not flag sk- prefixed hyphenated prose (false-positive guard)', () => {
  assert.equal(
    scanForSecrets('sk-this-is-a-hyphenated-phrase-that-is-long').filter(
      (h) => h.kind === 'openai-key',
    ).length,
    0,
    'hyphenated prose must not flag as openai-key',
  );
  assert.equal(
    scanForSecrets('the sk-learning-rate-was-set-to-low value').filter(
      (h) => h.kind === 'openai-key',
    ).length,
    0,
    'sk- prefixed hyphenated sentence must not flag',
  );
});

test('CLI: reports findings with masked match and does not print full secret', () => {
  const secret = 'ghp_' + randomBytes(20).toString('hex').slice(0, 30);
  const tmp = join(tmpdir(), `redact-scan-test-${randomBytes(4).toString('hex')}.txt`);
  try {
    writeFileSync(tmp, `api_key = ${secret}\n`);
    let out = '';
    try {
      out = execFileSync('node', [SCRIPT, tmp], { encoding: 'utf-8' });
    } catch (err) {
      out = err.stdout ?? '';
    }
    assert.ok(out.includes('github-pat'), 'expected kind in output');
    assert.ok(!out.includes(secret), 'full secret must not appear in output');
    assert.ok(out.includes('***'), 'expected masking characters in output');
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
});
