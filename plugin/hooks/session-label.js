#!/usr/bin/env node
// session-label.js — Derive a topic label from the conversation transcript
// Runs on every UserPromptSubmit. Updates as the session evolves.
// Scores topics by recency (current prompt >> old messages).

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { emitRetrieval, readFileTail, readPayload } from './lib/common.mjs';
import {
  buildInjection,
  enrichVaultHits,
  buildQueryParts,
  promptSpecificity,
  runBackendsWithRaceCap,
  scrubSecrets,
  scrubForLog,
} from './lib/inject.mjs';
import { emitJson } from './lib/io.mjs';
import { safeLoad } from '../scripts/lib/safe-load.mjs';
import { withLock } from '../scripts/lib/file-lock.mjs';
import { env } from '../scripts/lib/env.mjs';
import { DATA_PATHS } from '../scripts/lib/paths.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { readVaultProjectIndexSync, listProjectSlugs } from '../scripts/route-project-artefact.mjs';
import {
  getVaultPath,
  getConfig,
  getPluginData,
  injectionSetting,
} from '../scripts/lib/config.mjs';
import { writeFileAtomic } from '../scripts/lib/write-atomic.mjs';
import { isMainModule } from '../scripts/lib/is-main.mjs';

// Collect user messages from transcript, most recent last. Transcripts grow
// to tens of MB (full tool outputs); only the tail is ever used, so read just
// the last TRANSCRIPT_TAIL_BYTES instead of the whole file — this hook runs
// on every UserPromptSubmit inside a hard outer timeout.
function readUserMessages(transcriptPath) {
  const messages = [];
  if (!transcriptPath || !existsSync(transcriptPath)) return messages;
  try {
    // filter(Boolean): when the transcript's final line exceeds the tail
    // window, readFileTail returns '' — without the filter that becomes a
    // single empty "line" that fails JSON.parse on every prompt.
    const lines = readFileTail(transcriptPath, HookConfig.TRANSCRIPT_TAIL_BYTES)
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
  return messages;
}

// --- Topic patterns ---
const BUILTIN_TOPICS = [
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
function configTopicPatterns(labelTopics) {
  if (!Array.isArray(labelTopics)) return [];
  const out = [];
  for (const t of labelTopics) {
    if (!t || typeof t.match !== 'string' || typeof t.label !== 'string') continue;
    try {
      out.push([new RegExp(t.match, 'i'), t.label]);
    } catch (err) {
      logError('session-label.configTopicPattern', err);
    }
  }
  return out;
}

function instanceTopicPatterns(projectSlugs) {
  return projectSlugs.map((slug) => {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const label = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return [new RegExp(`\\b${escaped}\\b`), label];
  });
}

// Instance projects first, then config topics, then the built-ins: topN keeps
// pattern order on a tied score, so a project slug outranks a generic topic
// that matched the same words.
export function topicPatterns(labelTopics, projectSlugs) {
  return [
    ...instanceTopicPatterns(projectSlugs),
    ...configTopicPatterns(labelTopics),
    ...BUILTIN_TOPICS,
  ];
}

function readTopicSources() {
  let labelTopics = [];
  let projectSlugs = [];
  try {
    labelTopics = getConfig().label_topics;
  } catch (err) {
    logError('session-label.configTopicPatterns', err);
  }
  try {
    const vaultRoot = getVaultPath();
    if (vaultRoot) projectSlugs = listProjectSlugs(readVaultProjectIndexSync(vaultRoot));
  } catch (err) {
    logError('session-label.instanceTopicPatterns', err);
  }
  return { labelTopics, projectSlugs };
}

// --- Action patterns ---
const ACTION_PATTERNS = [
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

// The n highest-scoring labels, only those that matched at all.
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

// Top two topics and the top action, the current prompt last in `messages`.
export function composeLabel(messages, patterns, cwd) {
  const label =
    [...topN(patterns, messages, 2), ...topN(ACTION_PATTERNS, messages, 1)].join(' ') ||
    basename(cwd || 'session');
  return label.length > HookConfig.LABEL_MAX_LENGTH
    ? label.slice(0, HookConfig.LABEL_MAX_LENGTH - 1) + '…'
    : label;
}

function dedupeStatePath(sid) {
  const pd = getPluginData();
  if (!pd) return null;
  const dir = DATA_PATHS.retrievalSessionDedupe(pd);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sid}.json`);
}

// The dedupe file's rows inside the window, one per path. Body beats pointer,
// and a row persisted before the level field existed counts as body
// (conservative: it may have carried content).
function readDedupeRows(p) {
  const { value } = safeLoad(p, { fallback: [] });
  const cutoff = Date.now() - HookConfig.DEDUPE_WINDOW_MS;
  const rows = new Map();
  for (const e of Array.isArray(value) ? value : []) {
    if (new Date(e.ts).getTime() < cutoff) continue;
    if (rows.get(e.path)?.level === 'body') continue;
    rows.set(e.path, { path: e.path, level: e.level === 'pointer' ? 'pointer' : 'body', ts: e.ts });
  }
  return rows;
}

// Map of path -> 'body' | 'pointer'.
function loadDedupeState(sid) {
  const p = dedupeStatePath(sid);
  if (!p) return new Map();
  return new Map([...readDedupeRows(p)].map(([path, row]) => [path, row.level]));
}

// Rewrites the file with one row per path, so it grows with distinct notes
// rather than with turns (4h of a busy session was ~2.6k rows).
function persistDedupeState(sid, newEntries, ts) {
  const p = dedupeStatePath(sid);
  if (!p) return;
  try {
    withLock(p, { retries: 1, retryDelayMs: 5 }, () => {
      const rows = readDedupeRows(p);
      for (const { path, level } of newEntries) {
        const prior = rows.get(path);
        rows.set(path, { path, level: prior?.level === 'body' ? 'body' : level, ts });
      }
      writeFileAtomic(p, JSON.stringify([...rows.values()]));
    });
  } catch (err) {
    if (err.code === 'ELOCK_TIMEOUT') return;
    logError('session-label.persistDedupeState', err);
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

async function inject({ session_id, prompt, messages, label }) {
  function logShadow(record) {
    try {
      emitRetrieval('shadow-injection', {
        session_label: label,
        prompt: scrubForLog(prompt, HookConfig.PROMPT_SLICE_CHARS),
        prompt_length: (prompt || '').length,
        ...(env.LEARNING_LOOP_SYNTHETIC ? { synthetic: true } : {}),
        ...record,
      });
    } catch (err) {
      logError('session-label.logShadow', err);
    }
  }

  if (env.LEARNING_LOOP_INJECTION_FORCE_ERROR) throw new Error('forced error for test');

  const mode = injectionSetting(env.LEARNING_LOOP_INJECTION_MODE, 'injection_mode', 'shadow');
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

  // Impact gate, before retrieval so a hopeless turn costs no search spawn.
  // The fast path above catches literal "ok"/"yes"; this catches the wider
  // class of turns carrying too little subject of their own for any note to
  // change what happens next.
  const specificityFloor = injectionSetting(
    env.LEARNING_LOOP_INJECTION_MIN_SPECIFICITY,
    'injection_min_prompt_specificity',
    HookConfig.INJECTION_MIN_PROMPT_SPECIFICITY,
  );
  const specificity = promptSpecificity(prompt);
  if (specificity < specificityFloor) {
    logShadow({
      type: 'gate-fail-low-impact',
      gate: { passed: false, prompt_specificity: specificity, floor: specificityFloor },
    });
    process.exit(0);
  }

  const { query, soloQuery, padded } = buildQueryParts({
    prompt,
    messages,
    soloMinChars: HookConfig.QUERY_SOLO_MIN_CHARS,
  });

  const vaultRoot = getVaultPath();
  if (!vaultRoot) {
    logShadow({ type: 'gate-fail-no-vault', gate: { passed: false, error: 'no_vault_path' } });
    process.exit(0);
  }
  const vaultDbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

  const raceCapMs = env.LEARNING_LOOP_INJECTION_RACE_CAP_MS ?? HookConfig.INJECTION_RACE_CAP_MS;
  const results = await runBackendsWithRaceCap({ query, soloQuery, vaultDbPath, raceCapMs });

  const vaultTop = results.vault?.hits?.[0]?.score || 0;
  // Counterfactual for the STEP-2 thin-continuation gate (log-only, no
  // suppression yet): on a padded query, did the injection score on the
  // prompt's own words, or only on the borrowed prior-message context? When
  // padded and the prompt alone would NOT have cleared the gate, the padding
  // was load-bearing — the candidate suppression target.
  const soloTop = padded ? results.vaultSolo?.hits?.[0]?.score || 0 : vaultTop;

  const gateThreshold = injectionSetting(
    env.LEARNING_LOOP_INJECTION_THRESHOLD,
    'injection_threshold',
    HookConfig.INJECTION_THRESHOLD,
  );
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

  const alreadyInjected = loadDedupeState(session_id);
  const rawVaultHitCount = (results.vault?.hits || []).length;
  const enrichedVaultHits = enrichVaultHits(results.vault?.hits || [], vaultRoot);
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
      backends: summarizeBackends(results),
      payload: null,
      dedupe_filtered_count: dedupeFilteredCount,
    });
    process.exit(0);
  }

  const scrubbedContext = scrubSecrets(injection.additionalContext);

  // Shared by both writes below: retrieval-usage.mjs joins the dedupe-state
  // entry and this gate-pass-payload record on (session_id, path, ts), so
  // two independent `new Date()` calls a few ms apart would read one live
  // injection as two surfaced events.
  const injectedAt = new Date().toISOString();

  // One record shape for both modes — live injections stay visible to
  // review-shadow.mjs, so gate recalibration keeps its data after go-live.
  if (mode === 'live') {
    emitJson({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: scrubbedContext },
    });
  }
  logShadow({
    type: 'gate-pass-payload',
    mode,
    ts: injectedAt,
    gate: {
      passed: true,
      vault_top_score: vaultTop,
      padded,
      solo_top_score: soloTop,
      padding_load_bearing: paddingLoadBearing,
    },
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
  persistDedupeState(session_id, injection.injectedVault, injectedAt);
}

if (isMainModule(import.meta.url)) {
  const payload = await readPayload('session-label');
  if (!payload) process.exit(0);
  const { session_id, prompt, transcript_path, cwd } = payload;
  if (!session_id || !prompt) process.exit(0);

  const messages = [...readUserMessages(transcript_path), prompt];
  const { labelTopics, projectSlugs } = readTopicSources();
  const label = composeLabel(messages, topicPatterns(labelTopics, projectSlugs), cwd);
  writeFileSync(join(tmpdir(), `claude-session-label-${session_id}.txt`), label);

  try {
    await inject({ session_id, prompt, messages, label });
  } catch (err) {
    process.stderr.write(`[learning-loop] injection pipeline error: ${err?.message || err}\n`);
  }
}
