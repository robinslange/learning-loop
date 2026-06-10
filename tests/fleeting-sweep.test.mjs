import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fleeting-sweep.sh');

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
test('no hardcoded slug list: slugs must derive from 4-projects/', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /PROJECT_SLUGS="[^"]*\|/, 'pipe-delimited literal slug list found');
  assert.match(src, /4-projects/, 'slug derivation from project index notes missing');
});

test('stale note matching a 4-projects slug is reported STALE', () => {
  const vault = makeVault();
  writeFileSync(join(vault, '4-projects', 'foo-tracker.md'), '# foo');
  const note = join(vault, '1-fleeting', 'foo-tracker-launch-idea.md');
  writeFileSync(note, 'old unlinked note');
  utimesSync(note, OLD, OLD);
  assert.match(run(vault), /^STALE\tfoo-tracker-launch-idea\t/m);
});

test('empty 4-projects: no STALE detection, no error', () => {
  const vault = makeVault();
  const note = join(vault, '1-fleeting', 'anything-at-all.md');
  writeFileSync(note, 'old note');
  utimesSync(note, OLD, OLD);
  const out = run(vault);
  assert.doesNotMatch(out, /STALE/);
});

test('slug matching is anchored to name prefix, not substring', () => {
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

test('2+ permanent inbound links reports PROMOTED (regression guard for grep -F change)', () => {
  const vault = makeVault();
  writeFileSync(join(vault, '1-fleeting', 'some-idea.md'), 'body');
  writeFileSync(join(vault, '3-permanent', 'a.md'), 'see [[some-idea]]');
  writeFileSync(join(vault, '3-permanent', 'b.md'), 'also [[some-idea]]');
  assert.match(run(vault), /^PROMOTED\tsome-idea\t2 permanent refs/m);
});
