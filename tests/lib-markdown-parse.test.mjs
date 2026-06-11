import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  stripFrontmatter,
  parseTags,
  extractWikilinks,
} from '../plugin/scripts/lib/markdown-parse.mjs';

test('parseFrontmatter returns empty fm + original body when no frontmatter', () => {
  const { fm, body } = parseFrontmatter('hello\n\nworld');
  assert.deepEqual(fm, {});
  assert.equal(body, 'hello\n\nworld');
});

test('parseFrontmatter handles empty input', () => {
  assert.deepEqual(parseFrontmatter(''), { fm: {}, body: '' });
  assert.deepEqual(parseFrontmatter(null), { fm: {}, body: '' });
  assert.deepEqual(parseFrontmatter(undefined), { fm: {}, body: '' });
});

test('parseFrontmatter parses scalar keys', () => {
  const { fm, body } = parseFrontmatter('---\ntitle: foo\nstatus: open\n---\nbody');
  assert.equal(fm.title, 'foo');
  assert.equal(fm.status, 'open');
  assert.equal(body, 'body');
});

test('parseFrontmatter strips quotes from scalar values', () => {
  const { fm } = parseFrontmatter('---\ntitle: "quoted"\nother: \'single\'\n---\n');
  assert.equal(fm.title, 'quoted');
  assert.equal(fm.other, 'single');
});

test('parseFrontmatter parses inline array', () => {
  const { fm } = parseFrontmatter('---\ntags: [a, b, "c d"]\n---\n');
  assert.deepEqual(fm.tags, ['a', 'b', 'c d']);
});

test('parseFrontmatter parses empty inline array', () => {
  const { fm } = parseFrontmatter('---\ntags: []\n---\n');
  assert.deepEqual(fm.tags, []);
});

test('parseFrontmatter handles CRLF line endings', () => {
  const { fm, body } = parseFrontmatter('---\r\ntitle: hi\r\n---\r\nbody');
  assert.equal(fm.title, 'hi');
  assert.equal(body, 'body');
});

test('parseFrontmatter handles lines without colons (ignored silently)', () => {
  const { fm } = parseFrontmatter('---\nthis is not yaml\n---\nbody');
  assert.deepEqual(fm, {});
});

test('parseFrontmatter handles value with colon in it', () => {
  const { fm } = parseFrontmatter('---\nurl: http://example.com\n---\n');
  assert.equal(fm.url, 'http://example.com');
});

test('parseFrontmatter body has no leading newline after triple-dash', () => {
  const { body } = parseFrontmatter('---\ntitle: x\n---\nbody content');
  assert.equal(body, 'body content');
});

test('parseFrontmatter returns whole text as body when no closing ---', () => {
  const text = '---\ntitle: x\nno close';
  const { fm, body } = parseFrontmatter(text);
  assert.deepEqual(fm, {});
  assert.equal(body, text);
});

test('parseTags accepts inline array', () => {
  assert.deepEqual(parseTags({ tags: ['a', 'b'] }), ['a', 'b']);
});

test('parseTags accepts comma-separated string', () => {
  assert.deepEqual(parseTags({ tags: 'a, b, c' }), ['a', 'b', 'c']);
});

test('parseTags accepts whitespace-separated string', () => {
  assert.deepEqual(parseTags({ tags: 'a b  c' }), ['a', 'b', 'c']);
});

test('parseTags handles empty string', () => {
  assert.deepEqual(parseTags({ tags: '' }), []);
});

test('parseTags handles missing tags key', () => {
  assert.deepEqual(parseTags({}), []);
});

test('parseTags handles null/undefined fm', () => {
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags(undefined), []);
});

test('parseTags filters empty strings from array', () => {
  assert.deepEqual(parseTags({ tags: ['a', '', 'b'] }), ['a', 'b']);
});

test('extractWikilinks returns targets and deduplicates', () => {
  assert.deepEqual(
    extractWikilinks('see [[alpha]] and [[beta]] and [[alpha]] again'),
    ['alpha', 'beta'],
  );
});

test('extractWikilinks strips aliases', () => {
  assert.deepEqual(
    extractWikilinks('[[target|alias]] and [[other]]'),
    ['target', 'other'],
  );
});

test('extractWikilinks handles empty/edge cases', () => {
  assert.deepEqual(extractWikilinks(''), []);
  assert.deepEqual(extractWikilinks('plain text no links'), []);
  assert.deepEqual(extractWikilinks('[[]]'), []);
  assert.deepEqual(extractWikilinks(null), []);
  assert.deepEqual(extractWikilinks(undefined), []);
});

test('extractWikilinks preserves first-occurrence order', () => {
  assert.deepEqual(
    extractWikilinks('[[c]] then [[a]] then [[b]] then [[c]] again'),
    ['c', 'a', 'b'],
  );
});

test('extractWikilinks handles alias with spaces', () => {
  assert.deepEqual(extractWikilinks('[[my note|display text]]'), ['my note']);
});

test('stripFrontmatter returns body only', () => {
  assert.equal(stripFrontmatter('---\ntitle: x\n---\nbody'), 'body');
  assert.equal(stripFrontmatter('no fm'), 'no fm');
  assert.equal(stripFrontmatter(''), '');
});
