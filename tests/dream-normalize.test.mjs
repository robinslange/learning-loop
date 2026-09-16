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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { normalizeText } from '../plugin/scripts/dream-normalize.mjs';

const ROOT = join(import.meta.dirname, '..');
const DREAM = join(ROOT, 'plugin', 'skills', 'dream');
const MOD = JSON.stringify(
  pathToFileURL(join(ROOT, 'plugin', 'scripts', 'dream-normalize.mjs')).href,
);

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

test('normalizeFile anchors on the LOCAL calendar date of mtime, not the UTC one', () => {
  // Forced timezone, in a subprocess, because this bug is INVISIBLE in UTC by
  // definition: UTC is where the two dates agree. East of Greenwich they do
  // not. A file modified at 10:00 on 2026-09-16 in Pacific/Auckland (UTC+12,
  // before NZ daylight saving starts on the 27th) is 22:00 UTC on the 15th, so
  // a toISOString anchor reads a day early and shifts every conversion in that
  // file by one -- inside the one operator whose whole job is producing a
  // correct date. Every file touched between local midnight and local noon is
  // affected, which on the maintainer's own machine is most of them.
  const snippet = `
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const m = await import(${MOD});
const dir = mkdtempSync(join(tmpdir(), 'll-tz-'));
const f = join(dir, 'note.md');
writeFileSync(f, 'shipped it yesterday\\n');
const t = Date.parse('2026-09-15T22:00:00Z') / 1000;
utimesSync(f, t, t);
console.log(m.normalizeFile(f).anchorISO);
`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', snippet], {
    encoding: 'utf-8',
    env: { ...process.env, TZ: 'Pacific/Auckland' },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout.trim(),
    '2026-09-16',
    'the anchor must be the date the file was modified where the user lives, not in UTC',
  );
});

// --- the module is only a fix if /dream actually calls it ---

// Everything above can be perfect and change nothing. The first version of
// this work shipped the module and thirteen passing tests while SKILL.md still
// said "flag candidates" and operators/normalize.md still said "use Edit tool
// to replace relative dates" -- a repo-wide grep for the module found only
// itself and this file. A green suite over an unreachable module reads exactly
// like a fix, which is the most expensive kind of green there is.
test('the DATE NORMALIZE operator runs the script instead of editing by judgement', () => {
  const operator = readFileSync(join(DREAM, 'operators', 'normalize.md'), 'utf8');
  assert.match(
    operator,
    /ll-run dream-normalize\.mjs/,
    'the operator must invoke the deterministic script',
  );
  assert.doesNotMatch(
    operator,
    /Use Edit tool to replace relative dates/i,
    'the hand-edit instruction is the path the script replaces',
  );
});

test('the skill does not flag a form the script refuses to convert', () => {
  // "last week" names a span of seven days, so the module leaves it alone on
  // purpose. A flagging step that still lists it sends the operator to a file
  // where nothing happens, and the two halves disagree about their own
  // contract -- which is how the operator earned 44 matches and 0 conversions.
  const skill = readFileSync(join(DREAM, 'SKILL.md'), 'utf8');
  const flagStep = skill.slice(
    skill.indexOf('**Flag DATE NORMALIZE candidates.**'),
    skill.indexOf('**Flag MERGE candidates.**'),
  );
  assert.ok(flagStep.length > 0, 'the Phase 2 flagging step must still exist to be checked');
  assert.doesNotMatch(
    flagStep,
    /last week/i,
    'the script will not convert a bare week reference, so do not flag files for it',
  );
});
