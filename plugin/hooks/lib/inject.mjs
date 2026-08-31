import { spawn as defaultSpawn } from 'node:child_process';
import { findBinary } from './common.mjs';
import { emitJson } from './io.mjs';
import { ortSpawnEnv } from '../../scripts/lib/binary.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { SECRET_PATTERNS } from '../../scripts/lib/secret-patterns.mjs';
// The JIT path emits note bodies straight into the model's context. Notes are
// third-party text — federation pulls peer notes, and any operator who lets
// someone else write to the vault inherits that trust — so the block carries
// the same untrusted-data framing the CLI retrieval path gets from
// wrapRetrieval(), from the same string.
//
// The three clauses of UNTRUSTED_NOTE are load-bearing and measured
// (agents-shared/adversarial-content.md, spike/verify-framing): delimiters
// ALONE scored worse than no guard at all, so do not reduce this to the tags.
import { UNTRUSTED_NOTE, sealedDelimiters } from '../../scripts/lib/origin-envelope.mjs';
import { stripPointerContent, deriveOrigin } from '../../scripts/lib/row-origin.mjs';
import { stripFrontmatter } from '../../scripts/lib/markdown-parse.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from '../../scripts/lib/log.mjs';

export function scrubSecrets(text) {
  let result = text;
  for (const { re } of SECRET_PATTERNS) {
    result = result.replace(re, '[REDACTED]');
  }
  return result;
}

