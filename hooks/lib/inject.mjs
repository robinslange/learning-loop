import { spawn as defaultSpawn } from 'node:child_process';

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[po]_[A-Za-z0-9]{36,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-\/+=]{20,}/g,
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

export function buildInjection({ vaultHits, episodicHits, query, alreadyInjectedPaths }) {
  const filtered = vaultHits.filter((h) => !alreadyInjectedPaths.has(h.path));
  if (filtered.length === 0 && episodicHits.length === 0) return null;

  const sections = [];
  const injectedVaultPaths = [];

  if (filtered.length > 0) {
    const top = filtered[0];
    const body = truncateAtSentenceBoundary(top.body, 300);
    const lines = [`## From your vault (top match: ${top.title}, similarity ${top.score})`, '', body];
    injectedVaultPaths.push(top.path);

    const pointers = filtered.slice(1, 5);
    if (pointers.length > 0) {
      lines.push('', 'Related notes:');
      for (const p of pointers) {
        lines.push(`- ${p.title} — ${p.path}`);
        injectedVaultPaths.push(p.path);
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
    additionalContext: sections.join('\n\n'),
    injectedVaultPaths,
  };
}

export function emitHookOutput({ event, additionalContext }) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext },
  }));
}

function spawnSearch(spawnFn, cmd, args, abortSignal) {
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t0 = Date.now();

    if (child.stdout) child.stdout.on('data', (c) => { stdout += c; });
    if (child.stderr) child.stderr.on('data', (c) => { stderr += c; });

    child.on('close', (code) => {
      resolve({ ok: code === 0, latency_ms: Date.now() - t0, stdout, stderr, code, killed: child.killed });
    });
    child.on('error', (err) => {
      resolve({ ok: false, latency_ms: Date.now() - t0, error: err.message, killed: child.killed });
    });

    const onAbort = () => { if (!child.killed) child.kill('SIGTERM'); };
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseVault(result) {
  if (!result.ok) return { hits: [], error: result.error || `exit ${result.code}`, raced_out: result.killed || false, latency_ms: result.latency_ms };
  try {
    return { hits: JSON.parse(result.stdout), raced_out: false, latency_ms: result.latency_ms };
  } catch {
    return { hits: [], error: 'parse_error', raced_out: false, latency_ms: result.latency_ms };
  }
}

function parseEpisodic(result) {
  if (!result.ok) return { hits: [], error: result.error || `exit ${result.code}`, raced_out: result.killed || false, latency_ms: result.latency_ms };
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

  const results = await Promise.allSettled([
    spawnSearch(spawnFn, 'll-search', ['query', '--top', '5', vaultDbPath, query], controller.signal),
    spawnSearch(spawnFn, 'episodic-memory', ['search', '--vector', '--limit', '5', query], controller.signal),
  ]);
  clearTimeout(timer);

  const vault = results[0].status === 'fulfilled' ? parseVault(results[0].value) : { hits: [], error: 'rejected' };
  const episodic = results[1].status === 'fulfilled' ? parseEpisodic(results[1].value) : { hits: [], error: 'rejected' };
  return { vault, episodic };
}
