import { statSync, readFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { getConfig, getPluginData } from './lib/config.mjs';
import { DB_PATH, VAULT_PATH } from './lib/constants.mjs';
import { openReadonly } from './lib/sqljs.mjs';
import {
  TOOL_DEFS,
  executeTool,
  submitVoiceFlag,
  submitTagSuggestion,
  submitDuplicateFlag,
} from './lib/librarian-tools.mjs';
import { run as runBinary } from './lib/binary.mjs';
import {
  loadState,
  saveState,
  markVisited,
  pendingCount,
  expireStaleItems,
  appendItem,
  newItemId,
} from './lib/librarian-queue.mjs';

const cfg = getConfig();
const libCfg = cfg.librarian || {};

function resolveLogPath() {
  const pd = getPluginData();
  if (!pd) return null;
  return join(pd, 'librarian', 'librarian.log');
}

const LOG_PATH = resolveLogPath();
const LOG_MAX_BYTES = 10 * 1024 * 1024;

function rotateLogIfNeeded() {
  if (!LOG_PATH) return;
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      renameSync(LOG_PATH, LOG_PATH + '.1');
    }
  } catch {}
}

function log(msg) {
  process.stderr.write(msg);
  if (!LOG_PATH) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    mkdirSync(join(LOG_PATH, '..'), { recursive: true });
    appendFileSync(LOG_PATH, line, 'utf-8');
  } catch {}
}

const MODEL = libCfg.model || 'gemma4:e2b';
const PACE = (libCfg.pace_seconds || 2) * 1000;
const QUEUE_CAP = libCfg.queue_cap || 200;
const OLLAMA_URL = libCfg.ollama_url || 'http://localhost:11434';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForOllama({ maxAttempts = 10, intervalMs = 60000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
    } catch {}
    if (attempt === maxAttempts) {
      const err = new Error(
        `ollama unreachable at ${OLLAMA_URL} after ${maxAttempts} attempts (${(maxAttempts * intervalMs) / 1000}s). Install ollama or set librarian.ollama_url; disable via librarian.enabled=false in config.json.`,
      );
      err.code = 'OLLAMA_UNREACHABLE';
      throw err;
    }
    log(`Waiting for ollama (${attempt}/${maxAttempts})...\n`);
    await sleep(intervalMs);
  }
}

let _db = null;

async function getDb() {
  if (_db) return _db;
  _db = await openReadonly(DB_PATH);
  return _db;
}

async function getAllNotePaths() {
  const db = await getDb();
  const result = db.exec('SELECT path FROM notes');
  if (!result.length) return [];
  return result[0].values.map((r) => r[0]);
}

function pickNote(allPaths, visited) {
  const visitedSet = new Set(visited);
  const unvisited = allPaths.filter((p) => !visitedSet.has(p));
  if (!unvisited.length) return null;
  return unvisited[Math.floor(Math.random() * unvisited.length)];
}

