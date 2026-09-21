// Pure ledger logic. The hook (hooks/session-ledger.js) owns I/O; everything
// here takes its inputs as arguments so tests can inject git and clocks.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';
import { toKebab } from '../../hooks/lib/filename-style.mjs';

export { toKebab };

// Strips every GIT_* key from the given environment (default process.env).
// This is not the process.env read env.mjs centralises: that module exists so
// production code reads named vars through one seam, but this function's
// whole job is filtering the inherited environment, so it must see the real
// thing. A git-hook parent (GIT_INDEX_FILE, GIT_DIR, GIT_WORK_TREE,
// GIT_COMMON_DIR) redirects a plain `git -C <dir>` call away from <dir> and
// onto whatever repo the hook is running inside; every `git` child this
// module or its tests spawn must run with those stripped.
export function gitEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

export function execGit(args, cwd, timeoutMs) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
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

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const PR_URL_RE = /https?:\/\/[^\s)>\]]+?(?:\/pull\/\d+|\/pull-requests\/\d+)/g;

export const SUMMARY_ENUMS = Object.freeze({
  git_state: new Set(['clean', 'dirty', 'not_repo', 'timeout']),
  end_reason: new Set(['open', 'clear', 'resume', 'logout', 'prompt_input_exit', 'other']),
  project_source: new Set(['mapped', 'derived', 'cwd']),
  harness: new Set(['claude-code', 'codex']),
});

export function truncate(text, n) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

