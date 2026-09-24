import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagValue, hasFlag, UsageError } from '../plugin/scripts/lib/cli-args.mjs';

test('flagValue returns the value after the flag', () => {
  assert.equal(flagValue(['--db', '/tmp/edges.db', '--execute'], '--db'), '/tmp/edges.db');
});

test('flagValue returns the default when the flag is absent', () => {
  assert.equal(flagValue(['--execute'], '--db'), null);
  assert.equal(flagValue(['--execute'], '--top', '10'), '10');
});

test('flagValue refuses the next flag as its value', () => {
  assert.throws(() => flagValue(['--db', '--execute'], '--db'), UsageError);
  assert.throws(() => flagValue(['--top', '--rerank'], '--top', '10'), UsageError);
});

test('flagValue refuses a trailing flag with no value', () => {
  assert.throws(() => flagValue(['--execute', '--db'], '--db'), UsageError);
  assert.throws(() => flagValue(['--limit'], '--limit', '0'), UsageError);
});

test('flagValue accepts a single-dash value such as a negative number', () => {
  assert.equal(flagValue(['--offset', '-1'], '--offset'), '-1');
});

test('the UsageError names the flag', () => {
  assert.throws(() => flagValue(['--db'], '--db'), /--db/);
});

test('hasFlag reports presence only', () => {
  assert.equal(hasFlag(['--db', '--execute'], '--execute'), true);
  assert.equal(hasFlag(['--db', 'x'], '--execute'), false);
});
