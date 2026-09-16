// DATE NORMALIZE, as a deterministic function rather than model judgement.
//
// The operator has a measured history of costing more than it returns: across
// five /dream runs it matched 44 times and applied ZERO conversions, and the
// run before that matched 38 files of which ~0 were genuine. Worse than the
// waste, a run that applied its matches corrupted prose -- the vault's own
// tooling-gotchas note now reads "no tag concept in the data model 2026-08-05",
// which was "...in the data model today" before an ISO date was substituted
// into a tense-word.
//
// So the rule is: convert only a reference that resolves to ONE calendar day
// the reader would otherwise have to reconstruct, and stay silent everywhere
// else. Silence is cheap (the date stays relative); a wrong rewrite edits the
// meaning of a note nobody will re-read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText } from '../plugin/scripts/dream-normalize.mjs';

const ANCHOR = '2026-09-16';

test('the anchor used by the weekday cases is the weekday they assume', () => {
  // Self-check. Without it, a wrong assumption here would silently make every
  // "last Thursday" expectation below test the wrong arithmetic.
  assert.equal(new Date(`${ANCHOR}T00:00:00Z`).getUTCDay(), 3, 'anchor must be a Wednesday');
});

// --- conversions: references that resolve to exactly one day ---

test('converts yesterday and tomorrow against the anchor', () => {
  assert.equal(normalizeText('shipped it yesterday', ANCHOR).text, 'shipped it 2026-09-15');
  assert.equal(normalizeText('due tomorrow', ANCHOR).text, 'due 2026-09-17');
});

test('converts N days ago, in digits and small words', () => {
  assert.equal(normalizeText('paid 3 days ago', ANCHOR).text, 'paid 2026-09-13');
  assert.equal(normalizeText('paid two days ago', ANCHOR).text, 'paid 2026-09-14');
});

test('converts N weeks ago', () => {
  assert.equal(normalizeText('agreed 2 weeks ago', ANCHOR).text, 'agreed 2026-09-02');
});

test('converts last and next weekday to the nearest such day', () => {
  // Anchor is Wednesday 2026-09-16.
  assert.equal(normalizeText('met last Thursday', ANCHOR).text, 'met 2026-09-10');
  assert.equal(normalizeText('meets next Thursday', ANCHOR).text, 'meets 2026-09-17');
});

test('reports every change it made, with the original text', () => {
  const { changes } = normalizeText('shipped yesterday', ANCHOR);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, 'yesterday');
  assert.equal(changes[0].to, '2026-09-15');
});

// --- silence: the false-positive shapes measured in the real corpus ---

test('leaves tense-words alone', () => {
  // "today/recently/currently" almost always mean "as things stand", not a
  // day. This is the exact substitution that damaged the gotchas note.
  for (const s of [
    'no tag concept in the data model today',
    'a recently-launched product',
    'Most recently Founding Engineer at Kinso',
    'the .gitignore currently covers it',
  ]) {
    assert.equal(normalizeText(s, ANCHOR).text, s, `must not rewrite: ${s}`);
  }
});

test('leaves quoted and backticked text alone', () => {
  // Memories that DOCUMENT the rule quote the trigger words. Rewriting them
  // corrupts the documentation of the thing doing the rewriting.
  for (const s of [
    'phrase it relative to now ("today", "yesterday", "two days ago")',
    "never generate 'last week' from a stored date",
    'the `yesterday` keyword is matched verbatim',
  ]) {
    assert.equal(normalizeText(s, ANCHOR).text, s, `must not rewrite: ${s}`);
  }
});

test('leaves a line that already carries an absolute date alone', () => {
  const s = 'redundant last week (confirmed 2026-04-22)';
  assert.equal(normalizeText(s, ANCHOR).text, s);
});

test('leaves conversion-log records alone', () => {
  // _dream_log.md records past conversions as `"x" -> "y"`. Re-matching them
  // every run is where most of the 44 no-op hits came from.
  const s = '- `project_halter.md`: "this year" -> "in 2026"; "redundant last week" -> "2026-04-22"';
  assert.equal(normalizeText(s, ANCHOR).text, s);
});

test('leaves fenced code and frontmatter alone', () => {
  const fenced = ['```bash', 'echo yesterday', '```'].join('\n');
  assert.equal(normalizeText(fenced, ANCHOR).text, fenced);

  const fm = ['---', 'description: what I did yesterday', '---', 'body'].join('\n');
  assert.equal(normalizeText(fm, ANCHOR).text, fm);
});

test('leaves a bare week reference alone: it names a span, not a day', () => {
  // "last week" resolves to seven candidate days. Picking one is judgement,
  // and judgement is what this function exists to avoid.
  const s = 'we discussed it last week';
  assert.equal(normalizeText(s, ANCHOR).text, s);
});

test('makes no change and reports none when there is nothing to convert', () => {
  const { text, changes } = normalizeText('a note with no temporal reference', ANCHOR);
  assert.equal(text, 'a note with no temporal reference');
  assert.deepEqual(changes, []);
});
