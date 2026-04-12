// cache-health.js — oh-my-claude plugin
//
// Quiet by default, loud when bad.
//
// Logs per-turn cache metrics to PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl
// and renders a statusline segment ONLY when something is worth looking at:
//
//   - current turn is a total bust (read=0 after warmup) -- always shown
//   - rolling-window hit rate drops below `warnAt` (default 95%)
//
// Otherwise returns null and the segment disappears. The JSONL keeps collecting
// regardless -- scripts/cache-health-report.mjs is where the real analysis lives.
//
// Warmup handling: the first `warmupTurns` of a session are skipped for display
// purposes. Real sessions always have a low lifetime hit rate for the first 10-30
// turns as the initial cache gets built up -- showing that as "bad" is noise.
//
// Window: hit rate is computed over the last `windowSize` turns, not lifetime.
// That means sustained degradation shows up quickly and transient busts self-heal
// out of the window. Lifetime stats live in the JSONL for the report tool.
//
// Data source: context_window.current_usage from Claude Code statusline payload.
// cache_read_input_tokens, cache_creation_input_tokens, input_tokens are per-turn
// (reset each turn), verified against live transcript data.
//
// Session state: running window for the current session lives at
// /tmp/omc-cache-health-session-{sid}.json so the aggregate survives across
// statusline invocations without re-reading the JSONL.
//
// Deduplication: Claude Code fires the statusline multiple times per turn
// (permission changes, vim mode) with identical current_usage. We dedupe by
// matching session_id + token counts so the window only advances once per real turn.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const meta = {
  name: 'cache-health',
  description: 'Rolling-window cache hit rate, quiet unless something is wrong',
  requires: [],
  defaultConfig: {
    warnAt: 95,
    criticalAt: 85,
    windowSize: 10,
    warmupTurns: 5,
    style: 'yellow',
    styleCritical: 'bold red',
    showBusts: true,
    logPath: null,
  },
};

const SESSION_DIR = tmpdir();
const DEDUPE_FILE = join(SESSION_DIR, 'omc-cache-health-last.json');

function sessionStatePath(sid) {
  return join(SESSION_DIR, `omc-cache-health-session-${sid}.json`);
}

function resolveLogPath(configPath) {
  if (configPath) return configPath;
  const pluginData =
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'learning-loop-learning-loop-marketplace');
  const dir = join(pluginData, 'retrieval');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const month = new Date().toISOString().slice(0, 7);
  return join(dir, `cache-health-${month}.jsonl`);
}

function isDuplicate(sessionId, read, create, uncached) {
  try {
    if (!existsSync(DEDUPE_FILE)) return false;
    const last = JSON.parse(readFileSync(DEDUPE_FILE, 'utf8'));
    return (
      last.session_id === sessionId &&
      last.cache_read === read &&
      last.cache_creation === create &&
      last.input === uncached
    );
  } catch { return false; }
}

function writeDedupe(sessionId, read, create, uncached) {
  try {
    writeFileSync(
      DEDUPE_FILE,
      JSON.stringify({ session_id: sessionId, cache_read: read, cache_creation: create, input: uncached }),
      'utf8'
    );
  } catch {}
}

function loadSessionState(sid) {
  try {
    const p = sessionStatePath(sid);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return null; }
}

function saveSessionState(sid, state) {
  try { writeFileSync(sessionStatePath(sid), JSON.stringify(state), 'utf8'); }
  catch {}
}

function appendTurn(state, read, create, uncached, windowSize, warmupTurns) {
  if (!state || !Array.isArray(state.window)) {
    state = {
      turns: 0,
      lifetime_read: 0,
      lifetime_create: 0,
      lifetime_uncached: 0,
      lifetime_busts: 0,
      window: [],
    };
  }
  state.turns += 1;
  state.lifetime_read += read;
  state.lifetime_create += create;
  state.lifetime_uncached += uncached;
  const turnTotal = read + create + uncached;
  if (turnTotal > 0 && read === 0) state.lifetime_busts += 1;

  // Only post-warmup turns enter the rolling window. This keeps the window
  // from being contaminated by the initial cache-creation burst.
  if (state.turns > warmupTurns) {
    state.window.push({ r: read, c: create, u: uncached });
    while (state.window.length > windowSize) state.window.shift();
  }
  return state;
}

function windowHitRate(state) {
  let r = 0, t = 0;
  for (const turn of state.window) {
    r += turn.r;
    t += turn.r + turn.c + turn.u;
  }
  return t > 0 ? r / t : 1;
}

/**
 * @param {object} data - Parsed stdin JSON from Claude Code
 * @param {object} config - Per-plugin config from theme
 * @returns {{text: string, style: string}|null}
 */
export function render(data, config) {
  const cfg = { ...meta.defaultConfig, ...config };

  const cu = data?.context_window?.current_usage;
  if (!cu) return null;

  const read = cu.cache_read_input_tokens || 0;
  const create = cu.cache_creation_input_tokens || 0;
  const uncached = cu.input_tokens || 0;
  const total = read + create + uncached;
  if (total === 0) return null;

  const sessionId = data.session_id;
  if (!sessionId) return null;

  const isNewTurn = !isDuplicate(sessionId, read, create, uncached);

  let state = loadSessionState(sessionId);
  if (isNewTurn) {
    state = appendTurn(state, read, create, uncached, cfg.windowSize, cfg.warmupTurns);
    saveSessionState(sessionId, state);
    writeDedupe(sessionId, read, create, uncached);

    try {
      const logPath = resolveLogPath(cfg.logPath);
      const lifetimeTotal = state.lifetime_read + state.lifetime_create + state.lifetime_uncached;
      const lifetimeRate = lifetimeTotal > 0 ? state.lifetime_read / lifetimeTotal : 0;
      const record = {
        ts: new Date().toISOString(),
        session_id: sessionId,
        model: data.model?.id,
        version: data.version,
        turn: state.turns,
        cache_read: read,
        cache_creation: create,
        uncached_input: uncached,
        output_tokens: cu.output_tokens || 0,
        total_input: total,
        turn_hit_rate: Math.round((read / total) * 10000) / 10000,
        window_hit_rate: Math.round(windowHitRate(state) * 10000) / 10000,
        lifetime_hit_rate: Math.round(lifetimeRate * 10000) / 10000,
        session_busts: state.lifetime_busts,
        used_percentage: data.context_window?.used_percentage,
        total_cost_usd: data.cost?.total_cost_usd,
      };
      appendFileSync(logPath, JSON.stringify(record) + '\n');
    } catch {}
  } else if (!state) {
    return null;
  }

  // Always show bust alert on the turn it happens, even in warmup.
  const turnIsBust = read === 0 && total > 0;
  if (isNewTurn && turnIsBust && cfg.showBusts) {
    return { text: `cache bust (${state.lifetime_busts})`, style: cfg.styleCritical };
  }

  // Suppress display during warmup — initial turns always have a low aggregate
  // because the cache is being built, not broken. Also suppress until the window
  // has enough samples to be meaningful.
  if (state.window.length < Math.min(cfg.windowSize, 3)) return null;

  // Only show when the rolling window has degraded.
  const winPct = windowHitRate(state) * 100;
  if (winPct >= cfg.warnAt) return null;

  const pct = Math.round(winPct);
  const style = winPct < cfg.criticalAt ? cfg.styleCritical : cfg.style;
  const bustNote = state.lifetime_busts > 0 ? ` ${state.lifetime_busts}b` : '';
  return { text: `cache ${pct}%${bustNote}`, style };
}
