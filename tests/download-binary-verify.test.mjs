// tests/download-binary-verify.test.mjs
// Pins the downloader's verification pipeline:
//   1. verifyAgainstSums is the single verify step main() runs between
//      download and extraction (mutation survivor: deleting the call left
//      every test green).
//   2. SUMS-404 race (dist review F4): releases >= v1.27.0 always ship
//      SHA256SUMS, so a 404 on SUMS for those tags means the release is
//      mid-build — retry next session (exit 0, no stamp), never install
//      unverified.
//   3. Fail closed: a 404 on SUMS for a tag that does NOT meet sumsRequired
//      (pre-1.27 / non-semver / 'latest') now REFUSES the install (exit 1)
//      rather than installing an unverified binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyAgainstSums, sumsRequired } from '../plugin/scripts/download-binary.mjs';

const DL_PATH = fileURLToPath(new URL('../plugin/scripts/download-binary.mjs', import.meta.url));

test('verifyAgainstSums verifies a matching artifact and throws on mismatch', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'll-dlverify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.tar.gz');
  writeFileSync(file, 'hello');
  const good = createHash('sha256').update('hello').digest('hex');
  assert.equal(verifyAgainstSums(file, 'a.tar.gz', `${good}  a.tar.gz`), true);
  assert.throws(
    () => verifyAgainstSums(file, 'a.tar.gz', `${'0'.repeat(64)}  a.tar.gz`),
    /sha256 mismatch/i,
  );
});

test('verifyAgainstSums skips (returns false) only for a null sumsText', () => {
  assert.equal(verifyAgainstSums('/nonexistent', 'a.tar.gz', null), false);
});

test('sumsRequired: >= 1.27.0 tags require SUMS; pre-1.27 and non-semver tags do not', () => {
  assert.equal(sumsRequired('v1.27.0'), true);
  assert.equal(sumsRequired('v1.27.1'), true);
  assert.equal(sumsRequired('v2.0.0'), true);
  assert.equal(sumsRequired('v1.26.0'), false);
  assert.equal(sumsRequired('v1.26.99'), false);
  assert.equal(sumsRequired('latest'), false);
  assert.equal(sumsRequired(''), false);
});

test('main() fails closed on a missing SUMS: a 404 for a non-required tag refuses, never installs unverified', () => {
  const src = readFileSync(DL_PATH, 'utf8');
  const sumsStart = src.indexOf('const sumsUrl');
  assert.ok(sumsStart > -1, 'main() must fetch a SHA256SUMS url');
  const branch = src.slice(sumsStart, sumsStart + 900);
  assert.match(
    branch,
    /Refusing to install/,
    'the non-required 404 path must refuse the install, not warn-and-skip verification',
  );
  assert.match(branch, /process\.exit\(1\)/, 'refusing to install must exit non-zero');
  assert.doesNotMatch(
    branch,
    /skipping verification/,
    'the fail-open "skipping verification" path must be gone',
  );
});

test('main() wires the verify pipeline: verifyAgainstSums before extraction, sumsRequired on the 404 branch', () => {
  // Call-site contract: the exported helpers are only meaningful if the live
  // path actually invokes them. Deleting either call must turn this red.
  const src = readFileSync(DL_PATH, 'utf8');
  const mainStart = src.indexOf('async function main');
  assert.ok(mainStart > -1, 'download-binary.mjs must define main()');
  const mainSrc = src.slice(mainStart);

  const verifyIdx = mainSrc.indexOf('verifyAgainstSums(tmpPath, artifact, sumsText)');
  assert.ok(
    verifyIdx > -1,
    'main() must verify the downloaded artifact via verifyAgainstSums(tmpPath, artifact, sumsText)',
  );
  const extractIdx = mainSrc.indexOf('Extracting');
  assert.ok(extractIdx > -1, 'main() must have an extraction step');
  assert.ok(verifyIdx < extractIdx, 'verification must run BEFORE extraction');

  assert.match(
    mainSrc,
    /sumsRequired\(tag\)/,
    'the SUMS-404 branch must consult sumsRequired(tag): a >= 1.27.0 release with no ' +
      'SHA256SUMS is still building — exit 0 without stamping instead of installing unverified',
  );
});