function checkStaleness(notePath) {
  const fullPath = join(VAULT_PATH, notePath);
  const mtime = statSync(fullPath).mtimeMs;
  const ageMs = Date.now() - mtime;
  if (ageMs < 60 * 24 * 60 * 60 * 1000) return false;

  const body = readFileSync(fullPath, 'utf-8');
  const versionPattern = /v\d+\.\d+|\b20\d{2}\b|deprecated/i;
  const specificityPattern = /\d+\.?\d*\s*(ms|s|MB|GB|%|fps|req\/s|items|notes|tokens)/i;

  if (versionPattern.test(body) && specificityPattern.test(body)) {
    const matched = [];
    const vm = body.match(versionPattern);
    if (vm) matched.push(vm[0]);
    const sm = body.match(specificityPattern);
    if (sm) matched.push(sm[0]);

    appendItem({
      id: newItemId(),
      task: 'staleness_suspect',
      target: notePath,
      reason: `Note is ${Math.floor(ageMs / 86400000)} days old and contains version/specificity signals.`,
      matched_patterns: matched,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    return true;
  }
  return false;
}

async function noteNeedsInvestigation(notePath) {
  const db = await getDb();
  const s = notePath.split('/').pop().replace(/\.md$/, '');
  const inlinkRow = db.exec(
    `SELECT COUNT(*) FROM links WHERE target_path = ? AND target_path NOT LIKE '%[%'`,
    [s],
  );
  const inlinks = inlinkRow.length ? inlinkRow[0].values[0][0] : 0;

  const tagRow = db.exec(`SELECT tags FROM notes WHERE path = ?`, [notePath]);
  const tagsStr = tagRow.length && tagRow[0].values.length ? tagRow[0].values[0][0] : '';
  const tagCount = (tagsStr || '').split(' ').filter(Boolean).length;

  const tasks = [];
  if (inlinks === 0) tasks.push('link_check');
  if (notePath.startsWith('0-inbox/') || notePath.startsWith('1-fleeting/'))
    tasks.push('voice_gate');
  if (tagCount <= 1) tasks.push('tag_suggest');
  tasks.push('duplicate_check');
  return tasks;
}

const LINK_PROMPT = `You are a vault librarian. You wander through a knowledge vault, noticing things that need attention.

Right now you're looking at one note. Your tools let you check its neighborhood in the link graph.

For LINK INVESTIGATION (notes with 0 inlinks):
1. find_similar to see what's nearby
2. get_inlinks on neighbors to understand the local cluster
3. read_note on the orphan + best neighbor
4. submit_link if a reader would benefit from the cross-reference

Be liberal -- same domain = related. Different mechanisms within one field ARE connected.

You do NOT investigate staleness yourself. If something seems off, submit_suspect and move on. Claude will handle the deep investigation.`;

const VOICE_PROMPT = `Classify this Obsidian note title as "claim" (states an assertion that could be true or false) or "topic" (names a domain, concept, or entity without stating a relationship). A claim contains a verb or claim connective; a topic is a noun phrase without one. When in doubt, answer "claim".`;

const TAG_PROMPT = `You add tags to an Obsidian note. The tags must come from the supplied vocabulary list.

Output 0, 1, or 2 tags. Two is the maximum.

Choose tags that name the SPECIFIC subject matter of THIS note's body. The body is short; read it.

Do NOT add a tag because it is general or familiar. Do NOT pad to two tags. If only one tag clearly fits, return that one alone. If no tag from the vocabulary clearly applies to this note's specific subject, return an empty array.

Tags like "cognition", "design", or "psychology" are usually too broad. Prefer narrower tags ("pharmacology", "neuroscience", "habit-formation") whenever they fit.`;

const DUPLICATE_PROMPT = `You compare an Obsidian note against its nearest neighbour to detect duplicates.

"duplicate" = both notes make the SAME core claim, even if worded differently.
"same_topic" = notes cover the same domain but make DIFFERENT claims or arguments.
"unrelated" = no meaningful overlap.

Most neighbours will be same_topic, not duplicate. True duplicates are rare.
Only answer "duplicate" if the claims are interchangeable.`;

const STRUCTURAL_TAGS = new Set(['literature', 'counterpoint', 'synthesis', 'excalidraw']);

let _vocabularyCache = null;
async function getTagVocabulary() {
  if (_vocabularyCache) return _vocabularyCache;
  const db = await getDb();
  const rows = db.exec("SELECT tags FROM notes WHERE tags != ''");
  const counts = {};
  if (rows.length) {
    for (const [tagStr] of rows[0].values) {
      for (const t of tagStr.split(' ').filter(Boolean)) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  _vocabularyCache = ranked
    .filter(([t, n]) => n >= 3 && !STRUCTURAL_TAGS.has(t) && !t.startsWith('project/'))
    .slice(0, 60)
    .map(([t]) => t);
  return _vocabularyCache;
}

function readNoteBody(notePath, maxChars = 500) {
  const fullPath = join(VAULT_PATH, notePath);
  if (!existsSync(fullPath)) return null;
  let content = readFileSync(fullPath, 'utf-8');
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) content = content.slice(end + 4);
  }
  return content.trim().slice(0, maxChars);
}

async function voiceCheck(notePath) {
  const title = basename(notePath, '.md');
  let resp;
  try {
    resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: VOICE_PROMPT },
          { role: 'user', content: `Title: ${title}\nClassify:` },
        ],
        format: {
          type: 'object',
          properties: { label: { type: 'string', enum: ['claim', 'topic'] } },
          required: ['label'],
        },
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    log(`voiceCheck ${kind} for ${notePath}: ${err.message}\n`);
    return;
  }
  if (!resp.ok) {
    log(`voiceCheck HTTP ${resp.status} for ${notePath}\n`);
    return;
  }
  try {
    const { message } = await resp.json();
    const { label } = JSON.parse(message.content);
    if (label === 'topic') {
      await submitVoiceFlag({
        target: notePath,
        current_title: title,
        reason: 'topic-style title (structured-output classifier)',
      });
    }
  } catch (err) {
    log(`voiceCheck parse error for ${notePath}: ${err.message}\n`);
  }
}

