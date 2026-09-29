import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BULK_ADD, buildAddDateMap, repair } from '../plugin/scripts/normalise-frontmatter.mjs';
import { fixtureGitEnv } from './helpers/git-fixture.mjs';
import { strykerEnv } from './helpers/stryker-env.mjs';

const SCRIPT = new URL('../plugin/scripts/normalise-frontmatter.mjs', import.meta.url).pathname;

const note = (fm, body = 'A thought of my own.\n') => `---\n${fm}\n---\n${body}`;

test('a missing date is taken from the first commit', () => {
  const { next } = repair(note('tags: [a]\nsource: synthesis'), '3-permanent/a.md', '2026-03-04');
  assert.match(next, /^date: 2026-03-04$/m);
});

test('a note from a bulk import is left for a human, not given the import date', () => {
  const { changes, unfixable, next } = repair(
    note('tags: [a]\nsource: synthesis'),
    '3-permanent/a.md',
    null,
  );
  assert.deepEqual(changes, []);
  assert.equal(next, undefined);
  assert.match(unfixable.join(), /bulk import/);
});

test('keys are put in template order, and a repaired note needs no second pass', () => {
  const { changes, next } = repair(
    note('source: synthesis\ntags: [a]\ndate: 2026-01-02'),
    '3-permanent/a.md',
    '2026-05-05',
  );
  assert.deepEqual(changes, ['reordered to tags/date/source']);
  assert.match(next, /^---\ntags: \[a\]\ndate: 2026-01-02\nsource: synthesis\n---/);
  assert.deepEqual(repair(next, '3-permanent/a.md', '2026-05-05').changes, []);
});

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'll-normalise-'));
  const env = fixtureGitEnv();
  const git = (args, date) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: 'ignore',
      env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env,
    });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  const commit = (paths, date) => {
    for (const p of paths) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), note('tags: [a]\nsource: synthesis'));
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add'], `${date}T12:00:00Z`);
  };
  return { dir, commit };
}

test('notes a bulk commit added map to null, and the rest to their commit date', () => {
  const { dir, commit } = gitRepo();
  commit(['3-permanent/own.md', '0-inbox/fresh.md'], '2026-01-02');
  const imported = Array.from({ length: BULK_ADD }, (_, i) => `3-permanent/imported-${i}.md`);
  commit(imported, '2026-09-15');

  const dates = buildAddDateMap(dir);
  assert.equal(dates.get('3-permanent/own.md'), '2026-01-02');
  assert.equal(dates.get('0-inbox/fresh.md'), '2026-01-02');
  assert.equal(dates.get('3-permanent/imported-0.md'), null);
  assert.equal(dates.has('3-permanent/imported-0.md'), true);
});

test('a commit one note short of the bulk size still dates its notes', () => {
  const { dir, commit } = gitRepo();
  const batch = Array.from({ length: BULK_ADD - 1 }, (_, i) => `3-permanent/n-${i}.md`);
  commit(batch, '2026-04-01');
  assert.equal(buildAddDateMap(dir).get('3-permanent/n-0.md'), '2026-04-01');
});

test('a dry run reports the contract folders only, and writes nothing', () => {
  const { dir: vault, commit } = gitRepo();
  commit(['3-permanent/own.md', '4-projects/p.md'], '2026-01-02');
  const home = mkdtempSync(join(tmpdir(), 'll-normalise-home-'));
  const pluginData = mkdtempSync(join(tmpdir(), 'll-normalise-pd-'));
  const before = readFileSync(join(vault, '3-permanent/own.md'), 'utf8');

  const out = execFileSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_DATA: pluginData,
      VAULT_PATH: vault,
      ...strykerEnv(),
    },
  });

  assert.match(out, /^3-permanent\/own\.md$/m);
  assert.match(out, /date: 2026-01-02 \(first commit\)/);
  assert.doesNotMatch(out, /4-projects/);
  assert.match(out, /1 scanned, 1 would be repaired, 0 need a human/);
  assert.equal(readFileSync(join(vault, '3-permanent/own.md'), 'utf8'), before);
});