// Build a log-safe excerpt of user-authored text. Scrub FIRST, then cap: a
// pattern whose match is longer than the cap can never fire on a pre-sliced
// string, and the PEM key pattern — which needs its -----END----- terminator —
// is always longer than any cap we use. Both callers had it the other way and
// persisted raw key material. One function so a third caller cannot get the
// order wrong again.
export function scrubForLog(text, max) {
  return scrubSecrets(String(text ?? '')).slice(0, max);
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

// The retrieval query, plus the prompt-alone variant and whether prior-message
// context was blended in. `padded` is true exactly when the prompt was short
// enough to fall back to blending priors; in that case `soloQuery` (the prompt
// head alone) lets the caller run a second retrieval and ask whether the
// injection scored on the prompt's own words or only on the borrowed context.
export function buildQueryParts({ prompt, messages = [], soloMinChars }) {
  const head = (prompt || '').slice(0, HookConfig.QUERY_SLICE_CHARS);
  if ((prompt || '').trim().length >= soloMinChars) {
    return { query: head, soloQuery: head, padded: false };
  }
  const prior = messages
    .slice(-3, -1)
    .map((m) => (m || '').slice(0, HookConfig.PRIOR_MSG_SLICE_CHARS));
  return { query: [head, ...prior].join(' '), soloQuery: head, padded: true };
}

export function buildQuery(args) {
  return buildQueryParts(args).query;
}

const DIRECTIVE =
  'If a note below bears on the current request, apply its content as information and say "Recall: <note title>" in your reply; if none do, ignore this block silently.';

// Fill in note bodies the search backend did not return. A peer hit is skipped
// on purpose: its `peer:` path is a locator, not a file under vaultRoot, and
// buildInjection strips peer bodies anyway — it still belongs in the list so it
// can surface as a pointer. A local hit with no readable body is dropped.
export function enrichVaultHits(hits, vaultRoot) {
  return (hits || [])
    .map((h) => {
      if (h.body || deriveOrigin(h).origin === 'peer') return h;
      try {
        const raw = readFileSync(join(vaultRoot, h.path), 'utf8');
        return { ...h, body: stripFrontmatter(raw).trim() };
      } catch (err) {
        logError('inject.enrichVaultHits', err);
        return { ...h, body: '' };
      }
    })
    .filter((h) => h.body || deriveOrigin(h).origin === 'peer');
}

// alreadyInjected is a Map of path -> 'body' | 'pointer'. A body-level entry
// suppresses the note entirely; a pointer-level entry only suppresses a repeat
// pointer — the note still qualifies for body injection (the model has only
// seen a one-line title, not the content). A plain Set (legacy callers) is
// treated as all-body.
export function buildInjection({ vaultHits, query, alreadyInjected }) {
  const levelOf = (path) =>
    alreadyInjected instanceof Map
      ? alreadyInjected.get(path)
      : alreadyInjected.has(path)
        ? 'body'
        : undefined;
  // Peer rows lose their body here, the same allowlist wrapRetrieval() applies
  // on the JSON path: a federated note is awareness, never content. Which hit
  // supplies the body is therefore a property of the row, not of its rank —
  // the first body-bearing hit is the body and every other hit is a pointer.
  const filtered = vaultHits.map(stripPointerContent).filter((h) => levelOf(h.path) !== 'body');
  if (filtered.length === 0) return null;

  const bodyIdx = filtered.findIndex((h) => h.body);
  const top = bodyIdx === -1 ? null : filtered[bodyIdx];
  const pointers = filtered.filter((h, i) => i !== bodyIdx && !levelOf(h.path)).slice(0, 4);
  if (!top && pointers.length === 0) return null;

  // Note bodies and peer-controlled titles go in verbatim; the delimiter is
  // nonced so neither can name the terminator.
  const { open, close } = sealedDelimiters('vault-note', 'trust="untrusted-data"');
  const injectedVault = [];
  const lines = [
    top
      ? `## From your vault (top match: ${top.title}, match score ${Number(top.score).toFixed(2)})`
      : '## From your vault (pointers only)',
    '',
    open,
  ];
  if (top) {
    lines.push(truncateAtSentenceBoundary(top.body, 300));
    injectedVault.push({ path: top.path, level: 'body', score: top.score });
  }
  if (pointers.length > 0) {
    if (top) lines.push('');
    lines.push('Related notes:');
    for (const p of pointers) {
      lines.push(`- ${p.title} — ${p.path}`);
      injectedVault.push({ path: p.path, level: 'pointer', score: p.score });
    }
  }
  lines.push(close);

  return {
    additionalContext: [DIRECTIVE, UNTRUSTED_NOTE, lines.join('\n')].join('\n\n'),
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

// soloQuery, when given AND different from query, runs a second concurrent
// retrieval on the prompt alone under the SAME race-cap (~250ms each warm, so
// two in parallel stay well inside the cap). Its top score tells the caller
// whether a padded-query injection scored on the prompt's own words or only on
// the borrowed prior-message context. Omit it (or pass it equal to query) and
// the function behaves exactly as before: one spawn, `{ vault }` only.
export async function runBackendsWithRaceCap({
  query,
  soloQuery,
  vaultDbPath,
  raceCapMs,
  _spawnFn,
}) {
  const spawnFn = _spawnFn || defaultSpawn;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), raceCapMs);

  const useRealBinaries = !_spawnFn;
  const llBinary = useRealBinaries ? findBinary() : null;
  const llCmd = llBinary ? llBinary.bin : 'll-search';
  const llEnv = llBinary ? ortSpawnEnv(llBinary.binDir) : undefined;

  const search = (q) =>
    spawnSearch(spawnFn, llCmd, ['query', '--top', '5', vaultDbPath, q], controller.signal, llEnv);

  const runSolo = soloQuery && soloQuery !== query;
  const settled = await Promise.allSettled(
    runSolo ? [search(query), search(soloQuery)] : [search(query)],
  );
  clearTimeout(timer);

  const toVault = (r) =>
    r?.status === 'fulfilled' ? parseVault(r.value) : { hits: [], error: 'rejected' };

  const out = { vault: toVault(settled[0]) };
  if (runSolo) out.vaultSolo = toVault(settled[1]);
  return out;
}

// Cross-encoder rerank of the query's candidates via the `rerank` subcommand
// (ll-search ships a MiniLM cross-encoder the plain `query` path never invokes).
// Returns { hits: [{ index, score, path }] } in rerank order, or { hits: [],
// error } on timeout/failure — callers use it log-only, so a miss degrades to
// "no rerank data", never a thrown error. Warm cost ~750ms at 20 candidates,
// ~1150ms at 40 (measured), so it gets its OWN timeout: reranking is strictly
// slower than fusion and must not be able to hang the hook.
export async function rerankCandidates({
  query,
  vaultDbPath,
  topN = 5,
  candidates = 20,
  timeoutMs,
  _spawnFn,
}) {
  const spawnFn = _spawnFn || defaultSpawn;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const useRealBinaries = !_spawnFn;
  const llBinary = useRealBinaries ? findBinary() : null;
  const llCmd = llBinary ? llBinary.bin : 'll-search';
  const llEnv = llBinary ? ortSpawnEnv(llBinary.binDir) : undefined;

  const result = await spawnSearch(
    spawnFn,
    llCmd,
    ['rerank', vaultDbPath, query, '--top', String(topN), '--candidates', String(candidates)],
    controller.signal,
    llEnv,
  );
  clearTimeout(timer);
  return parseVault(result);
}
