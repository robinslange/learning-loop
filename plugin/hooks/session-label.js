#!/usr/bin/env node
// session-label.js — Derive a topic label from the conversation transcript
// Runs on every UserPromptSubmit. Updates as the session evolves.
// Scores topics by recency (current prompt >> old messages).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveVaultPath,
  resolveConfig,
  resolvePluginData,
  emitRetrieval,
  readFileTail,
  readStdin,
} from './lib/common.mjs';
import {
  buildInjection,
  buildQueryParts,
  emitHookOutput,
  rerankCandidates,
  runBackendsWithRaceCap,
  scrubSecrets,
} from './lib/inject.mjs';
import { safeLoad } from '../scripts/lib/safe-load.mjs';
import { withLock } from '../scripts/lib/file-lock.mjs';
import { env } from '../scripts/lib/env.mjs';
import { DATA_PATHS } from '../scripts/lib/paths.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { stripFrontmatter } from '../scripts/lib/markdown-parse.mjs';
import { readVaultProjectIndexSync, listProjectSlugs } from '../scripts/route-project-artefact.mjs';

const input = await readStdin();

if (!input.trim()) process.exit(0);

let parsed;
try {
  parsed = JSON.parse(input);
} catch (err) {
  logError('session-label.parseStdin', err);
  process.exit(0);
}
const { session_id, prompt, transcript_path, cwd } = parsed;
if (!session_id || !prompt) process.exit(0);

const labelFile = join(tmpdir(), `claude-session-label-${session_id}.txt`);

// Collect user messages from transcript, most recent last. Transcripts grow
// to tens of MB (full tool outputs); only the tail is ever used, so read just
// the last TRANSCRIPT_TAIL_BYTES instead of the whole file — this hook runs
// on every UserPromptSubmit inside a hard outer timeout.
let messages = [];
if (transcript_path && existsSync(transcript_path)) {
  try {
    // filter(Boolean): when the transcript's final line exceeds the tail
    // window, readFileTail returns '' — without the filter that becomes a
    // single empty "line" that fails JSON.parse on every prompt.
    const lines = readFileTail(transcript_path, HookConfig.TRANSCRIPT_TAIL_BYTES)
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of lines.slice(-HookConfig.RECENT_MSG_WINDOW)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user') {
          const msg = entry.message;
          if (typeof msg?.content === 'string') {
            messages.push(msg.content);
          } else if (Array.isArray(msg?.content)) {
            for (const block of msg.content) {
              if (block.type === 'text') messages.push(block.text);
            }
          }
        }
      } catch (err) {
        logError('session-label.parseTranscriptLine', err);
      }
    }
  } catch (err) {
    logError('session-label.readTranscript', err);
  }
}
messages.push(prompt);

// --- Topic patterns ---
const topicPatterns = [
  [/\bgraphql\b.*\bsubscription|\bsubscription\b.*\bgraphql/, 'GQL subscriptions'],
  [/\bgraphql\b|\bgql\b/, 'GraphQL'],
  [/\bsse\b/, 'SSE'],
  [/\bstatusline\b|\bstatus.line\b/, 'statusline'],
  [/\bclaude.code\b/, 'Claude Code'],
  [/\bplugin\b/, 'plugin'],
  [/\bhook\b/, 'hooks'],
  [/\bmcp\b/, 'MCP'],
  [/\bvault\b|\bobsidian\b|\binbox\b.*\bnote/, 'vault'],
  [/\bauth\b|\bauthentic/, 'auth'],
  [/\bai.service\b|\bai\b.*\bservice/, 'AI service'],
  [/\bdesktop\b|\btauri\b|\belectron\b/, 'desktop'],
  [/\bmobile\b|\bios\b|\bswift\b|\bandroid\b/, 'mobile'],
  [/\bfrontend\b|\breact\b|\bcomponent/, 'frontend'],
  [/\bbackend\b|\bapi\b.*\bservice/, 'backend'],
  [/\brailway\b|\bcloudflare\b|\bworker\b|\binfra/, 'infra'],
  [/\bpr\b.*#?\d+|\bpull.request/, 'PR'],
  [/\blinear\b|\bticket\b/, 'tickets'],
];

// Owner-specific topics come from config `label_topics`:
// [{ "match": "\\bkayak\\b", "label": "kayaking" }, ...]. An entry with a
// bad regex is skipped (logged), never fatal — labels degrade, hooks don't.
function configTopicPatterns() {
  try {
    const raw = resolveConfig().label_topics;
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
      if (!t || typeof t.match !== 'string' || typeof t.label !== 'string') continue;
      try {
        out.push([new RegExp(t.match, 'i'), t.label]);
      } catch (err) {
        logError('session-label.configTopicPattern', err);
      }
    }
    return out;
  } catch (err) {
    logError('session-label.configTopicPatterns', err);
    return [];
  }
}