function under(filePath, root) {
  if (!root || typeof filePath !== 'string' || !isAbsolute(filePath)) return null;
  const rel = relative(root, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export function collectFacts(walk, { worktreeRoot, cwd, vaultRoot, lastAssistantMessage }) {
  const scope = worktreeRoot || cwd;
  const edits = new Map();
  const skills = [];
  const agents = [];
  const skillArgs = [];
  for (const t of walk.toolUses) {
    if (!t.direct) continue;
    if (EDIT_TOOLS.has(t.name)) {
      const fp = t.input.file_path ?? t.input.notebook_path;
      if (vaultRoot && under(fp, vaultRoot)) continue;
      if (typeof fp === 'string' && fp.includes(`${sep}.claude${sep}projects${sep}`)) continue;
      const rel = under(fp, scope);
      if (rel) edits.set(rel, (edits.get(rel) || 0) + 1);
    } else if (t.name === 'Skill') {
      const args = typeof t.input.args === 'string' ? t.input.args : '';
      skills.push({ skill: t.input.skill || '', args });
      skillArgs.push(args);
    } else if (AGENT_TOOLS.has(t.name)) {
      agents.push({
        type: t.input.subagent_type || t.input.agent_type || 'general-purpose',
        description: typeof t.input.description === 'string' ? t.input.description : '',
      });
    }
  }
  const prText = [];
  for (const a of walk.assistantTexts) prText.push(a.text);
  for (const arg of skillArgs) prText.push(arg);
  if (lastAssistantMessage) prText.push(lastAssistantMessage);
  const matches = prText.join('\n').match(PR_URL_RE) || [];
  const seen = new Set();
  const prs = [];
  for (const url of matches) {
    if (!seen.has(url)) {
      seen.add(url);
      prs.push(url);
    }
  }
  return {
    files: [...edits.entries()].map(([path, n]) => ({ path, edits: n })),
    skills,
    agents,
    prs,
    goal: walk.prompts[0]?.text ?? null,
    stoppedAt:
      typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim()
        ? lastAssistantMessage
        : null,
  };
}

function enumOr(set, value, fallback) {
  return set.has(value) ? value : fallback;
}

export function summarise({
  walk,
  git,
  facts,
  isSessionEnd,
  reason,
  projectSource,
  harness,
  version,
  latencyMs,
  transcriptBytes,
}) {
  const duration =
    walk.firstTs && walk.lastTs ? Date.parse(walk.lastTs) - Date.parse(walk.firstTs) : 0;
  return {
    action: 'session-summary',
    prompts: walk.prompts.length,
    tool_uses: walk.toolUses.length,
    tool_uses_direct: walk.toolUses.filter((t) => t.direct).length,
    files_edited: facts.files.length,
    commits: git.commits.length,
    skills_invoked: facts.skills.length,
    agents_spawned: facts.agents.length,
    transcript_bytes: transcriptBytes,
    duration_ms: Number.isFinite(duration) && duration > 0 ? duration : 0,
    latency_ms: latencyMs,
    git_ms: git.gitMs,
    git_state: enumOr(SUMMARY_ENUMS.git_state, git.state, 'not_repo'),
    end_reason: isSessionEnd ? enumOr(SUMMARY_ENUMS.end_reason, reason, 'other') : 'open',
    project_source: enumOr(SUMMARY_ENUMS.project_source, projectSource, 'cwd'),
    harness: enumOr(SUMMARY_ENUMS.harness, harness, 'claude-code'),
    version: String(version || ''),
    final: Boolean(isSessionEnd),
  };
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const LABEL_MAX = 40;
const GOAL_CHARS = 200;
const STOP_CHARS = 600;

// Local calendar date, matching the local-getter convention log.mjs and
// retrieval.mjs use for their own month buckets: a session that runs past
// midnight UTC must still file under the operator's own day.
export function localDateStr(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function ledgerPath(project, dateStr, label, sessionId) {
  const slug =
    (toKebab(label || '') || 'session').slice(0, LABEL_MAX).replace(/-+$/, '') || 'session';
  return `4-projects/${project}/ledger/${dateStr}-${slug}-${String(sessionId).slice(0, 8)}.md`;
}

// Quotes a frontmatter scalar so YAML-significant characters in a project
// name, branch name, or session label (`"`, `\`, `:`, `#`, ...) can't break
// the parse. Escape order matters: backslash first, or escaping the quote
// would double-escape the backslash just inserted.
function yamlStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderLedger({
  project,
  label,
  date,
  sessionId,
  repoRoot,
  git,
  facts,
  isSessionEnd,
  reason,
  summary,
  harness,
}) {
  const title = `Session ledger: ${label || 'session'} (${date})`;
  const fm = [
    '---',
    `title: ${yamlStr(title)}`,
    `tags: [ledger, ${yamlStr(project)}]`,
    `date: ${date}`,
    'source: session',
    `session_id: ${sessionId}`,
    `repo: ${repoRoot ? yamlStr(basename(repoRoot)) : 'null'}`,
    `branch: ${git.branch !== null ? yamlStr(git.branch) : 'null'}`,
    `status: ${isSessionEnd ? 'ended' : 'open'}`,
  ];
  if (isSessionEnd) fm.push(`ended_reason: ${summary.end_reason}`);
  fm.push('---', '');

  const sections = [];
  const section = (heading, lines) => {
    if (lines.length) sections.push(`## ${heading}\n${lines.join('\n')}\n`);
  };
  section('Goal', facts.goal ? [truncate(facts.goal, GOAL_CHARS)] : []);
  section('Where it stopped', facts.stoppedAt ? [truncate(facts.stoppedAt, STOP_CHARS)] : []);
  section(
    'Commits this session',
    git.commits.slice(0, 15).map((c) => `- ${c.hash} ${c.subject}`),
  );
  section(
    'Files changed',
    facts.files
      .slice(0, 20)
      .map((f) => `- ${f.path} (${f.edits} ${f.edits === 1 ? 'edit' : 'edits'})`),
  );
  section(
    'Skills',
    facts.skills.map((s) => `- /${s.skill}${s.args ? ` ${truncate(s.args, 80)}` : ''}`),
  );
  section(
    'Agents',
    facts.agents.map(
      (a) => `- ${a.type}${a.description ? `: ${truncate(a.description, 80)}` : ''}`,
    ),
  );
  section(
    'PRs',
    facts.prs.map((u) => `- ${u}`),
  );
  section(
    'Open state',
    git.dirtyCount > 0
      ? [
          `${git.dirtyCount} uncommitted ${git.dirtyCount === 1 ? 'file' : 'files'} on ${git.branch ?? 'HEAD'}`,
        ]
      : [],
  );
  const footer = `${summary.prompts} ${summary.prompts === 1 ? 'prompt' : 'prompts'} · ${fmtDuration(summary.duration_ms)} · ${harness}\n`;
  return `${fm.join('\n')}${sections.join('\n')}\n${footer}`;
}

export function shouldWrite(summary, minPrompts) {
  return summary.files_edited >= 1 || summary.commits >= 1 || summary.prompts >= minPrompts;
}

export function shouldEmitSummary(marker, nowMs, isSessionEnd, intervalMs) {
  if (isSessionEnd) return true;
  const last = marker?.last_summary_ts ? Date.parse(marker.last_summary_ts) : NaN;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}

export function latestLedger(vaultRoot, project) {
  const rel = `4-projects/${project}/ledger`;
  const dir = join(vaultRoot, rel);
  let newest = null;
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  for (const name of names) {
    const mtime = statSync(join(dir, name)).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { name, mtime };
  }
  if (!newest) return null;
  const head = readFileSync(join(dir, newest.name), 'utf8').slice(0, 2048);
  const date = head.match(/^date:\s*(\S+)/m)?.[1] ?? newest.name.slice(0, 10);
  const status = head.match(/^status:\s*(\S+)/m)?.[1] ?? 'open';
  return { relPath: `${rel}/${newest.name}`, date, status };
}
