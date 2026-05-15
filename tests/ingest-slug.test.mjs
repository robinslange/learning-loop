import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlug } from '../scripts/ingest-slug.mjs';

test('uses origin url hash when origin available', () => {
  const slug = computeSlug('/path/to/learning-loop', 'git@github.com:robinslange/learning-loop.git');
  assert.match(slug, /^learning-loop-[0-9a-f]{6}$/);
});

test('moved repo with same origin produces same slug', () => {
  const slug1 = computeSlug('/path/A/learning-loop', 'git@github.com:robinslange/learning-loop.git');
  const slug2 = computeSlug('/path/B/learning-loop', 'git@github.com:robinslange/learning-loop.git');
  assert.equal(slug1, slug2);
});

test('falls back to path hash when no origin', () => {
  const slug = computeSlug('/path/to/foo', null);
  assert.match(slug, /^foo-[0-9a-f]{6}$/);
});

test('different basenames with same origin still differ', () => {
  const s1 = computeSlug('/path/to/foo', 'git@example.com:org/foo.git');
  const s2 = computeSlug('/path/to/bar', 'git@example.com:org/bar.git');
  assert.notEqual(s1, s2);
});

test('moved repo with no origin produces different slug (orphan acceptable)', () => {
  const s1 = computeSlug('/path/A/foo', null);
  const s2 = computeSlug('/path/B/foo', null);
  assert.notEqual(s1, s2);
});
