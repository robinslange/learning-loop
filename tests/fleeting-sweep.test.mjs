import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipOnWindows } from './helpers/platform.mjs';

const SKIP = skipOnWindows('bash: fleeting-sweep.sh requires bash, not available on win32');

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'scripts',
  'fleeting-sweep.sh',
);

function makeVault() {
  const vault = mkdtempSync(join(tmpdir(), 'll-sweep-'));
  for (const d of ['0-inbox', '1-fleeting', '3-permanent', '4-projects']) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  return vault;
}

function run(vault) {
  return execFileSync('bash', [SCRIPT, vault], { encoding: 'utf8' });
}

const OLD = new Date(Date.now() - 90 * 86400 * 1000);

// IMPORTANT: this test file is COMMITTED AND PUBLIC. It must never contain the
// actual instance-specific names being removed (that would re-leak them — the
// exact thing this fix exists for). Assert the structure, not the names:
test('no hardcoded slug list: slugs must derive from 4-projects/', { skip: SKIP }, () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /PROJECT_SLUGS="[^"]*\|/, 'pipe-delimited literal slug list found');
  assert.match(src, /4-projects/, 'slug derivation from project index notes missing');
});

test('stale note matching a 4-projects slug is reported STALE', { skip: SKIP }, () => {
  const vault = makeVault();
  writeFileSync(join(vault, '4-projects', 'foo-tracker.md'), '# foo');
  const note = join(vault, '1-fleeting', 'foo-tracker-launch-idea.md');
  writeFileSync(note, 'old unlinked note');
  utimesSync(note, OLD, OLD);
  assert.match(run(vault), /^STALE\tfoo-tracker-launch-idea\t/m);
});

test('empty 4-projects: no STALE detection, no error', { skip: SKIP }, () => {
  const vault = makeVault();
  const note = join(vault, '1-fleeting', 'anything-at-all.md');
  writeFileSync(note, 'old note');
  utimesSync(note, OLD, OLD);
  const out = run(vault);
  assert.doesNotMatch(out, /STALE/);
});

test('slug matching is anchored to name prefix, not substring', { skip: SKIP }, () => {
  const vault = makeVault();
  writeFileSync(join(vault, '4-projects', 'ai.md'), '# ai');
  const inner = join(vault, '1-fleeting', 'maintain-codebase.md');
  writeFileSync(inner, 'old note with slug as inner substring');
  utimesSync(inner, OLD, OLD);
  const prefixed = join(vault, '1-fleeting', 'ai-research-idea.md');
  writeFileSync(prefixed, 'old note with slug as prefix');
  utimesSync(prefixed, OLD, OLD);
  const out = run(vault);
  assert.doesNotMatch(out, /^STALE\tmaintain-codebase\t/m);
  assert.match(out, /^STALE\tai-research-idea\t/m);
});

test(
  '2+ permanent inbound links reports PROMOTED (regression guard for grep -F change)',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    writeFileSync(join(vault, '1-fleeting', 'some-idea.md'), 'body');
    writeFileSync(join(vault, '3-permanent', 'a.md'), 'see [[some-idea]]');
    writeFileSync(join(vault, '3-permanent', 'b.md'), 'also [[some-idea]]');
    assert.match(run(vault), /^PROMOTED\tsome-idea\t2 permanent refs/m);
  },
);

const STALE_MARKER = new Date(Date.now() - 21 * 86400 * 1000); // > NEEDS_DEEPEN_DAYS, < STALE_DAYS

test('old note with a blocking verification marker reports NEEDS-DEEPEN', { skip: SKIP }, () => {
  const vault = makeVault();
  const note = join(vault, '1-fleeting', 'marker-note.md');
  writeFileSync(note, 'claim text [unverified] here');
  utimesSync(note, STALE_MARKER, STALE_MARKER);
  assert.match(run(vault), /^NEEDS-DEEPEN\tmarker-note\tverification markers, 21 days old/m);
});

test('old note with source: unverified frontmatter reports NEEDS-DEEPEN', { skip: SKIP }, () => {
  const vault = makeVault();
  const note = join(vault, '1-fleeting', 'honest-gap.md');
  writeFileSync(note, '---\nsource: unverified\n---\n\nbody');
  utimesSync(note, STALE_MARKER, STALE_MARKER);
  assert.match(run(vault), /^NEEDS-DEEPEN\thonest-gap\tsource: unverified, 21 days old/m);
});

test(
  'fresh marker-bearing note is NOT reported (repair window not reached)',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    writeFileSync(join(vault, '1-fleeting', 'fresh-marker.md'), 'fresh [citation needed] body');
    assert.doesNotMatch(run(vault), /NEEDS-DEEPEN/);
  },
);

