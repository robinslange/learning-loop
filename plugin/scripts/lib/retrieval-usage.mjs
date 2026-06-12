// scripts/lib/retrieval-usage.mjs — connect "note was surfaced" to "note was used".
//
// Surfacing sources (PLUGIN_DATA/retrieval/):
//   - queries-*.jsonl            vault-search top_paths   → via: 'retrieved'
//   - session-dedupe/<sid>.json  injected vault notes     → via: 'injected'
// Use source (PLUGIN_DATA/provenance/events-*.jsonl):
//   - action === 'note-usage'    emitted by /reflect Step 4.7 with
//     status 'used' | 'ignored' per surfaced note.
//
// Honesty contract: a note only counts as USED when an explicit 'used'
// event exists. Surfacing alone — including a full note body injected into
// context — is never use. Sessions that never ran the /reflect usage check
// contribute no events, so their surfaced notes stay in the "no recorded
// use" bucket; report labels must say so. The injected record is also
// partial: session-label.js prunes dedupe entries older than its dedupe
// window on each write, so only a session's most recent injection burst
// survives on disk.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_PATHS } from './paths.mjs';
import { logError } from './log.mjs';

const DAY_MS = 86_400_000;

function listFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJsonlRecords(dir, prefix) {
  const out = [];
  for (const f of listFiles(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.jsonl')) continue;
    let raw;
    try {
      raw = readFileSync(join(dir, f), 'utf-8');
    } catch (err) {
      logError('retrieval-usage.readJsonlRecords', err);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // malformed telemetry line — skip, don't fail the report
      }
    }
  }
  return out;
}

function isVaultNotePath(p) {
  return typeof p === 'string' && p.endsWith('.md') && !p.startsWith('peer:');
}

/**
 * Every surfacing event across the telemetry, flattened to one record per
 * (note, event): { path, ts, session_id, via: 'retrieved'|'injected', level? }.
 */
export function loadSurfacedEvents(pluginData) {
  if (!pluginData) return [];
  const events = [];

  const retrievalDir = DATA_PATHS.retrieval(pluginData);
  for (const rec of readJsonlRecords(retrievalDir, 'queries-')) {
    for (const p of rec.top_paths || []) {
      if (!isVaultNotePath(p)) continue;
      events.push({ path: p, ts: rec.ts, session_id: rec.session_id, via: 'retrieved' });
    }
  }

  const dedupeDir = DATA_PATHS.retrievalSessionDedupe(pluginData);
  for (const f of listFiles(dedupeDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = f.slice(0, -'.json'.length);
    let entries;
    try {
      entries = JSON.parse(readFileSync(join(dedupeDir, f), 'utf-8'));
    } catch {
      // unreadable/corrupt dedupe state — skip this session
    }
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!isVaultNotePath(e?.path)) continue;
      events.push({
        path: e.path,
        ts: e.ts,
        session_id: sid,
        via: 'injected',
        level: e.level === 'pointer' ? 'pointer' : 'body',
      });
    }
  }

  return events;
}

/**
 * Notes surfaced to ONE session, merged per path:
 * [{ path, via: ['injected','retrieved'], level? }] sorted by path.
 * Used by /reflect Step 4.7 to know what to classify.
 */
