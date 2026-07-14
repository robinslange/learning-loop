import { spawn as defaultSpawn } from 'node:child_process';
import { findBinary, findEpisodicBinary } from './common.mjs';
import { emitJson } from './io.mjs';
import { warnOnce } from '../../scripts/lib/warn-once.mjs';
import { ortSpawnEnv } from '../../scripts/lib/binary.mjs';

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[po]_[A-Za-z0-9]{36,}/g,
  /sk-ant-api[A-Za-z0-9_-]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /cfpat-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-\/+=]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function scrubSecrets(text) {
  let result = text;
  for (const pat of SECRET_PATTERNS) {
    result = result.replace(pat, '[REDACTED]');
  }
  return result;
}

function truncateAtSentenceBoundary(text, maxTokens) {
  const charLimit = maxTokens * 4;
  if (text.length <= charLimit) return text;
  const slice = text.slice(0, charLimit);
  const boundaryRe = /[.!?](?:\s|\n)/g;
  let lastBoundary = -1;
  let m;
  while ((m = boundaryRe.exec(slice)) !== null) {
    lastBoundary = m.index + 1;
  }
  if (lastBoundary > 0) return text.slice(0, lastBoundary);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? text.slice(0, lastSpace) : slice;
}

// alreadyInjected is a Map of path -> 'body' | 'pointer'. A body-level entry
// suppresses the note entirely; a pointer-level entry only suppresses a repeat
// pointer — the note still qualifies for body injection (the model has only
// seen a one-line title, not the content). A plain Set (legacy callers) is
// treated as all-body.
const DIRECTIVE =
  'If a note below bears on the current request, apply it and say "Recall: <note title>" in your reply; if none do, ignore this block silently.';

export function buildInjection({ vaultHits, episodicHits, query, alreadyInjected }) {
  const levelOf = (path) =>
    alreadyInjected instanceof Map
      ? alreadyInjected.get(path)
      : alreadyInjected.has(path)
        ? 'body'
        : undefined;
  const filtered = vaultHits.filter((h) => levelOf(h.path) !== 'body');
  if (filtered.length === 0 && episodicHits.length === 0) return null;

  const sections = [];
  const injectedVault = [];

  if (filtered.length > 0) {
    const top = filtered[0];
    const body = truncateAtSentenceBoundary(top.body, 300);
    const lines = [
      `## From your vault (top match: ${top.title}, match score ${Number(top.score).toFixed(2)})`,
      '',
      body,
    ];
    injectedVault.push({ path: top.path, level: 'body' });

    const pointers = filtered
      .slice(1)
      .filter((h) => !levelOf(h.path))
      .slice(0, 4);
    if (pointers.length > 0) {
      lines.push('', 'Related notes:');
      for (const p of pointers) {
        lines.push(`- ${p.title} — ${p.path}`);
        injectedVault.push({ path: p.path, level: 'pointer' });
      }
    }
    sections.push(lines.join('\n'));
  }

  if (episodicHits.length > 0) {
    const lines = ['## From past conversations'];
    for (const hit of episodicHits.slice(0, 3)) {
      const snippet = hit.snippet.length > 120 ? hit.snippet.slice(0, 120) : hit.snippet;
      lines.push(`- [${hit.date}, ${hit.project}] ${snippet}`);
    }
    sections.push(lines.join('\n'));
  }

  return {
    additionalContext: [DIRECTIVE, ...sections].join('\n\n'),
    injectedVault,
  };
}

export function emitHookOutput({ event, additionalContext }) {
  emitJson({ hookSpecificOutput: { hookEventName: event, additionalContext } });
}

function spawnSearch(spawnFn, cmd, args, abortSignal, env) {
  return new Promise((resolve) => {
    const opts = { stdio: ['ignore', 'pipe', 'pipe'] };
    if (env) opts.env = env;
    const child = spawnFn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    const t0 = Date.now();

    if (child.stdout)
      child.stdout.on('data', (c) => {
        stdout += c;
      });
    if (child.stderr)
      child.stderr.on('data', (c) => {
        stderr += c;
      });

    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        latency_ms: Date.now() - t0,
        stdout,
        stderr,
        code,
        killed: child.killed,
      });
    });
    child.on('error', (err) => {
      resolve({ ok: false, latency_ms: Date.now() - t0, error: err.message, killed: child.killed });
    });

    const onAbort = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseVault(result) {
  if (!result.ok)
    return {
      hits: [],
      error: result.error || `exit ${result.code}`,
      raced_out: result.killed || false,
      latency_ms: result.latency_ms,
    };
  try {
    const parsed = JSON.parse(result.stdout);
    const hits = Array.isArray(parsed) ? parsed : parsed?.results || [];
    return { hits, raced_out: false, latency_ms: result.latency_ms };
  } catch {
    return { hits: [], error: 'parse_error', raced_out: false, latency_ms: result.latency_ms };
  }
}

function parseEpisodic(result) {
  if (!result.ok)
    return {
      hits: [],
      error: result.error || `exit ${result.code}`,
      raced_out: result.killed || false,
      latency_ms: result.latency_ms,
    };
  const hits = [];
  const lines = result.stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\d+\.\s*\[([^,]+),\s*([^\]]+)\]\s*-\s*(-?\d+)%/);
    if (m) {
      const project = m[1].trim();
      const date = m[2].trim();
      const score = parseInt(m[3], 10) / 100;
      let snippet = '';
      const next = (lines[i + 1] || '').trim();
      if (next.startsWith('"') && next.endsWith('"')) {
        snippet = next.slice(1, -1);
      } else if (next && !next.startsWith('Lines ') && !/^\d+\./.test(next)) {
        snippet = next;
      }
      hits.push({ date, project, snippet, score });
    }
  }
  return { hits, raced_out: false, latency_ms: result.latency_ms };
}

export async function runBackendsWithRaceCap({ query, vaultDbPath, raceCapMs, _spawnFn }) {
  const spawnFn = _spawnFn || defaultSpawn;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), raceCapMs);

  const useRealBinaries = !_spawnFn;
  const llBinary = useRealBinaries ? findBinary() : null;
  const llCmd = llBinary ? llBinary.bin : 'll-search';
  const llEnv = llBinary ? ortSpawnEnv(llBinary.binDir) : undefined;

  const epCmd = useRealBinaries ? findEpisodicBinary() : 'episodic-memory';
  if (useRealBinaries && !epCmd) {
    warnOnce(
      'episodic-unavailable',
      'learning-loop: episodic-memory unavailable; semantic recall disabled. Install via `claude plugin install episodic-memory@superpowers-marketplace` for full functionality.\n',
    );
  }

  const tasks = [
    spawnSearch(
      spawnFn,
      llCmd,
      ['query', '--top', '5', vaultDbPath, query],
      controller.signal,
      llEnv,
    ),
  ];
  if (epCmd) {
    tasks.push(
      spawnSearch(spawnFn, epCmd, ['search', '--vector', '--limit', '5', query], controller.signal),
    );
  }

  const results = await Promise.allSettled(tasks);
  clearTimeout(timer);

  const vault =
    results[0].status === 'fulfilled'
      ? parseVault(results[0].value)
      : { hits: [], error: 'rejected' };
  const episodic =
    epCmd && results[1]
      ? results[1].status === 'fulfilled'
        ? parseEpisodic(results[1].value)
        : { hits: [], error: 'rejected' }
      : { hits: [], error: 'episodic_unavailable' };
  return { vault, episodic };
}
