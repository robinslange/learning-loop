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
} from './lib/common.mjs';
import {
  buildInjection,
  emitHookOutput,
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

const input = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  const timeout = setTimeout(() => resolve(''), HookConfig.LABEL_TIMEOUT_MS);
  process.stdin.on('data', (chunk) => (data += chunk));
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    resolve(data);
  });
});

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

// Collect user messages from transcript, most recent last
let messages = [];
if (transcript_path && existsSync(transcript_path)) {
  try {
    const lines = readFileSync(transcript_path, 'utf8').trim().split('\n');
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
  [/\boh.my.claude\b|\bomc\b/, 'oh-my-claude'],
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
  [/\bsupplement\b|\bcompound\b|\bnootropic/, 'supplements'],
  [/\bautis[a-z]*\b|\bneurodiv|\baudhd\b/, 'autism'],
  [/\bsleep\b|\bcircadian\b|\bmelatonin/, 'sleep'],
  [/\beczema\b|\btsw\b|\bdermat/, 'skin'],
  [/\bgrid.bot\b|\btrading\b/, 'trading'],
  [/\bcoaching\b/, 'coaching'],
  [/\bwow\b|\bresto.druid\b|\bmythic/, 'WoW'],
  [/\bpr\b.*#?\d+|\bpull.request/, 'PR'],
  [/\blinear\b|\bticket\b|\bkin-\d+/i, 'tickets'],
];

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

const allTopicPatterns = [...instanceTopicPatterns(), ...topicPatterns];

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

function loadDedupeState(sid) {
  const p = dedupeStatePath(sid);
  if (!p) return new Set();
  const { value } = safeLoad(p, { fallback: [] });
  const arr = Array.isArray(value) ? value : [];
  const cutoff = Date.now() - HookConfig.DEDUPE_WINDOW_MS;
  return new Set(arr.filter((e) => new Date(e.ts).getTime() >= cutoff).map((e) => e.path));
}

function persistDedupeState(sid, newPaths) {
  const p = dedupeStatePath(sid);
  if (!p) return;
  try {
    withLock(p, { retries: 1, retryDelayMs: 5 }, () => {
      const { value } = safeLoad(p, { fallback: [] });
      const existing = Array.isArray(value) ? value : [];
      const cutoff = Date.now() - HookConfig.DEDUPE_WINDOW_MS;
      const kept = existing.filter((e) => new Date(e.ts).getTime() >= cutoff);
      const ts = new Date().toISOString();
      for (const path of newPaths) kept.push({ path, ts });
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
    episodic: {
      latency_ms: results.episodic?.latency_ms,
      hits: results.episodic?.hits?.length || 0,
      error: results.episodic?.error,
      raced_out: results.episodic?.raced_out,
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

  const priorMsgs = messages
    .slice(-3, -1)
    .map((m) => (m || '').slice(0, HookConfig.PRIOR_MSG_SLICE_CHARS));
  const query = [(prompt || '').slice(0, HookConfig.QUERY_SLICE_CHARS), ...priorMsgs].join(' ');

  const vaultRoot = resolveVaultPath();
  if (!vaultRoot) {
    logShadow({ type: 'gate-fail-no-vault', gate: { passed: false, error: 'no_vault_path' } });
    process.exit(0);
  }
  const vaultDbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

  const raceCapMs = env.LEARNING_LOOP_INJECTION_RACE_CAP_MS;
  const results = await runBackendsWithRaceCap({ query, vaultDbPath, raceCapMs });

  const vaultTop = results.vault?.hits?.[0]?.score || 0;
  const episodicTop = results.episodic?.hits?.[0]?.score || 0;

  // Threshold cascade: env (if set) > config > HookConfig default.
  const gateThreshold = env.LEARNING_LOOP_INJECTION_THRESHOLD_SET
    ? env.LEARNING_LOOP_INJECTION_THRESHOLD
    : (resolveConfig().injection_threshold ?? HookConfig.INJECTION_THRESHOLD);
  if (vaultTop < gateThreshold && episodicTop < gateThreshold) {
    logShadow({
      type: 'gate-fail-below-threshold',
      gate: {
        passed: false,
        vault_top_score: vaultTop,
        episodic_top_score: episodicTop,
        threshold: gateThreshold,
      },
      backends: summarizeBackends(results),
    });
    process.exit(0);
  }

  const alreadyInjectedPaths = loadDedupeState(session_id);
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
    episodicHits: results.episodic?.hits || [],
    query,
    alreadyInjectedPaths,
  });
  const dedupeFilteredCount = rawVaultHitCount - (injection?.injectedVaultPaths?.length || 0);

  if (!injection) {
    logShadow({
      type: 'gate-pass-no-payload',
      gate: { passed: true },
      backends: summarizeBackends(results),
      payload: null,
      dedupe_filtered_count: dedupeFilteredCount,
    });
    process.exit(0);
  }

  const scrubbedContext = scrubSecrets(injection.additionalContext);

  if (mode === 'shadow') {
    logShadow({
      type: 'gate-pass-payload',
      gate: { passed: true, vault_top_score: vaultTop, episodic_top_score: episodicTop },
      backends: summarizeBackends(results),
      payload: {
        tokens_estimated: Math.ceil(injection.additionalContext.length / 4),
        vault_notes: injection.injectedVaultPaths.length,
      },
      dedupe_filtered_count: dedupeFilteredCount,
      would_inject: scrubbedContext,
    });
    persistDedupeState(session_id, injection.injectedVaultPaths);
  } else if (mode === 'live') {
    emitHookOutput({ event: 'UserPromptSubmit', additionalContext: scrubbedContext });
    persistDedupeState(session_id, injection.injectedVaultPaths);
  }
} catch (err) {
  process.stderr.write(`[learning-loop] injection pipeline error: ${err?.message || err}\n`);
}