export function sessionSurfaced(pluginData, sessionId) {
  if (!sessionId) return [];
  const byPath = new Map();
  for (const e of loadSurfacedEvents(pluginData)) {
    if (e.session_id !== sessionId) continue;
    const cur = byPath.get(e.path) || { path: e.path, via: [] };
    if (!cur.via.includes(e.via)) cur.via.push(e.via);
    if (e.via === 'injected' && cur.level !== 'body') cur.level = e.level;
    byPath.set(e.path, cur);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * note-usage provenance events: [{ path, status: 'used'|'ignored', ts, session_id }].
 * Any status other than the literal 'used' is folded to 'ignored' — the
 * conservative reading when an emitter mislabels.
 */
export function loadNoteUsageEvents(pluginData) {
  if (!pluginData) return [];
  const dir = DATA_PATHS.provenance(pluginData);
  const out = [];
  for (const rec of readJsonlRecords(dir, 'events-')) {
    if (rec.action !== 'note-usage' || !isVaultNotePath(rec.target)) continue;
    out.push({
      path: rec.target,
      status: rec.status === 'used' ? 'used' : 'ignored',
      ts: rec.ts,
      session_id: rec.session_id,
    });
  }
  return out;
}

/**
 * Aggregate surfacing vs use.
 *
 * @param {string} pluginData
 * @param {object} [opts]
 * @param {number} [opts.now]          Epoch ms anchor (tests inject).
 * @param {number} [opts.windowDays]   Surfacing window (default 90).
 * @param {number} [opts.minSurfaced]  Surfacing count needed before a
 *                                     never-used note becomes a candidate.
 * @param {string[]|null} [opts.vaultNotes] Vault-relative note paths; when
 *                                     given, never_surfaced is computed.
 * @returns {{
 *   window_days: number,
 *   coverage_days: number|null,   // actual telemetry span, capped at window
 *   coverage_limited: boolean,    // true when logs are younger than window
 *   used_events: number, ignored_events: number, evaluated_notes: number,
 *   surfaced_notes: number,
 *   surfaced_never_used: {path:string,surfaced:number,ignored_events:number,last_surfaced:string,via:string[]}[],
 *   never_surfaced: string[],
 * }}
 */
export function usageReport(pluginData, opts = {}) {
  const { now = Date.now(), windowDays = 90, minSurfaced = 3, vaultNotes = null } = opts;
  const sinceMs = now - windowDays * DAY_MS;

  const allSurfaced = loadSurfacedEvents(pluginData);
  let earliestMs = Infinity;
  const perPath = new Map();
  for (const e of allSurfaced) {
    const t = new Date(e.ts).getTime();
    if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
    if (!Number.isFinite(t) || t < sinceMs || t > now) continue;
    const cur = perPath.get(e.path) || {
      path: e.path,
      surfaced: 0,
      last_surfaced: e.ts,
      via: [],
    };
    cur.surfaced++;
    if (e.ts > cur.last_surfaced) cur.last_surfaced = e.ts;
    if (!cur.via.includes(e.via)) cur.via.push(e.via);
    perPath.set(e.path, cur);
  }

  const usage = loadNoteUsageEvents(pluginData);
  const usedByPath = new Map();
  const ignoredByPath = new Map();
  for (const u of usage) {
    const m = u.status === 'used' ? usedByPath : ignoredByPath;
    m.set(u.path, (m.get(u.path) || 0) + 1);
  }

  const surfacedNeverUsed = [...perPath.values()]
    .filter((n) => n.surfaced >= minSurfaced && !usedByPath.has(n.path))
    .map((n) => ({ ...n, ignored_events: ignoredByPath.get(n.path) || 0 }))
    .sort((a, b) => b.surfaced - a.surfaced || a.path.localeCompare(b.path));

  let neverSurfaced = [];
  if (Array.isArray(vaultNotes)) {
    neverSurfaced = vaultNotes.filter((p) => !perPath.has(p)).sort();
  }

  const coverageDays = Number.isFinite(earliestMs)
    ? Math.min(windowDays, Math.ceil((now - earliestMs) / DAY_MS))
    : null;

  return {
    window_days: windowDays,
    coverage_days: coverageDays,
    coverage_limited: coverageDays !== null && coverageDays < windowDays,
    used_events: usage.filter((u) => u.status === 'used').length,
    ignored_events: usage.filter((u) => u.status === 'ignored').length,
    evaluated_notes: new Set(usage.map((u) => u.path)).size,
    surfaced_notes: perPath.size,
    surfaced_never_used: surfacedNeverUsed,
    never_surfaced: neverSurfaced,
  };
}