function instanceTopicPatterns() {
  try {
    const vaultRoot = resolveVaultPath();
    if (!vaultRoot) return [];
    const slugs = listProjectSlugs(readVaultProjectIndexSync(vaultRoot));
    return slugs.map((slug) => {
      const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const label = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return [new RegExp(`\\b${escaped}\\b`), label];
    });
  } catch (err) {
    logError('session-label.instanceTopicPatterns', err);
    return [];
  }
}

const allTopicPatterns = [...instanceTopicPatterns(), ...configTopicPatterns(), ...topicPatterns];

// --- Action patterns ---
const actionPatterns = [
  [/\breview\b/, 'review'],
  [/\bdebug\b|\bfix\b.*(?:fail|error|broken|crash)/, 'debugging'],
  [/\brefactor\b/, 'refactoring'],
  [/\bdiscovery\b|\bresearch\b|\bexplore\b|\binvestigat/, 'research'],
  [/\bbuild\b|\bimplement\b|\bcreate\b/, 'building'],
  [/\btest\b|\btesting\b/, 'testing'],
  [/\bdeploy\b|\bship\b|\brelease\b/, 'deploying'],
  [/\bplan\b|\bdesign\b|\barchitect/, 'planning'],
  [/\bmigrat/, 'migration'],
  [/\bsetup\b|\bconfigur\b|\binstall/, 'setup'],
  [/\binbox\b.*\btriage\b|\b\/inbox\b/, 'triage'],
  [/\breflect\b|\bconsolidat/, 'reflection'],
  [/\bdeepen\b/, 'deepening'],
  [/\bclean.?up\b/, 'cleanup'],
];

// Get top 2 topics and top action
function topN(patterns, textBlocks, n) {
  const scores = new Map();
  for (let i = 0; i < textBlocks.length; i++) {
    const text = textBlocks[i].toLowerCase();
    const isCurrentPrompt = i === textBlocks.length - 1;
    const isRecent = i >= textBlocks.length - 4;
    const weight = isCurrentPrompt
      ? HookConfig.MSG_WEIGHT_CURRENT
      : isRecent
        ? HookConfig.MSG_WEIGHT_RECENT
        : HookConfig.MSG_WEIGHT_OLDER;
    for (const [pattern, label] of patterns) {
      if (pattern.test(text)) {
        scores.set(label, (scores.get(label) || 0) + weight);
      }
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label]) => label);
}

const topics = topN(allTopicPatterns, messages, 2);
const actions = topN(actionPatterns, messages, 1);
const topic = topics[0] || '';
const topic2 = topics[1] || '';
const action = actions[0] || '';

// --- Compose label ---
let label;
if (topic && topic2 && action) {
  label = `${topic} ${topic2} ${action}`;
} else if (topic && action) {
  label = `${topic} ${action}`;
} else if (topic && topic2) {
  label = `${topic} ${topic2}`;
} else if (topic) {
  label = topic;
} else if (action) {
  label = action;
} else {
  label = basename(cwd || 'session');
}

if (label.length > HookConfig.LABEL_MAX_LENGTH) {
  label = label.slice(0, HookConfig.LABEL_MAX_LENGTH - 1) + '\u2026';
}

