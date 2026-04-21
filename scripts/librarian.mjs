import { statSync, readFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from './lib/config.mjs';
import { DB_PATH, VAULT_PATH } from './lib/constants.mjs';
import { openReadonly } from './lib/sqljs.mjs';
import { TOOL_DEFS, executeTool } from './lib/librarian-tools.mjs';
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
const MODEL = libCfg.model || 'gemma4:e2b';
const PACE = (libCfg.pace_seconds || 2) * 1000;
const QUEUE_CAP = libCfg.queue_cap || 200;
const OLLAMA_URL = libCfg.ollama_url || 'http://localhost:11434';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForOllama() {
  while (true) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`);
      if (res.ok) return;
    } catch {}
    process.stderr.write('Waiting for ollama...\n');
    await sleep(60000);
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
  return result[0].values.map(r => r[0]);
}

function pickNote(allPaths, visited) {
  const visitedSet = new Set(visited);
  const unvisited = allPaths.filter(p => !visitedSet.has(p));
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
  const result = db.exec(
    `SELECT COUNT(*) FROM links WHERE target_path = ? AND target_path NOT LIKE '%[%'`,
    [s]
  );
  const inlinks = result.length ? result[0].values[0][0] : 0;

  if (inlinks === 0) return 'link_check';
  if (notePath.startsWith('0-inbox/') || notePath.startsWith('1-fleeting/')) return 'voice_gate';
  return null;
}

const SYSTEM_PROMPT = `You are a vault librarian. You wander through a knowledge vault, noticing things that need attention.

Right now you're looking at one note. Your tools let you check its neighborhood in the link graph.

For LINK INVESTIGATION (notes with 0 inlinks):
1. find_similar to see what's nearby
2. get_inlinks on neighbors to understand the local cluster
3. read_note on the orphan + best neighbor
4. submit_link if a reader would benefit from the cross-reference

Be liberal -- same domain = related. Different mechanisms within one field ARE connected.

For VOICE GATE (inbox/fleeting notes only):
- Does the title state a claim or just name a topic?
- submit_voice_flag if it's a topic title

You do NOT investigate staleness yourself. If something seems off, submit_suspect and move on. Claude will handle the deep investigation.`;

async function investigateNote(notePath, task) {
  const userMessage = task === 'link_check'
    ? `Investigate this orphan note (0 inlinks): ${notePath}`
    : `Voice gate check on inbox note: ${notePath}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
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
      process.stderr.write(`Turn ${turn} error: ${err.message}\n`);
      break;
    }
  }
}

async function main() {
  if (!libCfg.enabled) {
    process.stderr.write('Librarian disabled in config\n');
    process.exit(0);
  }

  await waitForOllama();
  process.stderr.write(`Librarian started (model: ${MODEL}, pace: ${PACE / 1000}s)\n`);

  let state = loadState();
  if (!state.started_at) {
    state.started_at = new Date().toISOString();
  }

  const allPaths = await getAllNotePaths();
  process.stderr.write(`Loaded ${allPaths.length} notes\n`);

  while (true) {
    if (pendingCount() >= QUEUE_CAP) {
      process.stderr.write('Queue full, expiring stale items...\n');
      expireStaleItems(VAULT_PATH);
      if (pendingCount() >= QUEUE_CAP) {
        process.stderr.write('Queue still full, sleeping 5m...\n');
        await sleep(300000);
        continue;
      }
    }

    const note = pickNote(allPaths, state.visited || []);
    if (!note) {
      process.stderr.write('Full pass complete. Resetting visited set.\n');
      state.visited = [];
      saveState(state);
      continue;
    }

    try {
      checkStaleness(note);
    } catch {}

    const task = await noteNeedsInvestigation(note);
    if (task) {
      process.stderr.write(`Investigating ${note} (${task})\n`);
      try {
        await investigateNote(note, task);
      } catch (err) {
        process.stderr.write(`Investigation error for ${note}: ${err.message}\n`);
      }
    }

    state = markVisited(state, note);
    saveState(state);
    await sleep(PACE);
  }
}

main().catch(err => {
  process.stderr.write(`Librarian fatal: ${err.message}\n`);
  process.exit(1);
});
