import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BULK_ADD,
  buildAddDateMap,
  parseAddDates,
  repair,
} from '../plugin/scripts/normalise-frontmatter.mjs';
import { fixtureGitEnv } from './helpers/git-fixture.mjs';
import { skipOnWindows } from './helpers/platform.mjs';
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

test('a date in a one-item list or with a stray quote is still read as a date', () => {
  for (const value of ['[2026-01-02]', '"2026-01-02']) {
    const raw = note(`source: synthesis\ntags: [a]\ndate: ${value}`);
    const { changes } = repair(raw, '3-permanent/a.md', '2026-05-05');
    assert.deepEqual(changes, ['reordered to tags/date/source'], value);
  }
});

test('a date written as a block list is kept, as the gate reads it', () => {
  const raw = note('source: synthesis\ntags: [a]\ndate:\n  - 2026-01-02');
  const { changes, next } = repair(raw, '3-permanent/a.md', '2026-05-05');
  assert.deepEqual(changes, ['reordered to tags/date/source']);
  assert.match(next, /^date:\n {2}- 2026-01-02$/m);
});

test('a malformed date is replaced, and the change says what it replaced', () => {
  const raw = note('tags: [a]\ndate: [2026-01-02\nsource: synthesis');
  const { changes, next } = repair(raw, '3-permanent/a.md', '2026-05-05');
  assert.deepEqual(changes, ['date: 2026-05-05 (first commit, replacing [2026-01-02)']);
  assert.match(next, /^date: 2026-05-05$/m);
});

test('with two date lines, both go and the change line names both', () => {
  const raw = note('tags: [a]\ndate: 2026-01-02\nsource: synthesis\ndate: bad');
  const { changes, next } = repair(raw, '3-permanent/a.md', '2026-05-05');
  assert.deepEqual(changes, ['date: 2026-05-05 (first commit, replacing 2026-01-02, bad)']);
  assert.equal(next.match(/^date:/gm).length, 1);
  assert.match(next, /^date: 2026-05-05$/m);
});

test('a block-list date that is replaced is named too', () => {
  const raw = note('tags: [a]\ndate:\n  - 2026-01-02\nsource: synthesis\ndate: bad');
  const { changes } = repair(raw, '3-permanent/a.md', '2026-05-05');
  assert.deepEqual(changes, ['date: 2026-05-05 (first commit, replacing 2026-01-02, bad)']);
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
  assert.match(unfixable.join(), /^no date, and it was first committed with 99\+ other notes/);
});

test("a bulk note's malformed date line survives a repair made for something else", () => {
  const { changes, unfixable, next } = repair(
    note('tags: [a]\ncreated: 2023/05/01'),
    '3-permanent/a.md',
    null,
  );
  assert.ok(changes.includes('created -> date: 2023/05/01'), changes.join());
  assert.match(next, /^date: 2023\/05\/01$/m, 'the only record of a date must not be dropped');
  assert.match(unfixable.join(), /^date 2023\/05\/01 is not YYYY-MM-DD/);
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

// git log -z --name-status: each commit is \x01<date>\0, then \n before the first status.
const log = (...commits) =>
  commits.map(([date, ...entries]) => `\x01${date}\0\n${entries.join('\0')}\0`).join('');

test('edits, deletions and type changes are read past, not taken as notes', () => {
  const dates = parseAddDates(
    log(
      ['2020-01-01', 'A', '0-inbox/a.md'],
      [
        '2020-02-02',
        'M',
        '0-inbox/a.md',
        'D',
        '0-inbox/gone.md',
        'T',
        '0-inbox/l.md',
        'A',
        '0-inbox/b.md',
      ],
    ),
  );
  assert.deepEqual(
    [...dates],
    [
      ['0-inbox/a.md', '2020-01-01'],
      ['0-inbox/b.md', '2020-02-02'],
    ],
  );
});

test('output it does not recognise is refused, not guessed past', () => {
  const signed = `No signature\n${log(['2020-01-01', 'A', '0-inbox/a.md'])}`;
  assert.throws(() => parseAddDates(signed), /unexpected git log output/);
});

test('a note made at a path another note was promoted away from gets its own date', () => {
  const dates = parseAddDates(
    log(
      ['2020-01-01', 'A', '0-inbox/x.md'],
      ['2021-01-01', 'R100', '0-inbox/x.md', '3-permanent/x.md'],
      ['2026-01-01', 'A', '0-inbox/x.md'],
    ),
  );
  assert.equal(dates.get('3-permanent/x.md'), '2020-01-01');
  assert.equal(dates.get('0-inbox/x.md'), '2026-01-01');
});

test('a non-ASCII name is looked up by its real path, and counts toward a bulk commit', () => {
  const { dir, commit } = gitRepo();
  commit(['0-inbox/café.md'], '2026-01-02');
  commit([...many(BULK_ADD - 1, '3-permanent/imported'), '3-permanent/naïve.md'], '2026-09-15');

  const dates = buildAddDateMap(dir);
  assert.equal(dates.get('0-inbox/café.md'), '2026-01-02');
  assert.equal(dates.get('3-permanent/imported-0.md'), null);
});

function runScript(vault, path = process.env.PATH) {
  const home = tempDir('ll-normalise-home-');
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: path,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_DATA: tempDir('ll-normalise-pd-'),
      VAULT_PATH: vault,
      ...strykerEnv(),
    },
  });
}

