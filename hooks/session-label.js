#!/usr/bin/env node
// session-label.js — Derive a topic label from the conversation transcript
// Runs on every UserPromptSubmit. Updates as the session evolves.
// Scores topics by recency (current prompt >> old messages).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

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

writeFileSync(labelFile, label);
