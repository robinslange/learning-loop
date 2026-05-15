import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const KNOWN_FRAMEWORKS = [
  'next', 'react', 'vue', 'svelte', 'express', 'fastify', 'koa', 'nest',
  'axum', 'actix-web', 'rocket', 'django', 'flask', 'fastapi', 'rails',
  'phoenix', 'gin', 'echo',
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', '__pycache__', '.next', 'build', '.cache']);

function safeJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function readPackage(repo) {
  return safeJson(join(repo, 'package.json'));
}

function detectFrameworks(deps) {
  if (!deps) return [];
  const names = Object.keys(deps);
  return KNOWN_FRAMEWORKS.filter(fw =>
    names.some(n => n === fw || n.startsWith(`${fw}/`) || n.startsWith(`@${fw}/`))
  );
}

const FILE_WALK_CAP = 50_000;

function* walkFiles(dir, depth = 0, maxDepth = 8) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, depth + 1, maxDepth);
    else if (e.isFile()) yield full;
  }
}

function countByExtension(repo) {
  const counts = {};
  let total = 0;
  let truncated = false;
  for (const f of walkFiles(repo)) {
    if (total >= FILE_WALK_CAP) { truncated = true; break; }
    total++;
    const ext = extname(f).replace(/^\./, '');
    if (!ext) continue;
    counts[ext] = (counts[ext] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { languages: Object.fromEntries(sorted), file_count: total, file_count_truncated: truncated };
}

function listTopDirs(repo) {
  try {
    return readdirSync(repo, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .slice(0, 20);
  } catch { return []; }
}

function secondLevelForSubsystemDirs(repo) {
  const result = {};
  for (const sub of ['src', 'apps', 'packages', 'services']) {
    const p = join(repo, sub);
    if (!existsSync(p)) continue;
    try {
      result[sub] = readdirSync(p, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name).slice(0, 20);
    } catch {}
  }
  return result;
}

function gitInfo(repo) {
  let origin = null;
  let head = null;
  try {
    origin = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  try {
    head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  return { origin, head };
}

export function generateProfile(repoPath) {
  const pkg = readPackage(repoPath);
  const { languages, file_count, file_count_truncated } = countByExtension(repoPath);
  const top_dirs = listTopDirs(repoPath);
  const second_level_dirs = secondLevelForSubsystemDirs(repoPath);
  const deps = pkg?.dependencies || {};
  const allDeps = { ...deps, ...(pkg?.devDependencies || {}) };
  const frameworks_detected = detectFrameworks(allDeps);
  const { origin, head } = gitInfo(repoPath);

  return {
    name: pkg?.name || top_dirs[0] || 'unknown',
    version: pkg?.version || null,
    languages,
    file_count,
    file_count_truncated,
    top_dirs,
    second_level_dirs,
    dependencies_count: Object.keys(deps).length,
    frameworks_detected,
    has_workspaces: !!pkg?.workspaces,
    has_monorepo_signal:
      !!pkg?.workspaces ||
      existsSync(join(repoPath, 'turbo.json')) ||
      existsSync(join(repoPath, 'lerna.json')) ||
      existsSync(join(repoPath, 'pnpm-workspace.yaml')),
    git_origin: origin,
    git_head: head,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.argv[2];
  if (!repo) { console.error('Usage: ingest-profile.mjs <repo-path>'); process.exit(2); }
  console.log(JSON.stringify(generateProfile(repo), null, 2));
}