async function tagCheck(notePath, _deps = {}) {
  const body = _deps.bodyOverride !== undefined ? _deps.bodyOverride : readNoteBody(notePath);
  if (!body) return;

  let existingTags;
  if (_deps.existingTagsOverride !== undefined) {
    existingTags = _deps.existingTagsOverride;
  } else {
    const db = await getDb();
    const tagRow = db.exec(`SELECT tags FROM notes WHERE path = ?`, [notePath]);
    existingTags = tagRow.length && tagRow[0].values.length ? tagRow[0].values[0][0] || '' : '';
  }

  const vocabulary = _deps.vocabularyOverride || (await getTagVocabulary());
  if (!vocabulary.length) return;

  const title = basename(notePath, '.md');
  const userContent = `Title: ${title}\nExisting tags: ${existingTags || '(none)'}\nBody:\n${body}\n\nVocabulary (tags you may use, nothing else): ${vocabulary.join(', ')}`;

  let resp;
  try {
    resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: TAG_PROMPT },
          { role: 'user', content: userContent },
        ],
        format: {
          type: 'object',
          properties: {
            suggested_tags: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 2,
            },
          },
          required: ['suggested_tags'],
        },
        options: { temperature: 0 },
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    log(`tagCheck ${kind} for ${notePath}: ${err.message}\n`);
    return;
  }
  if (!resp.ok) {
    log(`tagCheck HTTP ${resp.status} for ${notePath}\n`);
    return;
  }
  try {
    const { message } = await resp.json();
    const parsed = JSON.parse(message.content);
    const existingSet = new Set(existingTags.split(' ').filter(Boolean));
    const vocabSet = new Set(vocabulary);
    const cleaned = [
      ...new Set(
        (parsed.suggested_tags || []).filter((t) => vocabSet.has(t) && !existingSet.has(t)),
      ),
    ].slice(0, 2);
    if (cleaned.length === 0) return;
    await submitTagSuggestion({
      target: notePath,
      suggested_tags: cleaned,
      existing_tags: existingTags,
      reason: 'tag classifier (gemma4:e2b structured output)',
    });
  } catch (err) {
    log(`tagCheck parse error for ${notePath}: ${err.message}\n`);
  }
}

async function duplicateCheck(notePath, _deps = {}) {
  const body = _deps.bodyOverride !== undefined ? _deps.bodyOverride : readNoteBody(notePath);
  if (!body) return;

  let neighbours;
  if (_deps.neighboursOverride) {
    neighbours = _deps.neighboursOverride;
  } else {
    try {
      neighbours = runBinary(['similar', DB_PATH, notePath, '--top', '3']);
    } catch (err) {
      log(`duplicateCheck similar error for ${notePath}: ${err.message}\n`);
      return;
    }
  }
  if (!neighbours || !neighbours.length) return;

  const title = basename(notePath, '.md');
  const neighbourBlocks = neighbours
    .map((n, i) => {
      const nTitle = basename(n.path, '.md');
      const nBody = readNoteBody(n.path) || '(empty)';
      return `Neighbour ${i + 1} (similarity ${n.score.toFixed(3)}, path ${n.path}): "${nTitle}"\n${nBody}`;
    })
    .join('\n\n');

  const userContent = `Note (path ${notePath}): "${title}"\n${body}\n\n${neighbourBlocks}`;

  let resp;
  try {
    resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: DUPLICATE_PROMPT },
          { role: 'user', content: userContent },
        ],
        format: {
          type: 'object',
          properties: {
            relationship: {
              type: 'string',
              enum: ['duplicate', 'same_topic', 'unrelated'],
            },
            duplicate_of: { type: ['string', 'null'] },
          },
          required: ['relationship', 'duplicate_of'],
        },
        options: { temperature: 0 },
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    log(`duplicateCheck ${kind} for ${notePath}: ${err.message}\n`);
    return;
  }
  if (!resp.ok) {
    log(`duplicateCheck HTTP ${resp.status} for ${notePath}\n`);
    return;
  }
  try {
    const { message } = await resp.json();
    const parsed = JSON.parse(message.content);
    if (parsed.relationship !== 'duplicate') return;
    const claimed = parsed.duplicate_of;
    const match = neighbours.find((n) => n.path === claimed || basename(n.path, '.md') === claimed);
    if (!match) {
      log(`duplicateCheck: model named non-neighbour ${claimed} for ${notePath}, skipping\n`);
      return;
    }
    await submitDuplicateFlag({
      target: notePath,
      duplicate_of: match.path,
      similarity: match.score,
      reason: 'duplicate classifier (gemma4:e2b structured output)',
    });
  } catch (err) {
    log(`duplicateCheck parse error for ${notePath}: ${err.message}\n`);
  }
}

