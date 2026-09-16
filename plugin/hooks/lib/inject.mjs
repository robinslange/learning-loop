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
// (agents-shared/adversarial-content.md, bench/verify-framing): delimiters
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

// Words too common to carry topic. Deliberately small: this runs per prompt
// inside a hard timeout, and a longer list buys nothing measurable.
const STOPWORDS = new Set(
  (
    'the a an and or but if then of to in on for with is are was were be been do does did this ' +
    'that it its as at by from we you i me my our your can could should would will just so now ' +
    'not no yes please lets let s t re ve ll m d'
  ).split(' '),
);

function contentTokens(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

// How specific is the ask? On judged real traffic this separates injections
// that changed the answer from those that did not far better than the
// retrieval score does (AUC 0.79 vs 0.43, n=44). A prompt carrying few content
// words is usually a continuation, an acknowledgement or a reaction, and no
// note can change what happens next on those turns.
//
// This does not replace the relevance gate. Relevance and impact are different
// quantities: the RRF gate cuts notes that do not match, this cuts turns no
// note can help. Both, in that order.
export function promptSpecificity(prompt) {
  return contentTokens(prompt).size;
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
    .map((m) => (m || '').slice(0, HookConfig.PRIOR_MSG_SLICE_CHARS))
    .filter(Boolean);
  // `padded` must mean "prior context actually got blended in", not merely
  // "the prompt was short enough that we tried". On a first turn slice(-3, -1)
  // yields nothing and the query is byte-identical to the prompt alone, so
  // reporting padded:true there overstates the padded rate in telemetry and
  // hands the thin-continuation counterfactual a query that was never padded.
  if (prior.length === 0) return { query: head, soloQuery: head, padded: false };
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
  // A body-bearing hit fills a body slot and every other hit is a pointer. Peer
  // rows lose their body here, the same allowlist wrapRetrieval() applies on
  // the JSON path: a federated note is awareness, never content. Which hit
  // supplies a body is therefore a property of the row, not of its rank.
  //
  // Measured on 206 live turns: a body-slot note is used 31.6% of the time, a
  // pointer 5.1%. Controlling for the note (74 notes appeared at both levels)
  // the format alone is worth 2.5x, 30.7% against 12.2%. The slot count is the
  // lever, so it is a constant rather than whatever findIndex happened to land
  // on. Total stays at five notes: this trades a pointer for a body, so format
  // is the only variable.
  const BODY_SLOTS = 2;
  const POINTER_SLOTS = 3;
  const filtered = vaultHits.map(stripPointerContent).filter((h) => levelOf(h.path) !== 'body');
  if (filtered.length === 0) return null;

  const bodies = filtered.filter((h) => h.body).slice(0, BODY_SLOTS);
  const taken = new Set(bodies);
  const pointers = filtered
    .filter((h) => !taken.has(h) && !levelOf(h.path))
    .slice(0, POINTER_SLOTS);
  if (bodies.length === 0 && pointers.length === 0) return null;

  // Note bodies and peer-controlled titles go in verbatim; the delimiter is
  // nonced so neither can name the terminator.
  const { open, close } = sealedDelimiters('vault-note', 'trust="untrusted-data"');
  const injectedVault = [];
  const lines = [
    bodies.length > 0
      ? `## From your vault (top match: ${bodies[0].title}, match score ${Number(bodies[0].score).toFixed(2)})`
      : '## From your vault (pointers only)',
    '',
    open,
  ];
  bodies.forEach((b, i) => {
    if (i > 0) lines.push('');
    lines.push(truncateAtSentenceBoundary(b.body, 300));
    injectedVault.push({ path: b.path, level: 'body', score: b.score });
  });
  if (pointers.length > 0) {
    if (bodies.length > 0) lines.push('');
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
