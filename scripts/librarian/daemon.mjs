// scripts/librarian/daemon.mjs : librarian daemon loop and investigateNote.
//
// runDaemon drives the main loop: pick note, check staleness, investigate tasks,
// mark visited, sleep. Accepts an AbortSignal; drains state.save() on abort.
//
// SIGTERM drain note: when signal fires, the loop exits cleanly and saveState()
// is called within withLock (5-second budget covers state.save() only).
// In-flight investigateNote calls (up to 120s each via AbortSignal.timeout) are
// NOT interrupted -- they run to completion or their own timeout fires first.
// The 5-second budget in the dispatcher (librarian.mjs) handles the hard cutoff.

import { appendFileSync, existsSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPluginData } from '../lib/config.mjs';
import { loadLibrarianConfig } from './config.mjs';
import { DB_PATH, VAULT_PATH } from '../lib/constants.mjs';
import { openReadonly } from '../lib/sqljs.mjs';
import { loadState, saveState, markVisited, pendingCount, expireStaleItems } from './queue.mjs';
import { waitForOllama } from './ollama-client.mjs';
import { TOOL_DEFS, executeTool, extractModelProb } from './tools/index.mjs';
import { logError, info } from '../lib/log.mjs';
import {
  pickNote,
  checkStaleness,
  noteNeedsInvestigation,
  getTagVocabulary,
  readNoteBody,
  getAllNotePaths,
} from './daemon-helpers.mjs';

const LOG_MAX_BYTES = 10 * 1024 * 1024;

function resolveLogPath() {
  const pd = getPluginData();
  return pd ? join(pd, 'librarian', 'librarian.log') : null;
}

function rotateLogIfNeeded(logPath) {
  if (!logPath) return;
  try {
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      renameSync(logPath, logPath + '.1');
    }
  } catch (e) {
    logError('daemon:rotate', e);
  }
}

