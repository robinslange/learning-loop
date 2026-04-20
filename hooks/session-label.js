#!/usr/bin/env node
// session-label.js — Derive a topic label from the conversation transcript
// Runs on every UserPromptSubmit. Updates as the session evolves.
// Scores topics by recency (current prompt >> old messages).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveVaultPath, resolveConfig, resolvePluginData, emitRetrieval } from './lib/common.mjs';
import { buildInjection, emitHookOutput, runBackendsWithRaceCap, scrubSecrets } from './lib/inject.mjs';

const input = await new Promise(resolve => {
  let data = '';
  process.stdin.setEncoding('utf8');
  const timeout = setTimeout(() => resolve(''), 3000);
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
});

if (!input.trim()) process.exit(0);

const { session_id, prompt, transcript_path, cwd } = JSON.parse(input);
if (!session_id || !prompt) process.exit(0);

const labelFile = join(tmpdir(), `claude-session-label-${session_id}.txt`);

// Collect user messages from transcript, most recent last
let messages = [];
if (transcript_path && existsSync(transcript_path)) {
  try {
    const lines = readFileSync(transcript_path, 'utf8').trim().split('\n');
    for (const line of lines.slice(-80)) {
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
      } catch {}
    }
  } catch {}
}
messages.push(prompt);

