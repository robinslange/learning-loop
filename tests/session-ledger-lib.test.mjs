import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveProject,
  gitFacts,
  execGit,
  gitEnv,
  budgetedGit,
} from '../plugin/scripts/lib/session-ledger.mjs';
import { initRepo, git } from './helpers/git-fixture.mjs';

const gitOpts = { stdio: 'ignore', env: gitEnv() };
function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'll-ledger-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('resolveProject derives the project from the repo basename', () => {
  withTmp((root) => {
    const repo = join(root, 'my-repo');
    mkdirSync(repo);
    initRepo(repo);
    const r = resolveProject(repo, {}, execGit, 2000);
    assert.equal(r.project, 'my-repo');
    assert.equal(r.source, 'derived');
    assert.equal(r.worktreeRoot, git(repo, 'rev-parse', '--show-toplevel'));
  });
});

test('resolveProject honours the projects map', () => {
  withTmp((root) => {
    const repo = join(root, 'client-sample-app');
    mkdirSync(repo);
    initRepo(repo);
    const r = resolveProject(
      repo,
      { projects: { 'client-sample-app': 'sample-app' } },
      execGit,
      2000,
    );
    assert.equal(r.project, 'sample-app');
    assert.equal(r.source, 'mapped');
  });
});

test('resolveProject collapses a worktree onto its main repo', () => {
  withTmp((root) => {
    const repo = join(root, 'main-repo');
    mkdirSync(repo);
    initRepo(repo);
    const wt = join(root, 'main-repo-wt');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feat', wt], gitOpts);
    const r = resolveProject(wt, {}, execGit, 2000);
    assert.equal(r.project, 'main-repo');
    assert.equal(r.source, 'derived');
    assert.equal(r.worktreeRoot, git(wt, 'rev-parse', '--show-toplevel'));
  });
});

test('resolveProject falls back to the cwd basename outside a repo', () => {
  withTmp((root) => {
    const dir = join(root, 'plain-dir');
    mkdirSync(dir);
    const r = resolveProject(dir, {}, execGit, 2000);
    assert.deepEqual(r, {
      project: 'plain-dir',
      source: 'cwd',
      repoRoot: null,
      worktreeRoot: null,
    });
  });
});

test('gitFacts reports branch, commits since a timestamp, and dirty state', () => {
  withTmp((root) => {
    const repo = join(root, 'r');
    mkdirSync(repo);
    initRepo(repo);
    const since = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    execFileSync('git', ['-C', repo, 'add', 'b.txt'], gitOpts);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'second commit'], gitOpts);
    writeFileSync(join(repo, 'c.txt'), 'dirty\n');
    const f = gitFacts(repo, since, execGit, 2000);
    assert.equal(f.branch, 'main');
    assert.equal(f.commits.length, 2);
    assert.equal(f.commits[0].subject, 'second commit');
    assert.match(f.commits[0].hash, /^[0-9a-f]{7,}$/);
    assert.equal(f.dirtyCount, 1);
    assert.equal(f.state, 'dirty');
    assert.ok(f.gitMs >= 0);
  });
});

