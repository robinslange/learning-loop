import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSums, verifyArtifact, isAllowedRedirect } from '../plugin/scripts/lib/artifact-verify.mjs';

test('parseSums maps filenames to hashes (sha256sum format, ignores blank/comment lines)', () => {
  const sums = 'aaaa  ll-search-darwin-arm64.tar.gz\nbbbb *ll-search-linux-x64.tar.gz\n\n';
  assert.deepEqual(parseSums(sums), {
    'll-search-darwin-arm64.tar.gz': 'aaaa',
    'll-search-linux-x64.tar.gz': 'bbbb',
  });
});

test('parseSums rejects a hash that is not anchored to the start of the line', () => {
  assert.deepEqual(parseSums('# comment aaaa  file.tar.gz'), {});
});

test('parseSums rejects a line with trailing content after the filename', () => {
  assert.deepEqual(parseSums('aaaabbbb  file.tar.gz extra-junk'), {});
});

test('verifyArtifact passes on matching hash and fails on mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-av-'));
  const file = join(dir, 'a.tar.gz');
  writeFileSync(file, 'hello');
  const good = createHash('sha256').update('hello').digest('hex');
  assert.equal(verifyArtifact(file, `${good}  a.tar.gz`, 'a.tar.gz'), true);
  assert.throws(
    () => verifyArtifact(file, `${'0'.repeat(64)}  a.tar.gz`, 'a.tar.gz'),
    /sha256 mismatch/i,
  );
});

test('verifyArtifact throws a distinct error when the artifact is missing from sums', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-av-'));
  const file = join(dir, 'b.tar.gz');
  writeFileSync(file, 'x');
  assert.throws(() => verifyArtifact(file, 'aaaa  other.tar.gz', 'b.tar.gz'), /not listed/i);
});

test('isAllowedRedirect permits https and rejects http/other schemes', () => {
  assert.equal(isAllowedRedirect('https://objects.github.com/x'), true);
  assert.equal(isAllowedRedirect('http://evil.example/x'), false);
  assert.equal(isAllowedRedirect('ftp://x/y'), false);
});

test('isAllowedRedirect rejects non-string values', () => {
  assert.equal(isAllowedRedirect(undefined), false);
  assert.equal(isAllowedRedirect(null), false);
  assert.equal(isAllowedRedirect(42), false);
});
