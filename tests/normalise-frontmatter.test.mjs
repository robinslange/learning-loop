import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BULK_ADD, buildAddDateMap, repair } from '../plugin/scripts/normalise-frontmatter.mjs';
import { fixtureGitEnv } from './helpers/git-fixture.mjs';
import { strykerEnv } from './helpers/stryker-env.mjs';

const SCRIPT = fileURLToPath(
  new URL('../plugin/scripts/normalise-frontmatter.mjs', import.meta.url),
);

const temps = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const note = (fm, body = 'A thought of my own.\n') => `---\n${fm}\n---\n${body}`;

test("an aliased date keeps the note's own value", () => {
  const { changes, next } = repair(
    note('tags: [a]\ncreated: 2026-01-02\nsource: synthesis'),
    '3-permanent/a.md',
    '2026-05-05',
  );
  assert.deepEqual(changes, ['created -> date: 2026-01-02']);
  assert.match(next, /^date: 2026-01-02$/m);
  assert.doesNotMatch(next, /^created:/m);
});

test('a quoted date is kept when the note is repaired for something else', () => {
  const raw = note('source: synthesis\ntags: [a]\ndate: "2026-01-02"');
  const { changes, next } = repair(raw, '3-permanent/a.md', '2026-05-05');
  assert.deepEqual(changes, ['reordered to tags/date/source']);
  assert.match(next, /^date: "2026-01-02"$/m);
});

test('a missing date is taken from the first commit', () => {
  const { next } = repair(note('tags: [a]\nsource: synthesis'), '3-permanent/a.md', '2026-03-04');
  assert.match(next, /^date: 2026-03-04$/m);
});

test('a note from a bulk commit is left for a human, not given that commit date', () => {
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
  const dir = tempDir('ll-normalise-');
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
  const move = (from, to, date) => {
    mkdirSync(join(dir, to, '..'), { recursive: true });
    git(['mv', from, to]);
    git(['commit', '-q', '-m', 'move'], `${date}T12:00:00Z`);
  };
  return { dir, commit, move };
}

const many = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}-${i}.md`);

test('notes a bulk commit added map to null, and the rest to their commit date', () => {
  const { dir, commit } = gitRepo();
  commit(['3-permanent/own.md', '0-inbox/fresh.md'], '2026-01-02');
  commit(many(BULK_ADD, '3-permanent/imported'), '2026-09-15');

  const dates = buildAddDateMap(dir);
  assert.equal(dates.get('3-permanent/own.md'), '2026-01-02');
  assert.equal(dates.get('0-inbox/fresh.md'), '2026-01-02');
  assert.equal(dates.get('3-permanent/imported-0.md'), null);
  assert.equal(dates.has('3-permanent/imported-0.md'), true);
});

test('a commit one note short of the bulk size still dates its notes', () => {
  const { dir, commit } = gitRepo();
  commit(many(BULK_ADD - 1, '3-permanent/n'), '2026-04-01');
  assert.equal(buildAddDateMap(dir).get('3-permanent/n-0.md'), '2026-04-01');
});

test('a promoted note keeps the date it was first added, and a promoted import stays undated', () => {
  const { dir, commit, move } = gitRepo();
  commit(['0-inbox/idea.md'], '2026-01-02');
  commit(many(BULK_ADD, '0-inbox/imported'), '2026-09-15');
  move('0-inbox/idea.md', '3-permanent/idea.md', '2026-03-03');
  move('0-inbox/imported-0.md', '3-permanent/imported-0.md', '2026-10-01');

  const dates = buildAddDateMap(dir);
  assert.equal(dates.get('3-permanent/idea.md'), '2026-01-02');
  assert.equal(dates.has('3-permanent/imported-0.md'), true);
  assert.equal(dates.get('3-permanent/imported-0.md'), null);
});

test('a non-ASCII name is looked up by its real path, and counts toward a bulk commit', () => {
  const { dir, commit } = gitRepo();
  commit(['0-inbox/café.md'], '2026-01-02');
  commit([...many(BULK_ADD - 1, '3-permanent/imported'), '3-permanent/naïve.md'], '2026-09-15');

  const dates = buildAddDateMap(dir);
  assert.equal(dates.get('0-inbox/café.md'), '2026-01-02');
  assert.equal(dates.get('3-permanent/imported-0.md'), null);
});

function dryRun(vault) {
  const home = tempDir('ll-normalise-home-');
  return execFileSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_DATA: tempDir('ll-normalise-pd-'),
      VAULT_PATH: vault,
      ...strykerEnv(),
    },
  });
}

test('a dry run reports the contract folders only, and writes nothing', () => {
  const { dir: vault, commit } = gitRepo();
  commit(['3-permanent/own.md', '4-projects/p.md'], '2026-01-02');
  const before = readFileSync(join(vault, '3-permanent/own.md'), 'utf8');

  const out = dryRun(vault);

  assert.match(out, /^3-permanent\/own\.md$/m);
  assert.match(out, /date: 2026-01-02 \(first commit\)/);
  assert.doesNotMatch(out, /4-projects/);
  assert.match(out, /1 scanned, 1 would be repaired, 0 need a human/);
  assert.equal(readFileSync(join(vault, '3-permanent/own.md'), 'utf8'), before);
});