test('gitFacts ignores an inherited GIT_INDEX_FILE / GIT_DIR from a parent git-hook process', () => {
  withTmp((root) => {
    const repo = join(root, 'r');
    mkdirSync(repo);
    initRepo(repo);
    const savedIndex = process.env.GIT_INDEX_FILE;
    const savedDir = process.env.GIT_DIR;
    process.env.GIT_INDEX_FILE = '/nonsense/index';
    process.env.GIT_DIR = '/nonsense/dir';
    try {
      const since = new Date(Date.now() - 60_000).toISOString();
      const f = gitFacts(repo, since, execGit, 2000);
      assert.equal(f.branch, 'main');
      assert.equal(f.state, 'clean');
    } finally {
      if (savedIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = savedIndex;
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
    }
  });
});

test('gitFacts reports not_repo when there is no worktree root', () => {
  const f = gitFacts(null, '2026-01-01T00:00:00Z', execGit, 2000);
  assert.deepEqual(f, {
    branch: null,
    commits: [],
    dirtyCount: 0,
    state: 'not_repo',
    gitMs: 0,
    head: null,
    commitsSource: 'since',
  });
});

test('gitFacts reports timeout when a git call times out and keeps what it gathered', () => {
  const fake = (args) => {
    if (args[0] === 'rev-parse') return { ok: true, out: 'main\n' };
    return { ok: false, timeout: true };
  };
  const f = gitFacts('/anywhere', '2026-01-01T00:00:00Z', fake, 300);
  assert.equal(f.branch, 'main');
  assert.equal(f.state, 'timeout');
  assert.deepEqual(f.commits, []);
});

function commit(repo, file, message, opts = {}) {
  writeFileSync(join(repo, file), `${message}\n`);
  execFileSync('git', ['-C', repo, 'add', file], gitOpts);
  const env = opts.authorDate
    ? { ...gitOpts.env, GIT_AUTHOR_DATE: opts.authorDate, GIT_COMMITTER_DATE: opts.authorDate }
    : gitOpts.env;
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', message], { ...gitOpts, env });
}

test('gitFacts credits by HEAD range, excluding a commit reachable before the session started even with a later author date', () => {
  withTmp((root) => {
    const repo = join(root, 'r');
    mkdirSync(repo);
    initRepo(repo);

    // D is authored far in the future but made BEFORE startedHead is
    // recorded: --since would credit it to the session; the range must not.
    commit(repo, 'd.txt', 'D future-dated commit', {
      authorDate: '2099-01-01T00:00:00',
    });
    const startedHead = git(repo, 'rev-parse', 'HEAD');

    commit(repo, 'b.txt', 'B session commit');

    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'side'], gitOpts);
    commit(repo, 'c.txt', 'C side commit', { authorDate: '2020-01-01T00:00:00' });
    execFileSync('git', ['-C', repo, 'checkout', '-q', 'main'], gitOpts);
    execFileSync(
      'git',
      ['-C', repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'],
      gitOpts,
    );

    const since = new Date(Date.now() - 60_000).toISOString();
    const f = gitFacts(repo, since, execGit, 2000, { startedHead });
    assert.equal(f.commitsSource, 'range');
    const subjects = f.commits.map((c) => c.subject);
    assert.ok(subjects.includes('B session commit'));
    assert.ok(subjects.includes('C side commit'));
    assert.ok(subjects.includes('merge side'));
    assert.ok(
      !subjects.includes('D future-dated commit'),
      'range must exclude a pre-session commit',
    );
  });
});

test('gitFacts falls back to --since when startedHead is not an ancestor of HEAD', () => {
  withTmp((root) => {
    const repo = join(root, 'r');
    mkdirSync(repo);
    initRepo(repo);
    commit(repo, 'b.txt', 'B session commit');
    const notAnAncestor = git(repo, 'rev-parse', 'HEAD');

    // Rewind so notAnAncestor is no longer reachable from the new HEAD.
    execFileSync('git', ['-C', repo, 'reset', '-q', '--hard', 'HEAD~1'], gitOpts);
    commit(repo, 'e.txt', 'E after rewind');

    const since = new Date(Date.now() - 60_000).toISOString();
    const f = gitFacts(repo, since, execGit, 2000, { startedHead: notAnAncestor });
    assert.equal(f.commitsSource, 'since');
    assert.ok(f.commits.map((c) => c.subject).includes('E after rewind'));
  });
});

