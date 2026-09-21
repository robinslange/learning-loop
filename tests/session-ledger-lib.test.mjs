import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProject, gitFacts, execGit } from '../plugin/scripts/lib/session-ledger.mjs';

const gitOpts = { stdio: 'ignore' };
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
function initRepo(dir) {
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], gitOpts);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.local'], gitOpts);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], gitOpts);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt'], gitOpts);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'first'], gitOpts);
}
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

test('gitFacts reports not_repo when there is no worktree root', () => {
  const f = gitFacts(null, '2026-01-01T00:00:00Z', execGit, 2000);
  assert.deepEqual(f, { branch: null, commits: [], dirtyCount: 0, state: 'not_repo', gitMs: 0 });
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
