// tests/helpers/git-fixture.mjs
// Shared "init a throwaway git repo" fixture for the ledger tests. Every git
// child spawned here uses gitEnv() from session-ledger.mjs so a git-hook
// parent's GIT_INDEX_FILE/GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR never redirects
// these calls onto the outer repo instead of the fixture directory.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from '../../plugin/scripts/lib/session-ledger.mjs';

/**
 * gitEnv() plus no global or system git config. A developer's global config
 * can sign commits (a 1Password or GPG prompt hangs the suite), run global
 * hooks, or rewrite defaults. A missing GIT_CONFIG_GLOBAL file reads as empty.
 */
export function fixtureGitEnv() {
  return {
    ...gitEnv(),
    GIT_CONFIG_GLOBAL: join(tmpdir(), `ll-no-gitconfig-${process.pid}`),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

const gitOpts = { stdio: 'ignore', env: fixtureGitEnv() };

/**
 * Initialise a git repo at `dir` with one committed `a.txt`.
 *
 * @param {string} dir
 * @param {{ branch?: string }} [opts]
 * @returns {string} dir
 */
export function initRepo(dir, { branch = 'main' } = {}) {
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', branch], gitOpts);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.local'], gitOpts);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], gitOpts);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt'], gitOpts);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'ledger commit'], gitOpts);
  return dir;
}

/**
 * Run a git command in `dir` and return trimmed stdout.
 *
 * @param {string} dir
 * @param {...string} args
 * @returns {string}
 */
export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: fixtureGitEnv(),
  }).trim();
}