function dryRun(vault) {
  const r = runScript(vault);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
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

test('a note in a subfolder of a contract folder is scanned, as the gate covers it', () => {
  const { dir: vault, commit } = gitRepo();
  commit(['3-permanent/topic/deep.md'], '2026-01-02');
  const out = dryRun(vault);
  assert.match(out, /^3-permanent\/topic\/deep\.md$/m);
  assert.match(out, /1 scanned, 1 would be repaired/);
});

test(
  'a symlink below a contract folder is not followed, so it cannot loop or leave the vault',
  { skip: skipOnWindows('directory symlinks need elevation on win32') },
  () => {
    const vault = tempDir('ll-normalise-links-');
    const outside = tempDir('ll-normalise-outside-');
    mkdirSync(join(vault, '3-permanent/topic'), { recursive: true });
    writeFileSync(join(vault, '3-permanent/topic/in.md'), note('tags: [a]\nsource: synthesis'));
    writeFileSync(join(outside, 'secret.md'), note('tags: [a]\nsource: synthesis'));
    symlinkSync('.', join(vault, '3-permanent/topic/self'));
    symlinkSync(outside, join(vault, '3-permanent/ext'));

    const out = dryRun(vault);
    assert.match(out, /1 scanned, 1 would be repaired/);
    assert.doesNotMatch(out, /self|ext|secret/);
  },
);

test(
  'a contract folder that is a symlink is still scanned',
  { skip: skipOnWindows('directory symlinks need elevation on win32') },
  () => {
    const vault = tempDir('ll-normalise-sym-');
    mkdirSync(join(vault, 'real-permanent'));
    writeFileSync(join(vault, 'real-permanent/own.md'), note('tags: [a]\nsource: synthesis'));
    symlinkSync(join(vault, 'real-permanent'), join(vault, '3-permanent'));

    assert.match(dryRun(vault), /1 scanned, 1 would be repaired/);
  },
);

test(
  'a note that is a symlink to a file is still scanned',
  { skip: skipOnWindows('symlinks need elevation on win32') },
  () => {
    const vault = tempDir('ll-normalise-filelink-');
    mkdirSync(join(vault, '3-permanent'));
    mkdirSync(join(vault, 'shared'));
    writeFileSync(join(vault, 'shared/real.md'), note('tags: [a]\nsource: synthesis'));
    symlinkSync(join(vault, 'shared/real.md'), join(vault, '3-permanent/linked.md'));

    assert.match(dryRun(vault), /^3-permanent\/linked\.md$/m);
  },
);

test(
  'a note that links to a file outside the vault is not read, so --apply cannot write through it',
  { skip: skipOnWindows('symlinks need elevation on win32') },
  () => {
    const vault = tempDir('ll-normalise-outlink-');
    const outside = tempDir('ll-normalise-outside-');
    const original = note('tags: [a]\ncreated: 2020-01-01');
    writeFileSync(join(outside, 'secret.md'), original);
    mkdirSync(join(vault, '3-permanent/sub'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(vault, '3-permanent/sub/linked.md'));
    const home = tempDir('ll-normalise-home-');

    const r = spawnSync(process.execPath, [SCRIPT, '--apply'], {
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
    assert.match(r.stdout, /0 scanned/);
    assert.equal(readFileSync(join(outside, 'secret.md'), 'utf8'), original);
  },
);

test('a vault that is not there is one line on stderr, not a stack trace', () => {
  const r = runScript(join(tempDir('ll-normalise-gone-'), 'missing'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^normalise-frontmatter: .*; nothing was scanned$/m);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
});

test(
  'git output the walk does not recognise is one line on stderr, and nothing is scanned',
  { skip: skipOnWindows('shebang stub: #!/bin/sh git is not executable on win32') },
  () => {
    const { dir: vault, commit } = gitRepo();
    commit(['3-permanent/own.md'], '2026-01-02');
    const bin = tempDir('ll-normalise-fakegit-');
    writeFileSync(join(bin, 'git'), "#!/bin/sh\nprintf 'garbage\\0'\n");
    chmodSync(join(bin, 'git'), 0o755);

    const r = runScript(vault, `${bin}:${process.env.PATH}`);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      /^normalise-frontmatter: unexpected git log output: "garbage"; nothing was scanned$/m,
    );
  },
);