test(
  'marker inside a fenced code block does not trigger NEEDS-DEEPEN (matches gate semantics)',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const note = join(vault, '1-fleeting', 'fenced.md');
    writeFileSync(note, 'body\n\n```\n[unverified]\n```\n');
    utimesSync(note, STALE_MARKER, STALE_MARKER);
    assert.doesNotMatch(run(vault), /NEEDS-DEEPEN/);
  },
);

test('marker matching is case-insensitive (matches gate normalization)', { skip: SKIP }, () => {
  const vault = makeVault();
  const note = join(vault, '1-fleeting', 'cased.md');
  writeFileSync(note, 'body [Not In Source] here');
  utimesSync(note, STALE_MARKER, STALE_MARKER);
  assert.match(run(vault), /^NEEDS-DEEPEN\tcased\t/m);
});

test(
  'PROMOTED takes precedence over NEEDS-DEEPEN (absorption beats repair)',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const note = join(vault, '1-fleeting', 'absorbed.md');
    writeFileSync(note, 'absorbed [unresolved] body');
    utimesSync(note, STALE_MARKER, STALE_MARKER);
    writeFileSync(join(vault, '3-permanent', 'a.md'), 'see [[absorbed]]');
    writeFileSync(join(vault, '3-permanent', 'b.md'), 'also [[absorbed]]');
    const out = run(vault);
    assert.match(out, /^PROMOTED\tabsorbed\t/m);
    assert.doesNotMatch(out, /^NEEDS-DEEPEN\tabsorbed\t/m);
  },
);

test(
  'marker note with deepen_attempts below the cap still reports NEEDS-DEEPEN',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const note = join(vault, '1-fleeting', 'one-attempt.md');
    writeFileSync(note, '---\ndeepen_attempts: 1\n---\n\nclaim [unverified] body');
    utimesSync(note, STALE_MARKER, STALE_MARKER);
    const out = run(vault);
    assert.match(out, /^NEEDS-DEEPEN\tone-attempt\t/m);
    assert.doesNotMatch(out, /^STALE\tone-attempt\t/m);
  },
);

test(
  'marker note with deepen_attempts at the cap routes to STALE (archival exit, no loop)',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const note = join(vault, '1-fleeting', 'exhausted.md');
    writeFileSync(note, '---\ndeepen_attempts: 2\n---\n\nclaim [unverified] body');
    utimesSync(note, STALE_MARKER, STALE_MARKER);
    const out = run(vault);
    assert.match(out, /^STALE\texhausted\tverification markers, 2 failed deepen attempts/m);
    assert.doesNotMatch(out, /^NEEDS-DEEPEN\texhausted\t/m);
  },
);

test('source: unverified note past the attempt cap routes to STALE', { skip: SKIP }, () => {
  const vault = makeVault();
  const note = join(vault, '1-fleeting', 'unverified-exhausted.md');
  writeFileSync(note, '---\nsource: unverified\ndeepen_attempts: 3\n---\n\nbody');
  utimesSync(note, STALE_MARKER, STALE_MARKER);
  const out = run(vault);
  assert.match(out, /^STALE\tunverified-exhausted\tsource: unverified, 3 failed deepen attempts/m);
  assert.doesNotMatch(out, /^NEEDS-DEEPEN\tunverified-exhausted\t/m);
});

test(
  'note matching both STALE (project slug) and NEEDS-DEEPEN surfaces as STALE',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    writeFileSync(join(vault, '4-projects', 'foo-tracker.md'), '# foo');
    const note = join(vault, '1-fleeting', 'foo-tracker-marker-note.md');
    writeFileSync(note, 'old unlinked note [unverified]');
    utimesSync(note, OLD, OLD);
    const out = run(vault);
    assert.match(out, /^STALE\tfoo-tracker-marker-note\t0 refs/m);
    assert.doesNotMatch(out, /^NEEDS-DEEPEN\tfoo-tracker-marker-note\t/m);
  },
);

test('sweep marker set matches promotion-gate.mjs MARKERS (drift guard)', { skip: SKIP }, () => {
  const gateSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts', 'promotion-gate.mjs'),
    'utf8',
  );
  const block = gateSrc.match(/const MARKERS = \[([\s\S]*?)\];/);
  assert.ok(block, 'promotion-gate.mjs lost its MARKERS array');
  const gateMarkers = [...block[1].matchAll(/'(\[[^']+\])'/g)].map((m) => m[1]);
  assert.ok(gateMarkers.length >= 4, `parsed only ${gateMarkers.length} gate markers`);

  const sweepSrc = readFileSync(SCRIPT, 'utf8');
  const fn = sweepSrc.match(/has_blocking_marker\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, 'fleeting-sweep.sh lost its has_blocking_marker function');
  const sweepMarkers = [...fn[1].matchAll(/-e '(\[[^']+\])'/g)].map((m) => m[1]);

  assert.deepEqual(
    sweepMarkers.sort(),
    gateMarkers.slice().sort(),
    'fleeting-sweep.sh marker patterns must match the blocking set in promotion-gate.mjs',
  );
});
