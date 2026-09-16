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
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { normalizeText } from '../plugin/scripts/dream-normalize.mjs';

const ROOT = join(import.meta.dirname, '..');
const DREAM = join(ROOT, 'plugin', 'skills', 'dream');
// One spelling of the script's path. The operator names it in prose, the CLI
// cases spawn it, and the import at the top of this file binds it -- three
// places that must agree about one filename, so they all derive from here.
const SCRIPT = join(ROOT, 'plugin', 'scripts', 'dream-normalize.mjs');
const MOD = JSON.stringify(pathToFileURL(SCRIPT).href);

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

// --- the shapes two adversarial reviews fed it until it corrupted something ---
//
// Every row below was CONFIRMED rewriting real text, one of them reproduced on
// disk with --apply. They are asserted as "unchanged" because the operator's
// stated bias is silence: the defect is always that it edited something it had
// no business editing. The wikilink rows are the worst of them -- this is a
// wikilink vault and pre-write-check warns on broken wikilinks, so the operator
// was manufacturing exactly the breakage the write gate reports.
//
// Fails if: the structural spans stop being collected, the numeric lookbehind
// is relaxed, the hyphen lookarounds revert to \b, single quotes are collected
// before double quotes again, the delimiter scan stops carrying across lines,
// or fence handling drops ~~~ / indented code.
const MUST_NOT_CHANGE = [
  ['a wikilink target is a link, not prose', 'see [[2 weeks ago in review]]'],
  ['a piped wikilink too', 'see [[yesterday|the note]]'],
  ['a hyphenated wikilink target', 'See [[yesterday-standup]] for the notes'],
  ['a URL path segment is not a date', 'https://example.com/2-weeks-ago/yesterday'],
  ['nor is one mid-URL', 'Docs: https://ex.com/tomorrow/plan'],
  ['nor a bare www URL', 'ref www.example.com/yesterday/x'],
  ['nor a markdown link target', 'see [the note](./2-weeks-ago.md)'],
  ['a thousands separator is not a count', 'paid 1,000 days ago'],
  ['nor is a decimal fraction', 'took 1.5 days ago'],
  ['a hyphenated suffix is one token', 'a two days ago-style note'],
  ['so is a hyphenated prefix', 'a non-yesterday problem'],
  ['so is a hyphenated compound', 'A yesterday-only workaround.'],
  ['an apostrophe must not open a quote span', 'it\'s a rule: "don\'t say yesterday"'],
  ['a possessive before a quote is safe too', 'the team\'s rule: "never write yesterday"'],
  ['a quote that closes on the next line', 'he said "remember yesterday\nand nothing else" ok'],
  ['the second line of a multi-line quote', 'he said "remember\nyesterday" clearly'],
  ['an unterminated code span', 'the `yesterday keyword and yesterday again'],
  ['a tilde fence is a fence', '~~~bash\necho yesterday\n~~~'],
  ['four spaces open a code block', '    echo yesterday'],
  ['so does a tab', '\techo yesterday'],
];

// The other half of the contract. A fix that simply stopped converting would
// satisfy every assertion above, so these pin that the operator still works --
// including the case the old quote handling wrongly SUPPRESSED.
const MUST_CONVERT = [
  ['capitalised at the start of a sentence', 'Yesterday we shipped', '2026-09-15 we shipped'],
  ['two references on one line', 'yesterday and tomorrow', '2026-09-15 and 2026-09-17'],
  ['a reference ending a sentence', 'it shipped yesterday.', 'it shipped 2026-09-15.'],
  [
    'apostrophes on both sides of it',
    "don't ship it yesterday, it's fine",
    "don't ship it 2026-09-15, it's fine",
  ],
  [
    'a leading --- is a thematic break, not frontmatter',
    '---\nbody says yesterday\nmore yesterday',
    '---\nbody says 2026-09-15\nmore 2026-09-15',
  ],
];

for (const [name, input] of MUST_NOT_CHANGE) {
  test(`leaves it alone: ${name}`, () => {
    assert.equal(normalizeText(input, ANCHOR).text, input);
  });
}

for (const [name, input, expected] of MUST_CONVERT) {
  test(`still converts: ${name}`, () => {
    assert.equal(normalizeText(input, ANCHOR).text, expected);
  });
}

// --- the module is only a fix if /dream actually calls it ---

// Everything above can be perfect and change nothing. The first version of
// this work shipped the module and thirteen passing tests while SKILL.md still
// said "flag candidates" and operators/normalize.md still said "use Edit tool
// to replace relative dates" -- a repo-wide grep for the module found only
// itself and this file. A green suite over an unreachable module reads exactly
// like a fix, which is the most expensive kind of green there is.
test('the DATE NORMALIZE operator runs the script instead of editing by judgement', () => {
  // Renaming the module breaks the import above loudly. What this pins is the
  // quieter half: the operator names the command in prose, so the doc can be
  // reworded to invoke something that is not there while every test still
  // loads. The expected command is derived from SCRIPT rather than written out
  // again, so the doc and the file cannot drift apart.
  assert.ok(existsSync(SCRIPT), `the operator invokes ${basename(SCRIPT)}, which must exist`);
  const operator = readFileSync(join(DREAM, 'operators', 'normalize.md'), 'utf8');
  assert.match(
    operator,
    new RegExp(`ll-run\\s+${basename(SCRIPT).replace(/\./g, '\\.')}`),
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
