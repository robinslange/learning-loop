// Pure ledger logic. The hook (hooks/session-ledger.js) owns I/O; everything
// here takes its inputs as arguments so tests can inject git and clocks.

import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

export { toKebab } from '../../hooks/lib/filename-style.mjs';

export function execGit(args, cwd, timeoutMs) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, timeout: err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' };
  }
}

export function resolveProject(cwd, config, git, timeoutMs) {
  const map = config?.projects && typeof config.projects === 'object' ? config.projects : {};
  const top = git(['rev-parse', '--show-toplevel'], cwd, timeoutMs);
  if (!top.ok) return { project: basename(cwd), source: 'cwd', repoRoot: null, worktreeRoot: null };
  const worktreeRoot = top.out.trim();
  const common = git(['rev-parse', '--git-common-dir'], cwd, timeoutMs);
  // --git-common-dir is the main repo's .git even from a worktree, so its
  // parent names the project; --show-toplevel names where the files are.
  const repoRoot = common.ok ? dirname(resolve(cwd, common.out.trim())) : worktreeRoot;
  const repo = basename(repoRoot);
  if (typeof map[repo] === 'string' && map[repo]) {
    return { project: map[repo], source: 'mapped', repoRoot, worktreeRoot };
  }
  return { project: repo, source: 'derived', repoRoot, worktreeRoot };
}

export function gitFacts(worktreeRoot, sinceIso, git, timeoutMs) {
  const facts = { branch: null, commits: [], dirtyCount: 0, state: 'not_repo', gitMs: 0 };
  if (!worktreeRoot) return facts;
  const t0 = Date.now();
  let timedOut = false;
  const run = (args) => {
    const r = git(args, worktreeRoot, timeoutMs);
    if (!r.ok && r.timeout) timedOut = true;
    return r.ok ? r.out : null;
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) facts.branch = branch.trim();
  const log = run(['log', `--since=${sinceIso}`, '--format=%h%x09%s', '-n', '15']);
  if (log) {
    facts.commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ...rest] = line.split('\t');
        return { hash, subject: rest.join('\t') };
      });
  }
  const status = run(['status', '--porcelain']);
  if (status !== null) facts.dirtyCount = status.split('\n').filter(Boolean).length;
  facts.gitMs = Date.now() - t0;
  facts.state = timedOut ? 'timeout' : facts.dirtyCount > 0 ? 'dirty' : 'clean';
  return facts;
}