test('budgetedGit caps total wall time across calls instead of a per-call timeout', () => {
  // Fake clock advanced by the fake spawn itself: each call "takes" 200ms,
  // deterministically, instead of a real busy-wait racing wall-clock slack
  // on a loaded CI runner.
  let clock = 0;
  const now = () => clock;
  let calls = 0;
  const slow = () => {
    calls++;
    clock += 200;
    return { ok: true, out: 'x' };
  };
  const budget = { remaining: 500 };
  const wrapped = budgetedGit(slow, budget, now);
  wrapped(['a'], '/x', 1000);
  wrapped(['b'], '/x', 1000);
  const third = wrapped(['c'], '/x', 1000);
  const fourth = wrapped(['d'], '/x', 1000);
  // Three 200ms calls exhaust a 500ms budget (300 remaining after two, then
  // the third call itself is the one that crosses the floor); the fourth
  // never spawns.
  assert.equal(calls, 3, `expected exactly 3 real calls, got ${calls}`);
  assert.equal(third.ok, true);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.timeout, true);
});

import {
  collectFacts,
  summarise,
  SUMMARY_ENUMS,
  renderLedger,
  ledgerPath,
  shouldWrite,
  shouldEmitSummary,
  latestLedger,
  localDateStr,
} from '../plugin/scripts/lib/session-ledger.mjs';

const WALK = {
  prompts: [
    {
      ts: '2026-09-21T01:00:00.000Z',
      text: 'fix the flaky test in ledger.test.mjs please, it fails on CI only',
    },
    { ts: '2026-09-21T01:05:00.000Z', text: 'now run it' },
  ],
  toolUses: [
    { ts: 't', name: 'Edit', input: { file_path: '/wt/tests/ledger.test.mjs' }, direct: true },
    { ts: 't', name: 'Edit', input: { file_path: '/wt/tests/ledger.test.mjs' }, direct: true },
    { ts: 't', name: 'Write', input: { file_path: '/wt/src/new.mjs' }, direct: true },
    { ts: 't', name: 'Write', input: { file_path: '/vault/0-inbox/note.md' }, direct: true },
    {
      ts: 't',
      name: 'Write',
      input: { file_path: '/home/u/.claude/projects/-x/memory/m.md' },
      direct: true,
    },
    { ts: 't', name: 'Edit', input: { file_path: '/wt/hooked.mjs' }, direct: false },
    {
      ts: 't',
      name: 'Skill',
      input: { skill: 'learning-loop:quick-note', args: 'a thing https://github.com/o/r/pull/12' },
      direct: true,
    },
    {
      ts: 't',
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'find the flake' },
      direct: true,
    },
    { ts: 't', name: 'Bash', input: { command: 'npm test' }, direct: true },
  ],
  assistantTexts: [
    { ts: 't', text: 'Opened https://bitbucket.org/w/r/pull-requests/7 for review.' },
  ],
  firstTs: '2026-09-21T01:00:00.000Z',
  lastTs: '2026-09-21T01:20:00.000Z',
  skippedLines: 0,
};
const GIT = {
  branch: 'main',
  commits: [{ hash: 'abc1234', subject: 'fix flake' }],
  dirtyCount: 2,
  state: 'dirty',
  gitMs: 40,
};

test('collectFacts scopes files to the worktree, direct calls only, counting edits', () => {
  const f = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: 'Done.',
  });
  assert.deepEqual(f.files, [
    { path: 'tests/ledger.test.mjs', edits: 2 },
    { path: 'src/new.mjs', edits: 1 },
  ]);
  assert.deepEqual(f.skills, [
    { skill: 'learning-loop:quick-note', args: 'a thing https://github.com/o/r/pull/12' },
  ]);
  assert.deepEqual(f.agents, [{ type: 'Explore', description: 'find the flake' }]);
  assert.deepEqual(f.prs, [
    'https://bitbucket.org/w/r/pull-requests/7',
    'https://github.com/o/r/pull/12',
  ]);
  assert.equal(f.goal, WALK.prompts[0].text);
  assert.equal(f.stoppedAt, 'Done.');
});

