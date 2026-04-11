// cache-health.js — oh-my-claude plugin
// Logs per-turn cache metrics to PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl
// Displays cache hit rate in the statusline.
//
// Data source: context_window.current_usage from Claude Code statusline payload.
// current_usage.cache_read_input_tokens, cache_creation_input_tokens, input_tokens
// are per-turn (reset each turn), verified against live transcript data.
//
// Note: the statusline payload does NOT include the nested cache_creation.ephemeral_5m/1h
// breakdown that the transcript has. Only the 4 top-level token fields are available here.
// For TTL-tier analysis, parse the transcript JSONL directly.
//
// Deduplication: Claude Code may fire the statusline multiple times per turn
// (permission changes, vim mode) with the same current_usage. We dedupe by
// matching session_id + cache_read + cache_creation to avoid duplicate JSONL rows.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const meta = {
  name: 'cache-health',
  description: 'Per-turn cache hit rate with JSONL logging for trend analysis',
  requires: [],
  defaultConfig: {
    style: 'dim',
    warnAt: 70,
    criticalAt: 40,
    styleWarn: 'yellow',
    styleCritical: 'red',
    logPath: null,
  },
};

const DEDUPE_FILE = join(tmpdir(), 'omc-cache-health-last.json');

function resolveLogPath(configPath, sessionId) {
  if (configPath) return configPath;
  const pluginData =
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'learning-loop-learning-loop-marketplace');
  const dir = join(pluginData, 'retrieval');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const month = new Date().toISOString().slice(0, 7);
  return join(dir, `cache-health-${month}.jsonl`);
}

function shouldLog(sessionId, read, create, uncached) {
  try {
    if (existsSync(DEDUPE_FILE)) {
      const last = JSON.parse(readFileSync(DEDUPE_FILE, 'utf8'));
      if (
        last.session_id === sessionId &&
        last.cache_read === read &&
        last.cache_creation === create &&
        last.input === uncached
      ) {
        return false;
      }
    }
  } catch {}
  try {
    writeFileSync(
      DEDUPE_FILE,
      JSON.stringify({ session_id: sessionId, cache_read: read, cache_creation: create, input: uncached }),
      'utf8'
    );
  } catch {}
  return true;
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

  const hitRate = read / total;
  const pct = Math.round(hitRate * 100);

  const sessionId = data.session_id;
  if (sessionId && shouldLog(sessionId, read, create, uncached)) {
    try {
      const logPath = resolveLogPath(cfg.logPath, sessionId);
      const record = {
        ts: new Date().toISOString(),
        session_id: sessionId,
        model: data.model?.id,
        version: data.version,
        cache_read: read,
        cache_creation: create,
        uncached_input: uncached,
        output_tokens: cu.output_tokens || 0,
        total_input: total,
        hit_rate: Math.round(hitRate * 10000) / 10000,
        used_percentage: data.context_window?.used_percentage,
        total_cost_usd: data.cost?.total_cost_usd,
      };
      appendFileSync(logPath, JSON.stringify(record) + '\n');
    } catch {}
  }

  let style;
  if (pct < cfg.criticalAt) style = cfg.styleCritical;
  else if (pct < cfg.warnAt) style = cfg.styleWarn;
  else style = cfg.style;

  return { text: `cache ${pct}%`, style };
}