async function investigateNote(notePath, task) {
  if (task === 'voice_gate') {
    await voiceCheck(notePath);
    return;
  }
  if (task === 'tag_suggest') {
    await tagCheck(notePath);
    return;
  }
  if (task === 'duplicate_check') {
    await duplicateCheck(notePath);
    return;
  }

  const userMessage = `Investigate this orphan note (0 inlinks): ${notePath}`;

  const messages = [
    { role: 'system', content: LINK_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let turn = 0; turn < 8; turn++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: TOOL_DEFS,
          options: { temperature: 0, num_predict: 1000 },
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = await res.json();
      const msg = data.message;
      messages.push(msg);

      if (!msg.tool_calls || !msg.tool_calls.length) {
        break;
      }

      for (const tc of msg.tool_calls) {
        const result = await executeTool(tc.function.name, tc.function.arguments);
        messages.push({ role: 'tool', content: result });
      }
    } catch (err) {
      clearTimeout(timer);
      log(`Turn ${turn} error: ${err.message}\n`);
      break;
    }
  }
}

async function main() {
  if (!libCfg.enabled) {
    log('Librarian disabled in config\n');
    process.exit(0);
  }

  rotateLogIfNeeded();
  await waitForOllama();
  log(`Librarian started (model: ${MODEL}, pace: ${PACE / 1000}s)\n`);

  let state = loadState();
  if (!state.started_at) {
    state.started_at = new Date().toISOString();
  }

  const allPaths = await getAllNotePaths();
  log(`Loaded ${allPaths.length} notes\n`);

  while (true) {
    if (pendingCount() >= QUEUE_CAP) {
      log('Queue full, expiring stale items...\n');
      expireStaleItems(VAULT_PATH);
      if (pendingCount() >= QUEUE_CAP) {
        log('Queue still full, sleeping 5m...\n');
        await sleep(300000);
        continue;
      }
    }

    const note = pickNote(allPaths, state.visited || []);
    if (!note) {
      log('Full pass complete. Resetting visited set.\n');
      state.visited = [];
      saveState(state);
      continue;
    }

    try {
      checkStaleness(note);
    } catch {}

    const tasks = await noteNeedsInvestigation(note);
    if (tasks && tasks.length) {
      log(`Investigating ${note} (${tasks.join(', ')})\n`);
      for (const task of tasks) {
        try {
          await investigateNote(note, task);
        } catch (err) {
          log(`Investigation error for ${note} (${task}): ${err.message}\n`);
        }
      }
    }

    state = markVisited(state, note);
    saveState(state);
    await sleep(PACE);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`librarian.mjs

Long-running vault librarian daemon. Investigates notes that need attention
(low quality, missing tags, duplicates) using the local Ollama model.

Configuration: config.json -> librarian section
  enabled, model, pace_seconds, queue_cap, ...

Logs:    PLUGIN_DATA/librarian/librarian.log
State:   PLUGIN_DATA/librarian/state.json

This script runs until interrupted. There are no positional arguments.
`);
    process.exit(0);
  }
  main().catch((err) => {
    log(`Librarian fatal: ${err.message}\n`);
    process.exit(err.code === 'OLLAMA_UNREACHABLE' ? 2 : 1);
  });
}

export const __test__ = { voiceCheck, tagCheck, duplicateCheck, waitForOllama };