function daemonLog(logPath, msg) {
  if (!logPath) return;
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try {
    mkdirSync(join(logPath, '..'), { recursive: true });
    appendFileSync(logPath, line, 'utf-8');
  } catch (e) {
    logError('daemon:log', e);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function isOnBattery() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf-8', timeout: 2000 });
    return /drawing from 'Battery Power'/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Investigate a single note for a given task type.
 * Dispatches to the appropriate classifier or runs the agentic link-check loop.
 *
 * @param {string} notePath
 * @param {string} task
 * @param {object} cfg - loadLibrarianConfig() result
 * @param {object} db - vault SQLite DB
 * @param {(msg: string) => void} log
 */
export async function investigateNote(notePath, task, cfg, db, log) {
  const { ollamaUrl, model } = cfg;

  if (task === 'voice_gate') {
    const { voiceCheck } = await import('./tools/voice.mjs');
    await voiceCheck(notePath, { ollamaUrl, model, voicePrompt: cfg.voicePrompt, logFn: log });
    return;
  }
  if (task === 'tag_suggest') {
    const { tagCheck } = await import('./tools/tag-suggest.mjs');
    const vocabulary = await getTagVocabulary(db, cfg.structuralTags);
    const tagRow = db.exec('SELECT tags FROM notes WHERE path = ?', [notePath]);
    const existingTags =
      tagRow.length && tagRow[0].values.length ? tagRow[0].values[0][0] || '' : '';
    await tagCheck(notePath, {
      ollamaUrl,
      model,
      tagPrompt: cfg.tagPrompt,
      bodyOverride: readNoteBody(notePath),
      existingTagsOverride: existingTags,
      vocabularyOverride: vocabulary,
      logFn: log,
    });
    return;
  }
  if (task === 'duplicate_check') {
    const { duplicateCheck } = await import('./tools/duplicate.mjs');
    await duplicateCheck(notePath, {
      ollamaUrl,
      model,
      duplicatePrompt: cfg.duplicatePrompt,
      bodyOverride: readNoteBody(notePath),
      logFn: log,
    });
    return;
  }

  // link_check: agentic multi-turn loop
  const messages = [
    { role: 'system', content: cfg.linkPrompt },
    { role: 'user', content: 'Investigate this orphan note (0 inlinks): ' + notePath },
  ];
  const toolCtx = { neighbourScores: new Map(), modelProb: null };

  for (let turn = 0; turn < 8; turn++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOL_DEFS,
          options: { temperature: 0, num_predict: 1000 },
          logprobs: true,
          top_logprobs: 20,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json();
      const msg = data.message;
      messages.push(msg);

      const submitCall = msg.tool_calls?.find((tc) => tc.function?.name === 'submit_link');
      if (submitCall) {
        const trace = Array.isArray(data.logprobs) ? data.logprobs : msg.logprobs || null;
        const chosen = submitCall.function?.arguments?.confidence;
        if (trace && typeof chosen === 'string') {
          try {
            toolCtx.modelProb = extractModelProb(trace, chosen);
            if (toolCtx.modelProb === null)
              log('extractModelProb: no qualifying token position for ' + notePath + '\n');
          } catch (err) {
            logError('daemon:extractModelProb', err, { notePath });
            toolCtx.modelProb = null;
          }
        } else if (!trace) {
          log('extractModelProb: ollama response missing logprobs trace for ' + notePath + '\n');
        }
      }
      if (!msg.tool_calls || !msg.tool_calls.length) break;
      for (const tc of msg.tool_calls) {
        const result = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
        messages.push({ role: 'tool', content: result });
      }
    } catch (err) {
      clearTimeout(timer);
      logError('daemon:turn' + turn, err, { notePath });
      break;
    }
  }
}

/**
 * Run the librarian daemon loop until signal is aborted.
 * On abort, saves state and returns (drain window is the caller's responsibility).
 *
 * @param {{
 *   signal?: AbortSignal,
 *   configOverride?: object,
 *   deps?: { db?: object }
 * }} [opts]
 */
export async function runDaemon({ signal, configOverride, deps } = {}) {
  const cfg = configOverride || loadLibrarianConfig();
  if (!cfg.enabled) {
    info('daemon', 'librarian disabled in config');
    return;
  }

  const logPath = resolveLogPath();
  const log = (msg) => {
    process.stderr.write(msg);
    daemonLog(logPath, msg);
  };

  rotateLogIfNeeded(logPath);
  await waitForOllama({ url: cfg.ollamaUrl, logFn: log });
  log('Librarian started (model: ' + cfg.model + ', pace: ' + cfg.paceMs / 1000 + 's)\n');

  const db = deps?.db || (await openReadonly(DB_PATH));
  const allPaths = await getAllNotePaths(db);
  log('Loaded ' + allPaths.length + ' notes\n');

  let state = loadState();
  if (!state.started_at) state.started_at = new Date().toISOString();

  let batteryLogged = false;
  while (!signal?.aborted) {
    if (cfg.pauseOnBattery && isOnBattery()) {
      if (!batteryLogged) {
        log('On battery power, pausing (polling every ' + cfg.batteryPollMs / 1000 + 's)\n');
        batteryLogged = true;
      }
      await sleep(cfg.batteryPollMs, signal);
      continue;
    }
    if (batteryLogged) {
      log('AC power restored, resuming\n');
      batteryLogged = false;
    }

    if (pendingCount() >= cfg.queueCap) {
      log('Queue full, expiring stale items...\n');
      expireStaleItems(VAULT_PATH);
      if (pendingCount() >= cfg.queueCap) {
        log('Queue still full, sleeping 5m...\n');
        await sleep(300000, signal);
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
    } catch (e) {
      logError('daemon:checkStaleness', e, { note });
    }

    const tasks = await noteNeedsInvestigation(note, db);
    if (tasks && tasks.length) {
      log('Investigating ' + note + ' (' + tasks.join(', ') + ')\n');
      for (const task of tasks) {
        if (signal?.aborted) break;
        try {
          await investigateNote(note, task, cfg, db, log);
        } catch (err) {
          logError('daemon:investigate', err, { note, task });
        }
      }
    }

    state = markVisited(state, note);
    saveState(state);
    await sleep(cfg.paceMs, signal);
  }

  saveState(state);
  log('Librarian stopped, state saved.\n');
}
