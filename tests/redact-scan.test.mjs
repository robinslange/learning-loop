import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanForSecrets, __test__ } from '../plugin/scripts/redact-scan.mjs';
import { SECRET_PATTERNS } from '../plugin/scripts/lib/secret-patterns.mjs';

const SCRIPT = fileURLToPath(new URL('../plugin/scripts/redact-scan.mjs', import.meta.url));

test('flags known credential prefixes (github-pat)', () => {
  const hits = scanForSecrets('token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 done');
  assert.ok(hits.some((h) => h.kind === 'github-pat'));
});

test('flags a JWT-looking eyJ token', () => {
  const hits = scanForSecrets('auth eyJhbGciOiJIUzI1Ni');
  assert.ok(hits.some((h) => h.kind === 'jwt'));
});

test('redact-scan matches Anthropic API keys', () => {
  const hits = scanForSecrets('key is sk-ant-api03-' + 'a'.repeat(80));
  assert.ok(hits.some((h) => h.kind.includes('anthropic') || h.kind.includes('key')));
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

test('CLI: skips binary .db files and scans .jsonl files in the same invocation', () => {
  const secret = 'ghp_' + randomBytes(20).toString('hex').slice(0, 30);
  const prefix = randomBytes(4).toString('hex');
  const tmpText = join(tmpdir(), `redact-scan-test-${prefix}.jsonl`);
  const tmpDb = join(tmpdir(), `redact-scan-test-${prefix}.db`);
  try {
    writeFileSync(tmpText, JSON.stringify({ token: secret }) + '\n');
    writeFileSync(tmpDb, `eyJhbGciOiJIUzI1NiIseyJhbGciOiJIUzI1Ni ${secret}\n`);
    let out = '';
    let stderr = '';
    try {
      out = execFileSync('node', [SCRIPT, tmpText, tmpDb], { encoding: 'utf-8' });
    } catch (err) {
      out = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    assert.ok(out.includes('github-pat'), 'expected .jsonl hit in output');
    assert.ok(!out.includes(tmpDb), '.db path must not appear in findings output');
    assert.ok(stderr.includes('skipping binary file'), 'expected skip notice for .db on stderr');
  } finally {
    for (const f of [tmpText, tmpDb]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
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

// The scrubber and the scanner are two halves of one promise: the scrubber
// keeps secrets out of new records, the scanner finds what earlier bugs already
// wrote. A pattern in one and not the other means /doctor --redact reports
// clean on a file that holds a private key.
describe('redact-scan covers the shared vocabulary', () => {
  it('finds a PEM private key', () => {
    const text =
      'leaked: -----BEGIN RSA PRIVATE KEY-----\n' +
      'MIIEowIBAAKCAQEA' +
      'QWERTYUIOPasdfghjkl0123456789+/'.repeat(4) +
      '\n-----END RSA PRIVATE KEY-----';
    const kinds = scanForSecrets(text).map((h) => h.kind);
    assert.ok(kinds.includes('pem-key'), `expected a pem-key hit, got ${JSON.stringify(kinds)}`);
  });

  it('carries a counterpart for every shared secret pattern', () => {
    const scannerKinds = new Set(__test__.PATTERNS.map((p) => p.kind));
    const missing = SECRET_PATTERNS.map((p) => p.kind).filter((k) => !scannerKinds.has(k));
    assert.deepEqual(
      missing,
      [],
      `shared patterns with no redact-scan counterpart: ${missing.join(', ')}`,
    );
  });
});