// --- Scored matching ---
// Each message gets a weight: current prompt = 10, previous = 3, older = 1
function scorePatterns(patterns, textBlocks) {
  const scores = new Map();
  for (let i = 0; i < textBlocks.length; i++) {
    const text = textBlocks[i].toLowerCase();
    const isCurrentPrompt = i === textBlocks.length - 1;
    const isRecent = i >= textBlocks.length - 4;
    const weight = isCurrentPrompt ? 10 : isRecent ? 3 : 1;

    for (const [pattern, label] of patterns) {
      if (pattern.test(text)) {
        scores.set(label, (scores.get(label) || 0) + weight);
      }
    }
  }
  // Return highest-scoring label
  let best = '';
  let bestScore = 0;
  for (const [label, score] of scores) {
    if (score > bestScore) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

// --- Topic patterns ---
const topicPatterns = [
  [/\bkinso\b/, 'Kinso'],
  [/\bsolenoid\b/, 'Solenoid'],
  [/\bthalen\b/, 'Thalen'],
  [/\bnibbler\b/, 'Nibbler'],
  [/\bauctionsense\b/, 'AuctionSense'],
  [/\bwillems\b/, 'Willems'],
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
    const weight = isCurrentPrompt ? 10 : isRecent ? 3 : 1;
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

const topics = topN(topicPatterns, messages, 2);
const actions = topN(actionPatterns, messages, 1);
const topic = topics[0] || '';
const topic2 = topics[1] || '';
const action = actions[0] || '';

// --- Compose label ---
// Combine: "Project subtopic action" or "Topic action" or just "Topic"
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

if (label.length > 35) {
  label = label.slice(0, 34) + '\u2026';
}

function dedupeStatePath(sid) {
  const pd = resolvePluginData();
  if (!pd) return null;
  const dir = join(pd, 'retrieval', 'session-dedupe');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sid}.json`);
}

function loadDedupeState(sid) {
  const p = dedupeStatePath(sid);
  if (!p || !existsSync(p)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const cutoff = Date.now() - 180_000;
    return new Set(raw.filter(e => new Date(e.ts).getTime() >= cutoff).map(e => e.path));
  } catch {
    return new Set();
  }
}

function persistDedupeState(sid, newPaths) {
  const p = dedupeStatePath(sid);
  if (!p) return;
  let existing = [];
  try { if (existsSync(p)) existing = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  const cutoff = Date.now() - 180_000;
  const kept = existing.filter(e => new Date(e.ts).getTime() >= cutoff);
  const ts = new Date().toISOString();
  for (const path of newPaths) kept.push({ path, ts });
  writeFileSync(p, JSON.stringify(kept));
}

function logShadow(record) {
  try {
    emitRetrieval('shadow-injection', {
      session_label: label,
      prompt: scrubSecrets((prompt || '').slice(0, 200)),
      prompt_length: (prompt || '').length,
      ...record,
    });
  } catch {}
}

function summarizeBackends(results) {
  return {
    vault: { latency_ms: results.vault?.latency_ms, hits: results.vault?.hits?.length || 0, top_path: results.vault?.hits?.[0]?.path, error: results.vault?.error, raced_out: results.vault?.raced_out },
    episodic: { latency_ms: results.episodic?.latency_ms, hits: results.episodic?.hits?.length || 0, error: results.episodic?.error, raced_out: results.episodic?.raced_out },
  };
}

writeFileSync(labelFile, label);

try {
  if (process.env.LEARNING_LOOP_INJECTION_FORCE_ERROR === '1') throw new Error('forced error for test');

  const mode = process.env.LEARNING_LOOP_INJECTION_MODE || resolveConfig().injection_mode || 'shadow';
  if (mode === 'off') process.exit(0);

  const trimmed = (prompt || '').trim().replace(/[.!?,:;]+$/, '');
  if (
    trimmed.length < 20 ||
    /^(ok|yes|no|thanks|try\s+again|continue|go|sure|done)$/i.test(trimmed) ||
    trimmed.startsWith('<')
  ) {
    logShadow({ gate: { passed: false, fast_path_skip: true } });
    process.exit(0);
  }

  const priorMsgs = messages.slice(-3, -1).map(m => (m || '').slice(0, 200));
  const query = [(prompt || '').slice(0, 400), ...priorMsgs].join(' ');

  const vaultRoot = resolveVaultPath();
  if (!vaultRoot) {
    logShadow({ gate: { passed: false, error: 'no_vault_path' } });
    process.exit(0);
  }
  const vaultDbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

  const raceCapMs = Number(process.env.LEARNING_LOOP_INJECTION_RACE_CAP_MS || 1500);
  const results = await runBackendsWithRaceCap({ query, vaultDbPath, raceCapMs });

  const vaultTop = results.vault?.hits?.[0]?.score || 0;
  const episodicTop = results.episodic?.hits?.[0]?.score || 0;

  const gateThreshold = Number(process.env.LEARNING_LOOP_INJECTION_THRESHOLD || resolveConfig().injection_threshold || 0.35);
  if (vaultTop < gateThreshold && episodicTop < gateThreshold) {
    logShadow({ gate: { passed: false, vault_top_score: vaultTop, episodic_top_score: episodicTop, threshold: gateThreshold }, backends: summarizeBackends(results) });
    process.exit(0);
  }

  const alreadyInjectedPaths = loadDedupeState(session_id);
  const rawVaultHitCount = (results.vault?.hits || []).length;
  const enrichedVaultHits = (results.vault?.hits || []).map(h => {
    if (h.body) return h;
    try {
      const raw = readFileSync(join(vaultRoot, h.path), 'utf8');
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      return { ...h, body };
    } catch {
      return { ...h, body: '' };
    }
  }).filter(h => h.body);
  const injection = buildInjection({
    vaultHits: enrichedVaultHits,
    episodicHits: results.episodic?.hits || [],
    query,
    alreadyInjectedPaths,
  });
  const dedupeFilteredCount = rawVaultHitCount - (injection?.injectedVaultPaths?.length || 0);

  if (!injection) {
    logShadow({ gate: { passed: true }, backends: summarizeBackends(results), payload: null, dedupe_filtered_count: dedupeFilteredCount });
    process.exit(0);
  }

  if (mode === 'shadow') {
    logShadow({
      gate: { passed: true, vault_top_score: vaultTop, episodic_top_score: episodicTop },
      backends: summarizeBackends(results),
      payload: { tokens_estimated: Math.ceil(injection.additionalContext.length / 4), vault_notes: injection.injectedVaultPaths.length },
      dedupe_filtered_count: dedupeFilteredCount,
      would_inject: scrubSecrets(injection.additionalContext),
    });
    persistDedupeState(session_id, injection.injectedVaultPaths);
  } else if (mode === 'live') {
    emitHookOutput({ event: 'UserPromptSubmit', additionalContext: injection.additionalContext });
    persistDedupeState(session_id, injection.injectedVaultPaths);
  }
} catch (err) {
  process.stderr.write(`[learning-loop] injection pipeline error: ${err?.message || err}\n`);
}
