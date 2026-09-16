import { test } from 'node:test';
import assert from 'node:assert';
import { semverCmp, isPlainSemver } from '../plugin/scripts/lib/semver.mjs';

test('semverCmp orders X.Y.Z correctly across all positions', () => {
  assert.ok(semverCmp('1.0.0', '2.0.0') < 0);
  assert.ok(semverCmp('2.0.0', '1.0.0') > 0);
  assert.ok(semverCmp('1.0.0', '1.1.0') < 0);
  assert.ok(semverCmp('1.1.0', '1.0.0') > 0);
  assert.ok(semverCmp('1.16.12', '1.16.13') < 0);
  assert.ok(semverCmp('1.16.13', '1.16.12') > 0);
  assert.strictEqual(semverCmp('1.16.13', '1.16.13'), 0);
});

test('semverCmp handles double-digit components without lexical-order bugs', () => {
  // 1.10.0 must be greater than 1.9.0 (lexical compare would say "1.10" < "1.9")
  assert.ok(semverCmp('1.10.0', '1.9.0') > 0);
  assert.ok(semverCmp('1.16.13', '1.5.99') > 0);
  assert.ok(semverCmp('2.0.0', '1.99.99') > 0);
  assert.ok(semverCmp('10.0.0', '9.99.99') > 0);
});

test('isPlainSemver accepts only X.Y.Z form', () => {
  assert.strictEqual(isPlainSemver('1.16.13'), true);
  assert.strictEqual(isPlainSemver('0.0.1'), true);
  assert.strictEqual(isPlainSemver('100.200.300'), true);

  // Reject anything that is not a plain release version.
  assert.strictEqual(isPlainSemver('1.16.13.bak'), false);
  assert.strictEqual(isPlainSemver('1.16'), false);
  assert.strictEqual(isPlainSemver('1.16.13-beta'), false);
  assert.strictEqual(isPlainSemver('v1.16.13'), false);
  assert.strictEqual(isPlainSemver(''), false);
  assert.strictEqual(isPlainSemver('node_modules'), false);
  assert.strictEqual(isPlainSemver('1.16.13/'), false);
});