test('collectFacts uses cwd as the file scope when there is no repo', () => {
  const f = collectFacts(WALK, {
    worktreeRoot: null,
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  assert.equal(f.files.length, 2);
  assert.equal(f.stoppedAt, null);
});

test('summarise produces numbers, booleans and closed enums only', () => {
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const s = summarise({
    walk: WALK,
    git: GIT,
    facts,
    isSessionEnd: true,
    reason: 'other',
    projectSource: 'derived',
    harness: 'claude-code',
    version: '2.1.0',
    latencyMs: 123,
    transcriptBytes: 4096,
  });
  assert.equal(s.action, 'session-summary');
  assert.equal(s.prompts, 2);
  assert.equal(s.tool_uses, 9);
  assert.equal(s.tool_uses_direct, 8);
  assert.equal(s.files_edited, 2);
  assert.equal(s.commits, 1);
  assert.equal(s.skills_invoked, 1);
  assert.equal(s.agents_spawned, 1);
  assert.equal(s.duration_ms, 20 * 60 * 1000);
  assert.equal(s.git_ms, 40);
  assert.equal(s.latency_ms, 123);
  assert.equal(s.transcript_bytes, 4096);
  assert.equal(s.final, true);
  for (const [k, v] of Object.entries(s)) {
    if (k === 'action' || k === 'version') continue;
    if (SUMMARY_ENUMS[k]) assert.ok(SUMMARY_ENUMS[k].has(v), `${k}=${v} not in enum`);
    else assert.ok(typeof v === 'number' || typeof v === 'boolean', `${k} is ${typeof v}`);
  }
});

test('summarise maps an open session to end_reason open and final false', () => {
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const s = summarise({
    walk: WALK,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    projectSource: 'cwd',
    harness: 'codex',
    version: 'x',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  assert.equal(s.end_reason, 'open');
  assert.equal(s.final, false);
});

test('summarise folds an unknown reason into other', () => {
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const s = summarise({
    walk: WALK,
    git: GIT,
    facts,
    isSessionEnd: true,
    reason: 'bypass_permissions_disabled',
    projectSource: 'cwd',
    harness: 'codex',
    version: 'x',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  assert.equal(s.end_reason, 'other');
});

test('renderLedger writes frontmatter and omits empty sections', () => {
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: 'Tests green, PR open.',
  });
  const summary = summarise({
    walk: WALK,
    git: GIT,
    facts,
    isSessionEnd: true,
    reason: 'other',
    projectSource: 'derived',
    harness: 'claude-code',
    version: '2.1.0',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  const md = renderLedger({
    project: 'my-repo',
    label: 'ledger flake',
    date: '2026-09-21',
    sessionId: '60e4c15a-487a-4e85-a18a-a989d8c00de7',
    repoRoot: '/repos/my-repo',
    git: GIT,
    facts,
    isSessionEnd: true,
    reason: 'other',
    summary,
    harness: 'claude-code',
  });
  assert.match(
    md,
    /^---\ntitle: "Session ledger: ledger flake \(2026-09-21\)"\ntags: \[ledger, "my-repo"\]\ndate: 2026-09-21\nsource: session\nvisibility: private\nsession_id: 60e4c15a-487a-4e85-a18a-a989d8c00de7\nrepo: "my-repo"\nbranch: "main"\nstatus: ended\nended_reason: other\n---\n/,
  );
  assert.match(md, /## Goal\nfix the flaky test/);
  assert.match(md, /## Where it stopped\nTests green, PR open\./);
  assert.match(md, /## Commits this session\n- abc1234 fix flake/);
  assert.match(
    md,
    /## Files changed\n- tests\/ledger\.test\.mjs \(2 edits\)\n- src\/new\.mjs \(1 edit\)/,
  );
  assert.match(md, /## Skills\n- \/learning-loop:quick-note a thing/);
  assert.match(md, /## Agents\n- Explore: find the flake/);
  assert.match(md, /## PRs\n- https:\/\/bitbucket/);
  assert.match(md, /## Open state\n2 uncommitted files on main/);
  assert.match(md, /\n2 prompts · 20m · claude-code\n$/);
});

test('renderLedger for a clean open session has no Open state, no ended_reason, status open', () => {
  const git = { ...GIT, dirtyCount: 0, state: 'clean' };
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const summary = summarise({
    walk: WALK,
    git,
    facts,
    isSessionEnd: false,
    reason: undefined,
    projectSource: 'derived',
    harness: 'claude-code',
    version: '2.1.0',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  const md = renderLedger({
    project: 'p',
    label: null,
    date: '2026-09-21',
    sessionId: 'abcdefgh-1',
    repoRoot: null,
    git,
    facts,
    isSessionEnd: false,
    reason: undefined,
    summary,
    harness: 'claude-code',
  });
  assert.match(md, /status: open\n---/);
  assert.doesNotMatch(md, /ended_reason/);
  assert.doesNotMatch(md, /## Open state/);
  assert.doesNotMatch(md, /## Where it stopped/);
  assert.match(md, /title: "Session ledger: session \(2026-09-21\)"/);
  assert.match(md, /repo: null\n/);
});

test('renderLedger truncates the goal and the stop message', () => {
  const long = 'x'.repeat(1000);
  const walk = { ...WALK, prompts: [{ ts: 't', text: long }] };
  const facts = collectFacts(walk, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: long,
  });
  const summary = summarise({
    walk,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    projectSource: 'derived',
    harness: 'claude-code',
    version: 'v',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  const md = renderLedger({
    project: 'p',
    label: 'l',
    date: '2026-09-21',
    sessionId: 'abcdefgh-1',
    repoRoot: null,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    summary,
    harness: 'claude-code',
  });
  const goal = md.match(/## Goal\n(.*)\n/)[1];
  const stop = md.match(/## Where it stopped\n(.*)\n/)[1];
  assert.equal(goal.length, 200);
  assert.equal(stop.length, 600);
  assert.ok(goal.endsWith('…'));
});

test('collectFacts scrubs credential-shaped text out of the goal before it reaches the Goal section', () => {
  const awsKey = 'AKIA' + 'A'.repeat(16);
  const ghToken = 'ghp_' + '1'.repeat(36);
  const walk = {
    ...WALK,
    prompts: [{ ts: 't', text: `rotate ${awsKey} and revoke ${ghToken} please` }],
  };
  const facts = collectFacts(walk, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const summary = summarise({
    walk,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    projectSource: 'derived',
    harness: 'claude-code',
    version: 'v',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  const md = renderLedger({
    project: 'p',
    label: 'l',
    date: '2026-09-21',
    sessionId: 'abcdefgh-1',
    repoRoot: null,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    summary,
    harness: 'claude-code',
  });
  const goal = md.match(/## Goal\n(.*)\n/)[1];
  assert.ok(!goal.includes(awsKey), 'AWS key literal must not reach the Goal section');
  assert.ok(!goal.includes(ghToken), 'GitHub PAT literal must not reach the Goal section');
  assert.match(goal, /\[REDACTED\]/);
});

test('ledgerPath is vault-relative, kebab, capped, and pinned by the sid prefix', () => {
  assert.equal(
    ledgerPath(
      'my-repo',
      '2026-09-21',
      'Plugin Hooks Reflection',
      '60e4c15a-487a-4e85-a18a-a989d8c00de7',
    ),
    '4-projects/my-repo/ledger/2026-09-21-plugin-hooks-reflection-60e4c15a.md',
  );
  assert.equal(
    ledgerPath('p', '2026-09-21', '', 'abcdefgh-x'),
    '4-projects/p/ledger/2026-09-21-session-abcdefgh.md',
  );
  const long = ledgerPath('p', '2026-09-21', 'w'.repeat(100), 'abcdefgh-x');
  assert.ok(long.length <= '4-projects/p/ledger/2026-09-21-'.length + 40 + '-abcdefgh.md'.length);
});

test('shouldWrite requires an edit, a commit, or enough prompts', () => {
  const base = { files_edited: 0, commits: 0, prompts: 0 };
  assert.equal(shouldWrite(base, 5), false);
  assert.equal(shouldWrite({ ...base, files_edited: 1 }, 5), true);
  assert.equal(shouldWrite({ ...base, commits: 1 }, 5), true);
  assert.equal(shouldWrite({ ...base, prompts: 4 }, 5), false);
  assert.equal(shouldWrite({ ...base, prompts: 5 }, 5), true);
});

test('latestLedger returns the newest ledger by mtime with its frontmatter status', () => {
  withTmp((root) => {
    const dir = join(root, '4-projects', 'p', 'ledger');
    mkdirSync(dir, { recursive: true });
    const a = join(dir, '2026-09-20-a-11111111.md');
    const b = join(dir, '2026-09-21-b-22222222.md');
    writeFileSync(a, '---\ndate: 2026-09-20\nstatus: ended\n---\n');
    writeFileSync(b, '---\ndate: 2026-09-21\nstatus: open\n---\n');
    utimesSync(a, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    assert.deepEqual(latestLedger(root, 'p'), {
      relPath: '4-projects/p/ledger/2026-09-21-b-22222222.md',
      date: '2026-09-21',
      status: 'open',
    });
    assert.equal(latestLedger(root, 'nope'), null);
  });
});

test('latestLedger stats only the five newest-named ledgers, picking the mtime-newest among them', () => {
  withTmp((root) => {
    const dir = join(root, '4-projects', 'p', 'ledger');
    mkdirSync(dir, { recursive: true });
    // Seven names, days 20 through 14 descending: only the top five (20..16)
    // are ever statted. Within that window the oldest NAME (16) gets the
    // newest mtime, proving the winner is chosen by mtime, not name order.
    // The two oldest names (15, 14) get the newest mtime of all seven; if the
    // walk were not capped, one of them would win instead.
    const days = [20, 19, 18, 17, 16, 15, 14];
    const names = days.map((d) => `2026-09-${d}-x-11111111.md`);
    days.forEach((d, i) => {
      writeFileSync(join(dir, names[i]), `---\ndate: 2026-09-${d}\nstatus: open\n---\n`);
    });
    const now = Date.now();
    names.forEach((name, i) => {
      utimesSync(join(dir, name), new Date(now - i * 1000), new Date(now - i * 1000));
    });
    // Give the two out-of-window names (15, 14) the newest mtime of all seven.
    utimesSync(join(dir, names[5]), new Date(now + 60_000), new Date(now + 60_000));
    utimesSync(join(dir, names[6]), new Date(now + 120_000), new Date(now + 120_000));
    // And make the oldest in-window name (16) the newest mtime among the five.
    utimesSync(join(dir, names[4]), new Date(now + 30_000), new Date(now + 30_000));
    assert.deepEqual(latestLedger(root, 'p'), {
      relPath: `4-projects/p/ledger/${names[4]}`,
      date: '2026-09-16',
      status: 'open',
    });
  });
});

test('shouldEmitSummary fires on SessionEnd, on first flush, and after the interval', () => {
  const now = 1_000_000;
  assert.equal(shouldEmitSummary(null, now, false, 600_000), true);
  assert.equal(shouldEmitSummary({ path: 'p', started_ts: 's' }, now, false, 600_000), true);
  assert.equal(
    shouldEmitSummary({ last_summary_ts: new Date(now - 1000).toISOString() }, now, false, 600_000),
    false,
  );
  assert.equal(
    shouldEmitSummary(
      { last_summary_ts: new Date(now - 600_000).toISOString() },
      now,
      false,
      600_000,
    ),
    true,
  );
  assert.equal(
    shouldEmitSummary({ last_summary_ts: new Date(now - 1000).toISOString() }, now, true, 600_000),
    true,
  );
});

test('localDateStr formats the local calendar date, not UTC', () => {
  const iso = '2026-09-20T23:30:00.000Z';
  const d = new Date(iso);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  const actual = localDateStr(iso);
  assert.equal(actual, expected);
  assert.match(actual, /^\d{4}-\d{2}-\d{2}$/);
});

test('renderLedger quotes tags, repo, and branch values, escaping quotes and backslashes', () => {
  const git = { ...GIT, branch: 'feature/"weird"\\branch' };
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const summary = summarise({
    walk: WALK,
    git,
    facts,
    isSessionEnd: false,
    reason: undefined,
    projectSource: 'derived',
    harness: 'claude-code',
    version: 'v',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  const md = renderLedger({
    project: 'client "sample" app',
    label: 'l',
    date: '2026-09-21',
    sessionId: 'abcdefgh-1',
    repoRoot: '/repos/weird\\repo',
    git,
    facts,
    isSessionEnd: false,
    reason: undefined,
    summary,
    harness: 'claude-code',
  });
  assert.match(md, /tags: \[ledger, "client \\"sample\\" app"\]/);
  // repo is basename(repoRoot), and on win32 the backslash in this fixture is
  // a separator, so basename yields `repo` there rather than `weird\repo`.
  // Derive the expectation from basename instead of pinning the POSIX reading:
  // what this asserts is the YAML quoting of whatever basename returns. The
  // backslash escape itself is covered by `branch` below, which is not
  // basename'd, and by the dedicated title test.
  const repoName = basename('/repos/weird\\repo').replace(/\\/g, '\\\\');
  assert.ok(md.includes(`repo: "${repoName}"`), `repo line missing in:\n${md}`);
  assert.match(md, /branch: "feature\/\\"weird\\"\\\\branch"/);
});

test('renderLedger escapes a backslash in the title', () => {
  const facts = collectFacts(WALK, {
    worktreeRoot: '/wt',
    cwd: '/wt',
    vaultRoot: '/vault',
    lastAssistantMessage: null,
  });
  const summary = summarise({
    walk: WALK,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    projectSource: 'derived',
    harness: 'claude-code',
    version: 'v',
    latencyMs: 1,
    transcriptBytes: 1,
  });
  const md = renderLedger({
    project: 'p',
    label: 'weird\\label',
    date: '2026-09-21',
    sessionId: 'abcdefgh-1',
    repoRoot: null,
    git: GIT,
    facts,
    isSessionEnd: false,
    reason: undefined,
    summary,
    harness: 'claude-code',
  });
  assert.match(md, /title: "Session ledger: weird\\\\label \(2026-09-21\)"/);
});

// The worktree root arrives from git as a resolved path while tool file paths
// arrive from the harness unresolved: through a symlinked tmpdir on macOS, or
// an 8.3 short name on a Windows runner. relative() between the two spellings
// walked out of the root and dropped every edit from "Files changed". This is
// the POSIX analogue of the Windows failure, via an explicit symlink.
test('collectFacts counts an edit when root and file spell the same dir differently', () => {
  const real = mkdtempSync(join(tmpdir(), 'll-ledger-real-'));
  const link = join(tmpdir(), `ll-ledger-link-${process.pid}-${Date.now()}`);
  symlinkSync(real, link);
  try {
    writeFileSync(join(real, 'a.txt'), 'x');
    const walk = {
      toolUses: [
        { direct: true, name: 'Edit', input: { file_path: join(real, 'a.txt') } },
        // Deleted since editing: still attributable via its existing parent.
        { direct: true, name: 'Edit', input: { file_path: join(real, 'gone.txt') } },
      ],
      assistantTexts: [],
      prompts: [],
    };
    const facts = collectFacts(walk, {
      worktreeRoot: link,
      cwd: link,
      vaultRoot: null,
      lastAssistantMessage: null,
    });
    assert.deepEqual(facts.files.map((f) => f.path).sort(), ['a.txt', 'gone.txt']);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
