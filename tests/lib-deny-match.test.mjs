import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyTermMatches, denyTermRegExp } from '../plugin/scripts/lib/deny-match.mjs';

// The security contract from the module header: a bare term matches
// case-insensitively on alphanumeric word boundaries (hyphen, underscore, dot
// are boundaries), regex-escaped, but NOT when embedded inside a longer word.

test('matches on hyphen/underscore/dot boundaries', () => {
  assert.equal(denyTermMatches('acme', 'acme-registry'), true);
  assert.equal(denyTermMatches('acme', 'acme_registry'), true);
  assert.equal(denyTermMatches('acme', 'acme.co'), true);
  assert.equal(denyTermMatches('acme', 'the acme thing'), true);
});

test('does NOT match a term embedded inside a longer word', () => {
  assert.equal(denyTermMatches('acme', 'acmecorp'), false);
  assert.equal(denyTermMatches('ai', 'maintainer'), false);
  assert.equal(denyTermMatches('ai', 'fail'), false);
});

test('is case-insensitive', () => {
  assert.equal(denyTermMatches('ACME', 'acme-registry'), true);
  assert.equal(denyTermMatches('acme', 'ACME-REGISTRY'), true);
  assert.equal(denyTermMatches('AcMe', 'the ACME co'), true);
});

test('regex metacharacters in the term are escaped (treated literally)', () => {
  // A dot in the term must match a literal dot, not any char.
  assert.equal(denyTermMatches('a.c', 'a.c'), true);
  assert.equal(denyTermMatches('a.c', 'abc'), false, 'dot is literal, not wildcard');
  // Parens/brackets must not blow up or act as groups.
  assert.equal(denyTermMatches('foo(bar)', 'foo(bar)'), true);
  assert.equal(denyTermMatches('a+b', 'a+b'), true);
  assert.equal(denyTermMatches('a+b', 'aaab'), false);
});

test('empty/whitespace/non-string term never matches', () => {
  assert.equal(denyTermMatches('', 'anything'), false);
  assert.equal(denyTermMatches('   ', 'anything'), false);
  // A whitespace-only term must be rejected even when its regex WOULD match
  // the haystack (a space bounded by non-alphanumerics). This pins the
  // .trim() guard specifically: without it, `' '` would match `-- --`.
  assert.equal(denyTermMatches(' ', '-- --'), false);
  assert.equal(denyTermMatches(null, 'anything'), false);
  assert.equal(denyTermMatches(undefined, 'anything'), false);
  assert.equal(denyTermMatches(42, 'anything'), false);
});

test('term absent from haystack does not match', () => {
  assert.equal(denyTermMatches('acme', 'globex only'), false);
  assert.equal(denyTermMatches('acme', ''), false);
});

test('denyTermRegExp is case-insensitive and boundary-anchored', () => {
  const re = denyTermRegExp('acme');
  assert.equal(re.flags.includes('i'), true, 'case-insensitive flag set');
  assert.equal(re.test('ACME-x'), true);
  assert.equal(re.test('acmecorp'), false);
});