function dedupeStatePath(sid) {
  const pd = resolvePluginData();
  if (!pd) return null;
  const dir = DATA_PATHS.retrievalSessionDedupe(pd);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sid}.json`);
}

// Returns Map of path -> 'body' | 'pointer'. Entries persisted before the
// level field existed are treated as 'body' (conservative: they may have
// carried content). Body wins when both levels are present.
function loadDedupeState(sid) {
  const p = dedupeStatePath(sid);
  if (!p) return new Map();
  const { value } = safeLoad(p, { fallback: [] });
  const arr = Array.isArray(value) ? value : [];
  const cutoff = Date.now() - HookConfig.DEDUPE_WINDOW_MS;
  const map = new Map();
  for (const e of arr) {
    if (new Date(e.ts).getTime() < cutoff) continue;
    const level = e.level === 'pointer' ? 'pointer' : 'body';
    if (map.get(e.path) !== 'body') map.set(e.path, level);
  }
  return map;
}

function persistDedupeState(sid, newEntries) {
  const p = dedupeStatePath(sid);
  if (!p) return;
  try {
    withLock(p, { retries: 1, retryDelayMs: 5 }, () => {
      const { value } = safeLoad(p, { fallback: [] });
      const existing = Array.isArray(value) ? value : [];
      const cutoff = Date.now() - HookConfig.DEDUPE_WINDOW_MS;
      const ts = new Date().toISOString();
      // One row per path: loadDedupeState only ever reads the newest entry for
      // a path, so keeping every timestamped repeat grows the file with the
      // window (4h of a busy session is ~2.6k rows) for no lookup benefit.
      // Collapsing on write bounds it by distinct notes instead of turns. Body
      // beats pointer, matching loadDedupeState's precedence.
      const byPath = new Map();
      for (const e of existing) {
        if (new Date(e.ts).getTime() < cutoff) continue;
        const prior = byPath.get(e.path);
        if (!prior || prior.level !== 'body') byPath.set(e.path, e);
      }
      for (const { path, level } of newEntries) {
        const prior = byPath.get(path);
        byPath.set(path, { path, level: prior?.level === 'body' ? 'body' : level, ts });
      }
      const kept = [...byPath.values()];
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(kept));
      renameSync(tmp, p);
    });
  } catch (err) {
    if (err.code === 'ELOCK_TIMEOUT') return;
    logError('session-label.persistDedupeState', err);
  }
}

function logShadow(record) {
  try {
    emitRetrieval('shadow-injection', {
      session_label: label,
      prompt: scrubSecrets((prompt || '').slice(0, HookConfig.PROMPT_SLICE_CHARS)),
      prompt_length: (prompt || '').length,
      ...(env.LEARNING_LOOP_SYNTHETIC ? { synthetic: true } : {}),
      ...record,
    });
  } catch (err) {
    logError('session-label.logShadow', err);
  }
}

function summarizeBackends(results) {
  return {
    vault: {
      latency_ms: results.vault?.latency_ms,
      hits: results.vault?.hits?.length || 0,
      top_path: results.vault?.hits?.[0]?.path,
      error: results.vault?.error,
      raced_out: results.vault?.raced_out,
    },
  };
}

writeFileSync(labelFile, label);

try {
  if (env.LEARNING_LOOP_INJECTION_FORCE_ERROR) throw new Error('forced error for test');

  // Mode cascade: env (if set) > config > default 'shadow'.
  const mode = env.LEARNING_LOOP_INJECTION_MODE_SET
    ? env.LEARNING_LOOP_INJECTION_MODE
    : resolveConfig().injection_mode || 'shadow';
  if (mode === 'off') process.exit(0);

  const trimmed = (prompt || '').trim().replace(/[.!?,:;]+$/, '');
  if (
    trimmed.length < HookConfig.MIN_LABEL_LENGTH ||
    /^(ok|yes|no|thanks|try\s+again|continue|go|sure|done)$/i.test(trimmed) ||
    trimmed.startsWith('<')
  ) {
    logShadow({ type: 'gate-fail-fast-path', gate: { passed: false, fast_path_skip: true } });
    process.exit(0);
  }

  const { query, soloQuery, padded } = buildQueryParts({
    prompt,
    messages,
    soloMinChars: HookConfig.QUERY_SOLO_MIN_CHARS,
  });

  const vaultRoot = resolveVaultPath();
  if (!vaultRoot) {
    logShadow({ type: 'gate-fail-no-vault', gate: { passed: false, error: 'no_vault_path' } });
    process.exit(0);
  }
  const vaultDbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

  const raceCapMs = env.LEARNING_LOOP_INJECTION_RACE_CAP_MS;
  const results = await runBackendsWithRaceCap({ query, soloQuery, vaultDbPath, raceCapMs });

  const vaultTop = results.vault?.hits?.[0]?.score || 0;
  // Counterfactual for the STEP-2 thin-continuation gate (log-only, no
  // suppression yet): on a padded query, did the injection score on the
  // prompt's own words, or only on the borrowed prior-message context? When
  // padded and the prompt alone would NOT have cleared the gate, the padding
  // was load-bearing — the candidate suppression target.
  const soloTop = padded ? results.vaultSolo?.hits?.[0]?.score || 0 : vaultTop;

  // Threshold cascade: env (if set) > config > HookConfig default.
  const gateThreshold = env.LEARNING_LOOP_INJECTION_THRESHOLD_SET
    ? env.LEARNING_LOOP_INJECTION_THRESHOLD
    : (resolveConfig().injection_threshold ?? HookConfig.INJECTION_THRESHOLD);
  // Padding is load-bearing when the padded query cleared the gate but the
  // prompt alone would not have. STEP 2 will suppress these; for now it is
  // recorded on gate-pass records only (a suppression target is a note that
  // passed).
  const paddingLoadBearing = padded && vaultTop >= gateThreshold && soloTop < gateThreshold;
  if (vaultTop < gateThreshold) {
    logShadow({
      type: 'gate-fail-below-threshold',
      gate: {
        passed: false,
        vault_top_score: vaultTop,
        threshold: gateThreshold,
      },
      backends: summarizeBackends(results),
    });
    process.exit(0);
  }

  // STEP 3 rerank counterfactual (log-only, no reordering yet): the plain
  // `query` path returns raw RRF fusion order; the vault says the top slot is
  // best only a third of the time and the reranker — a MiniLM cross-encoder
  // ll-search ships but the JIT path never calls — is the real lever. Run it
  // here on gate-pass only (we only care about reordering notes we would
  // inject) and record what it WOULD do, so injection-precision.mjs can later
  // ask whether reranking lifts rank-0 precision before we commit to reordering.
  // Fusion-order injection below is unchanged. Rerank score is cross-encoder
  // logits on a different scale from the RRF gate — logged, never gated on.
  const fusionTopPath = results.vault?.hits?.[0]?.path || null;
  let rerankInfo = null;
  try {
    const reranked = await rerankCandidates({
      query,
      vaultDbPath,
      candidates: HookConfig.INJECTION_RERANK_CANDIDATES,
      timeoutMs: HookConfig.INJECTION_RERANK_TIMEOUT_MS,
    });
    if (reranked.hits?.length) {
      const rerankOrder = reranked.hits.map((h) => h.path);
      rerankInfo = {
        rerank_top_path: rerankOrder[0] || null,
        rerank_order: rerankOrder,
        rerank_moved_top: rerankOrder[0] !== fusionTopPath,
        rerank_latency_ms: reranked.latency_ms ?? null,
      };
    } else {
      rerankInfo = { rerank_error: reranked.error || 'no_hits' };
    }
  } catch (err) {
    rerankInfo = { rerank_error: err?.message || String(err) };
  }

  const alreadyInjected = loadDedupeState(session_id);
  const rawVaultHitCount = (results.vault?.hits || []).length;
  const enrichedVaultHits = (results.vault?.hits || [])
    .map((h) => {
      if (h.body) return h;
      try {
        const raw = readFileSync(join(vaultRoot, h.path), 'utf8');
        const body = stripFrontmatter(raw).trim();
        return { ...h, body };
      } catch (err) {
        logError('session-label.enrichVaultHit', err);
        return { ...h, body: '' };
      }
    })
    .filter((h) => h.body);
  const injection = buildInjection({
    vaultHits: enrichedVaultHits,
    query,
    alreadyInjected,
  });
  const dedupeFilteredCount = rawVaultHitCount - (injection?.injectedVault?.length || 0);

  if (!injection) {
    logShadow({
      type: 'gate-pass-no-payload',
      gate: {
        passed: true,
        // Carried here as well as on gate-pass-payload: this entry cleared the
        // gate by definition, and every consumer (review-shadow's distribution
        // and reachability, the readiness check) reads vault_top_score. Omitting
        // it counted these rows as score 0 — dragging the distribution toward a
        // floor the gate had in fact been cleared above.
        vault_top_score: vaultTop,
        padded,
        solo_top_score: soloTop,
        padding_load_bearing: paddingLoadBearing,
      },
      rerank: rerankInfo,
      backends: summarizeBackends(results),
      payload: null,
      dedupe_filtered_count: dedupeFilteredCount,
    });
    process.exit(0);
  }

  const scrubbedContext = scrubSecrets(injection.additionalContext);

  // One record shape for both modes — live injections stay visible to
  // review-shadow.mjs, so gate recalibration keeps its data after go-live.
  if (mode === 'live') {
    emitHookOutput({ event: 'UserPromptSubmit', additionalContext: scrubbedContext });
  }
  logShadow({
    type: 'gate-pass-payload',
    mode,
    gate: {
      passed: true,
      vault_top_score: vaultTop,
      padded,
      solo_top_score: soloTop,
      padding_load_bearing: paddingLoadBearing,
    },
    rerank: rerankInfo,
    backends: summarizeBackends(results),
    payload: {
      tokens_estimated: Math.ceil(injection.additionalContext.length / 4),
      vault_notes: injection.injectedVault.length,
      // Full injected list (body + pointer slots, in rank order) so the
      // injected-vs-used join can score per rank, not just the top note.
      injected_paths: injection.injectedVault,
    },
    dedupe_filtered_count: dedupeFilteredCount,
    would_inject: scrubbedContext,
  });
  persistDedupeState(session_id, injection.injectedVault);
} catch (err) {
  process.stderr.write(`[learning-loop] injection pipeline error: ${err?.message || err}\n`);
}
