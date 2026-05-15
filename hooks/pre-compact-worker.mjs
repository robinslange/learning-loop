#!/usr/bin/env node
// pre-compact-worker.mjs — spike capture worker.
//
// Reads a Claude Code transcript (JSONL), asks the librarian's local Gemma
// model (via ollama) to extract atomic learnings, writes the result to
// 0-inbox/ for triage by /learning-loop:inbox. Detached, fire-and-forget. All
// errors logged to plugin-data, never raised. No external API cost — reuses
// the ollama process the librarian keeps warm.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVaultPath, resolvePluginData } from './lib/common.mjs';
import { chat } from '../scripts/librarian/ollama-client.mjs';

const TRANSCRIPT_PATH = process.argv[2];
const SESSION_ID = process.argv[3] || 'unknown';
const TRIGGER = process.argv[4] || 'unknown';
const MAX_TRANSCRIPT_CHARS = 50_000;
const MODEL = 'gemma4:e2b';
const TIMEOUT_MS = 120_000;

const pluginData = resolvePluginData();
const logFile = pluginData ? join(pluginData, 'pre-compact-spike.log') : null;

function log(msg) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function readTranscriptTail(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return '…[truncated head]…\n' + text.slice(-MAX_TRANSCRIPT_CHARS);
}

const SYSTEM_PROMPT = `Extract durable learnings from a Claude Code session transcript before context compression destroys detail.

Output 1-6 atomic Markdown notes separated by lines containing only '---'. Format per note:

---
title: <short title, sentence case>
type: feedback | project | reference | user | insight
---

<single paragraph body, 1-3 sentences, concrete and specific>

Rules:
- If nothing durable was learned, output exactly: NOTHING-TO-CAPTURE
- Skip routine tool-use chatter, debugging tangents, throwaway tasks.
- Capture: user corrections, non-obvious decisions, project state changes, surprising facts, novel patterns.
- No emojis. Plain language.
- Each note stands alone, no cross-references.
- Output ONLY the notes (or NOTHING-TO-CAPTURE). No preamble, no closing remark.`;

async function extract(transcript) {
  const res = await chat({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    signalTimeoutMs: TIMEOUT_MS,
  });
  return res?.message?.content ?? '';
}

try {
  if (!TRANSCRIPT_PATH || !existsSync(TRANSCRIPT_PATH)) {
    log(`no transcript path or missing file: ${TRANSCRIPT_PATH}`);
    process.exit(0);
  }
  const vault = resolveVaultPath();
  if (!vault) {
    log('no vault path configured');
    process.exit(0);
  }
  const inbox = join(vault, '0-inbox');
  if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });

  log(`start session=${SESSION_ID} trigger=${TRIGGER} model=${MODEL}`);
  const tail = readTranscriptTail(TRANSCRIPT_PATH);
  const result = (await extract(tail)).trim();

  if (!result || result === 'NOTHING-TO-CAPTURE') {
    log(`nothing-to-capture session=${SESSION_ID}`);
    process.exit(0);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const shortId = String(SESSION_ID).slice(0, 8);
  const outPath = join(inbox, `compact-capture-${ts}-${shortId}.md`);
  const header =
    `---\n` +
    `source: pre-compact-spike\n` +
    `session_id: ${SESSION_ID}\n` +
    `trigger: ${TRIGGER}\n` +
    `captured_at: ${new Date().toISOString()}\n` +
    `status: untriaged\n` +
    `---\n\n`;
  writeFileSync(outPath, header + result + '\n');
  log(`wrote ${outPath} (${result.length} chars)`);
} catch (err) {
  log(`error: ${err?.message || err}`);
}
