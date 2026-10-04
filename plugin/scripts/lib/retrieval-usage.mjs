// scripts/lib/retrieval-usage.mjs — connect "note was surfaced" to "note was used".
//
// Surfacing sources (PLUGIN_DATA/retrieval/):
//   - queries-*.jsonl            vault-search top_paths   → via: 'retrieved'
//                                (internal pipeline commands like the /reflect
//                                Step 2.5 reflect-scan are EXCLUDED — they are
//                                the pipeline querying itself, not retrieval
//                                surfaced to a session)
//   - injections-*.jsonl         durable injection ledger → via: 'injected'
//                                (written by syncInjectionLedger below)
//   - session-dedupe/<sid>.json  injected vault notes     → via: 'injected'
//   - shadow-injection-*.jsonl   live-mode gate-pass-payload records
//                                → via: 'injected' (mode:'live' only; shadow-
//                                mode records never reached the model)
// Use source (PLUGIN_DATA/provenance/events-*.jsonl):
//   - action === 'note-usage'    emitted by /reflect Step 4.7 with
//     status 'used' | 'ignored' per surfaced note.
//
// Honesty contract: a note only counts as USED when an explicit 'used' event
// exists. Surfacing alone — including a full note body injected into context —
// is never use, because injection deciding a note is relevant cannot also be
// the evidence that it was. Sessions that never ran the /reflect usage check
// contribute no events; their surfaced notes stay UNEVALUATED, which is not
// the same bucket as ignored and must never be reported as one.
//
// Two ways a session can use a note, tracked apart because they carry
// different evidence:
//   engaged   read | edited | linked — the session acted on the note.
//   informed  the note's content reached the session's output without the
//             note being touched. This is the read-only path a second brain
//             is FOR, so excluding it scored the primary success mode as
//             failure. It is judged against a different input than surfacing
//             (the output text, not the retrieval rank), which is what keeps
//             it independent — but only if it stays auditable, so an
//             'informed' event MUST carry a non-empty `evidence` string
//             naming the claim and where it landed. Unevidenced 'informed'
//             is dropped entirely: it is not use, and it is not evidence of
//             non-use either.
//
// Injection coverage: the injection hook persists only ephemeral dedupe
// state (entries older than ~3 minutes are pruned on every write; whole
// files are swept after 7 days). syncInjectionLedger copies whatever dedupe
// state still exists into an append-only monthly injections-*.jsonl ledger,
// so observed bursts survive the prune plus sweep, but bursts that came and
// went between ledger syncs would be lost from that path alone. Every live
// injection is ALSO durably recorded the moment it happens on
// shadow-injection-*.jsonl (mode: 'live', type: 'gate-pass-payload'), which
// is never pruned, so readShadowLiveInjections below closes that gap: the
// injected channel is complete for live sessions, not merely a lower bound.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_PATHS } from './paths.mjs';
import { appendJsonlLine, readJsonlDir } from './jsonl.mjs';
import { logError } from './log.mjs';
import { HookConfig } from './hook-config.mjs';
import { monthStr } from './retrieval.mjs';

const DAY_MS = 86_400_000;

// queries-*.jsonl commands that are the pipeline talking to itself: surfacing
// them would let internal scans manufacture surfaced/ignored telemetry.
const INTERNAL_QUERY_COMMANDS = new Set(['reflect-scan']);

function listFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isVaultNotePath(p) {
  return typeof p === 'string' && p.endsWith('.md') && !p.startsWith('peer:');
}

function injectionKey(sid, path, ts) {
  return `${sid}\u0000${path}\u0000${ts}`;
}

function readDedupeInjections(pluginData) {
  const out = [];
  const dedupeDir = DATA_PATHS.retrievalSessionDedupe(pluginData);
  for (const f of listFiles(dedupeDir)) {
    if (!f.endsWith('.json')) continue;
    const sid = f.slice(0, -'.json'.length);
    let entries;
    try {
      entries = JSON.parse(readFileSync(join(dedupeDir, f), 'utf-8'));
      // eslint-disable-next-line learning-loop/no-empty-catch -- unreadable or corrupt dedupe state; skip this session.
    } catch {}
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!isVaultNotePath(e?.path)) continue;
      out.push({
        path: e.path,
        ts: e.ts,
        session_id: sid,
        via: 'injected',
        level: e.level === 'pointer' ? 'pointer' : 'body',
      });
    }
  }
  return out;
}

function readLedgerInjections(pluginData) {
  const retrievalDir = DATA_PATHS.retrieval(pluginData);
  const out = [];
  for (const rec of readJsonlDir(retrievalDir, 'injections-')) {
    if (!isVaultNotePath(rec?.path)) continue;
    out.push({
      path: rec.path,
      ts: rec.ts,
      session_id: rec.session_id,
      via: 'injected',
      level: rec.level === 'pointer' ? 'pointer' : 'body',
    });
  }
  return out;
}

// shadow-injection-*.jsonl is written on EVERY prompt, shadow mode or live,
// and is never pruned -- unlike the ledger above, which only carries whatever
// ephemeral dedupe state survived to the next syncInjectionLedger() call. A
// mode:'live' gate-pass-payload record is exactly what session-label.js just
// put in front of the model (buildInjection's post-dedupe injectedVault), so
// it is a durable, complete record of live injections from the moment they
// happen. A mode:'shadow' record never reached the model and must be
// excluded, or a shadow-only session would read as surfaced.
function readShadowLiveInjections(pluginData) {
  const retrievalDir = DATA_PATHS.retrieval(pluginData);
  const out = [];
  for (const rec of readJsonlDir(retrievalDir, 'shadow-injection-')) {
    if (rec?.mode !== 'live' || rec?.type !== 'gate-pass-payload') continue;
    for (const p of rec.payload?.injected_paths || []) {
      if (!isVaultNotePath(p?.path)) continue;
      out.push({
        path: p.path,
        ts: rec.ts,
        session_id: rec.session_id,
        via: 'injected',
        level: p.level === 'pointer' ? 'pointer' : 'body',
      });
    }
  }
  return out;
}

/**
 * Copy injection events still visible in the ephemeral session-dedupe state
 * into the durable, append-only injections-YYYY-MM.jsonl ledger. The dedupe
 * state is pruned to a ~3-minute window on every hook write and swept after
 * 7 days, so this sync is the only thing that makes injection surfacing
 * survive into the report window. Run it on every report/reflect entry point;
 * it is idempotent (records are keyed by session_id + path + ts).
 *
 * Coverage stays partial by construction: bursts that were pruned before any
 * sync ran are unrecoverable. Report labels must carry that caveat.
 *
 * @returns {number} count of newly persisted injection events.
 */
export function syncInjectionLedger(pluginData) {
  if (!pluginData) return 0;
  try {
    const retrievalDir = DATA_PATHS.retrieval(pluginData);
    const seen = new Set();
    for (const rec of readJsonlDir(retrievalDir, 'injections-')) {
      seen.add(injectionKey(rec.session_id, rec.path, rec.ts));
    }
    let appended = 0;
    for (const e of readDedupeInjections(pluginData)) {
      const key = injectionKey(e.session_id, e.path, e.ts);
      if (seen.has(key)) continue;
      seen.add(key);
      const month = monthStr(new Date(Date.parse(e.ts) || Date.now()));
      appendJsonlLine(join(retrievalDir, `injections-${month}.jsonl`), {
        ts: e.ts,
        session_id: e.session_id,
        path: e.path,
        via: 'injected',
        level: e.level,
      });
      appended++;
    }
    return appended;
  } catch (err) {
    logError('retrieval-usage.syncInjectionLedger', err);
    return 0;
  }
}

/**
 * Every surfacing event across the telemetry, flattened to one record per
 * (note, event): { path, ts, session_id, via: 'retrieved'|'injected', level? }.
 * Internal pipeline queries (reflect-scan) are excluded, since they would let
 * /reflect manufacture surfacing events for whatever resembles new captures.
 * Injected events merge the durable ledger, any not-yet-synced dedupe state,
 * and live-mode shadow-injection records (the fullest source: written on
 * every turn, never pruned), deduplicated per (session, path) within the
 * hook's dedupe window.
 */
export function loadSurfacedEvents(pluginData) {
  if (!pluginData) return [];
  const events = [];

  const retrievalDir = DATA_PATHS.retrieval(pluginData);
  for (const rec of readJsonlDir(retrievalDir, 'queries-')) {
    if (INTERNAL_QUERY_COMMANDS.has(rec.command)) continue;
    for (const p of rec.top_paths || []) {
      if (!isVaultNotePath(p)) continue;
      events.push({ path: p, ts: rec.ts, session_id: rec.session_id, via: 'retrieved' });
    }
  }

  // The hook never re-injects a path inside DEDUPE_WINDOW_MS of the same
  // session, so two injected records for one (session, path) closer than that
  // are one injection seen by two writers. Before the writers shared a
  // timestamp they sat a few ms apart, and those rows are never pruned, so an
  // exact-ts key would double count all of them.
  const lastInjected = new Map();
  const injectedSources = [
    ...readLedgerInjections(pluginData),
    ...readDedupeInjections(pluginData),
    ...readShadowLiveInjections(pluginData),
  ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const e of injectedSources) {
    const key = `${e.session_id}\u0000${e.path}`;
    const t = Date.parse(e.ts);
    if (t - lastInjected.get(key) < HookConfig.DEDUPE_WINDOW_MS) continue;
    lastInjected.set(key, t);
    events.push(e);
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

// Signals that mean the session acted ON the note.
const ENGAGED_SIGNALS = new Set(['read', 'edited', 'linked']);

/**
 * The note path a usage record names. Earlier /reflect runs emitted it as
 * `note`; the field was renamed to `target` and the readers were not. A record
 * whose key is missing fails isVaultNotePath and is skipped, so the rename
 * broke nothing loudly — it dropped every pre-rename event on the floor while
 * the reports kept printing a smaller number with no sign anything was gone.
 * Both readers resolve the path here so a third one cannot miss the alias.
 */
function usagePath(rec) {
  return rec.target ?? rec.note;
}

/**
 * Classify one note-usage record. Returns null when the record carries no
 * usable evidence in either direction (an 'informed' claim with no evidence
 * string) — the caller drops it rather than folding it to 'ignored', because
 * an unauditable claim of use is not proof of non-use.
 */
function classifyUsage(rec) {
  if (rec.status !== 'used') return { status: 'ignored', engagement: null };
  const signals = Array.isArray(rec.signals) ? rec.signals : [];
  if (signals.some((sig) => ENGAGED_SIGNALS.has(sig))) {
    return { status: 'used', engagement: 'engaged' };
  }
  if (signals.includes('informed')) {
    const evidence = typeof rec.evidence === 'string' ? rec.evidence.trim() : '';
    return evidence ? { status: 'used', engagement: 'informed' } : null;
  }
  // Pre-signals emitters wrote status alone; honor the verdict, name the gap.
  return { status: 'used', engagement: 'unspecified' };
}

/**
 * note-usage provenance events:
 * [{ path, status: 'used'|'ignored', engagement, ts, session_id }].
 * `engagement` is 'engaged' | 'informed' | 'unspecified' on used events, null
 * on ignored ones. Any status other than the literal 'used' folds to
 * 'ignored' — the conservative reading when an emitter mislabels. Unevidenced
 * 'informed' events are dropped; loadUnevidencedInformedCount reports how many.
 */
/**
 * Per-memory-file read counts from the reads-*.jsonl telemetry that
 * post-read-retrieval.js emits on every Read of a memory file. This is the
 * usage signal for auto-memory (vault notes have note-usage events instead):
 * /dream's PRUNE and MERGE flagging read it so a heavily-read memory is not
 * archived while a never-read one lingers.
 *
 * PLUGIN_DATA is machine-global while memory dirs are per-project, so a bare
 * filename merges every project's reads. `project` (the encoded project-dir
 * segment the hook stamps) scopes the count. Records written before the stamp
 * existed carry no project and are counted regardless: the ambiguity errs
 * toward "this memory was read", the safe direction for an archive decision,
 * and it ages out of the window as stamped records accumulate.
 * @returns {Map<string, { reads: number, last_read: string }>} keyed by file name
 */
export function memoryReadStats(pluginData, { days = 90, project = null } = {}) {
  const stats = new Map();
  if (!pluginData) return stats;
  const cutoff = Date.now() - days * 86_400_000;
  const retrievalDir = DATA_PATHS.retrieval(pluginData);
  for (const rec of readJsonlDir(retrievalDir, 'reads-')) {
    if (rec.command !== 'memory-read') continue;
    if (project && rec.project && rec.project !== project) continue;
    const file = rec.file || rec.query;
    if (!file) continue;
    const ts = Date.parse(rec.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const cur = stats.get(file) || { reads: 0, last_read: rec.ts };
    cur.reads += 1;
    if (rec.ts > cur.last_read) cur.last_read = rec.ts;
    stats.set(file, cur);
  }
  return stats;
}

// A session can be judged twice for the same note: the Stop-hook probe writes
// mechanical evidence at session end, and /reflect writes a read verdict if
// the user runs it afterwards. Both are legitimate, but they describe ONE
// judgement, and callers that count events rather than pairs would read the
// overlap as twice the use.
//
// Precedence when they disagree is by strength of evidence, not arrival:
// 'informed' outranks 'engaged' because only a reader can produce it and it is
// the signal a second brain exists for, 'engaged' outranks 'unspecified', and
// any 'used' outranks 'ignored' (one channel seeing use is use, whatever
// another channel failed to see).
const ENGAGEMENT_RANK = { informed: 3, engaged: 2, unspecified: 1 };

// `engagement` names the strongest kind, for callers that want one label per
// verdict. `engagements` keeps every kind that was actually observed, because
// the two channels can both be right: a session can read a note AND draw a
// claim out of it, and collapsing that to 'informed' alone understates the
// engaged count while claiming to merge rather than discard. Callers counting
// a specific kind should read `engagements`.
function mergeVerdicts(a, b) {
  if (!a) return b;
  if (a.status !== b.status) {
    // One channel seeing use is use, whatever another channel failed to see.
    // The used side carries the evidence, so it wins whole.
    return a.status === 'used' ? a : b;
  }
  const kinds = new Set([...(a.engagements ?? []), ...(b.engagements ?? [])]);
  const strongest = [...kinds].sort(
    (x, y) => (ENGAGEMENT_RANK[y] ?? 0) - (ENGAGEMENT_RANK[x] ?? 0),
  )[0];
  const primary =
    (ENGAGEMENT_RANK[b.engagement] ?? 0) > (ENGAGEMENT_RANK[a.engagement] ?? 0) ? b : a;
  return {
    ...primary,
    engagement: strongest ?? primary.engagement,
    engagements: [...kinds],
  };
}

// One pass over the provenance stream's note-usage records. `events` are the
// verdicts, merged per (session, note). `unevidenced` are the 'informed'
// claims dropped for carrying no evidence, as [{ path, ts }]: reports surface
// the count so a miscalibrated emitter shows up as a number instead of as
// silently missing use.
function readNoteUsage(pluginData) {
  if (!pluginData) return { events: [], unevidenced: [] };
  const byPair = new Map();
  const unevidenced = [];
  for (const rec of readJsonlDir(DATA_PATHS.provenance(pluginData), 'events-')) {
    const path = usagePath(rec);
    if (rec.action !== 'note-usage' || !isVaultNotePath(path)) continue;
    const verdict = classifyUsage(rec);
    if (!verdict) {
      unevidenced.push({ path, ts: rec.ts });
      continue;
    }
    const event = {
      path,
      status: verdict.status,
      engagement: verdict.engagement,
      engagements: verdict.engagement ? [verdict.engagement] : [],
      ts: rec.ts,
      session_id: rec.session_id,
    };
    const key = `${rec.session_id ?? ''}\u0000${path}`;
    byPair.set(key, mergeVerdicts(byPair.get(key), event));
  }
  return { events: [...byPair.values()], unevidenced };
}

export function loadNoteUsageEvents(pluginData) {
  return readNoteUsage(pluginData).events;
}

export function loadUnevidencedInformed(pluginData) {
  return readNoteUsage(pluginData).unevidenced;
}

/**
 * Aggregate surfacing vs use.
 *
 * @param {string} pluginData
 * @param {object} [opts]
 * @param {number} [opts.now]          Epoch ms anchor (tests inject).
 * @param {number} [opts.windowDays]   Window for BOTH surfacing and usage
 *                                     events (default 90). A 'used' event
 *                                     older than the window no longer shields
 *                                     a note from candidacy.
 * @param {number} [opts.minSurfaced]  Surfacing count needed before a note is
 *                                     considered for candidacy at all.
 * @param {number} [opts.minIgnored]   Explicit 'ignored' verdicts needed to
 *                                     make a surfaced note a deepen/archive
 *                                     candidate. Candidacy is evidence-based:
 *                                     a note nobody ever evaluated is
 *                                     unevaluated, not unused.
 * @param {string[]|null} [opts.vaultNotes] Vault-relative note paths; when
 *                                     given, never_surfaced is computed.
 * @returns {{
 *   window_days: number,
 *   coverage_days: number|null,   // actual telemetry span, capped at window
 *   coverage_limited: boolean,    // true when logs are younger than window
 *   used_events: number, ignored_events: number, evaluated_notes: number, // in-window
 *   used_engaged_events: number, used_informed_events: number, used_unspecified_events: number,
 *   unevidenced_informed_events: number,
 *   min_ignored: number,
 *   surfaced_notes: number,
 *   surfaced_never_used: {path:string,surfaced:number,ignored_events:number,last_surfaced:string,via:string[]}[],
 *   surfaced_unevaluated: {path:string,surfaced:number,last_surfaced:string,via:string[]}[],
 *   never_surfaced: string[],
 * }}
 */
export function usageReport(pluginData, opts = {}) {
  const {
    now = Date.now(),
    windowDays = 90,
    minSurfaced = 3,
    minIgnored = 1,
    vaultNotes = null,
  } = opts;
  const sinceMs = now - windowDays * DAY_MS;
  const inWindow = (ts) => {
    const t = new Date(ts).getTime();
    return Number.isFinite(t) && t >= sinceMs && t <= now;
  };

  const allSurfaced = loadSurfacedEvents(pluginData);
  let earliestMs = Infinity;
  const perPath = new Map();
  for (const e of allSurfaced) {
    const t = new Date(e.ts).getTime();
    if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
    if (!inWindow(e.ts)) continue;
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

  // Usage events share the surfacing window: a 'used' event from outside the
  // window must not shield a note that is surfaced-and-ignored today, and the
  // headline counts are printed under the window label so they must honor it.
  const noteUsage = readNoteUsage(pluginData);
  const usage = noteUsage.events.filter((u) => inWindow(u.ts));
  const usedByPath = new Map();
  const ignoredByPath = new Map();
  for (const u of usage) {
    const m = u.status === 'used' ? usedByPath : ignoredByPath;
    m.set(u.path, (m.get(u.path) || 0) + 1);
  }

  // Candidacy needs positive evidence of non-use. Absence of a 'used' event
  // also describes every note no /reflect session ever judged, and those are
  // the majority — spending that silence as a reason to archive would prune
  // the notes that are working.
  const bySurfacedDesc = (a, b) => b.surfaced - a.surfaced || a.path.localeCompare(b.path);
  const unusedInWindow = [...perPath.values()].filter(
    (n) => n.surfaced >= minSurfaced && !usedByPath.has(n.path),
  );
  const surfacedNeverUsed = unusedInWindow
    .filter((n) => (ignoredByPath.get(n.path) || 0) >= minIgnored)
    .map((n) => ({ ...n, ignored_events: ignoredByPath.get(n.path) || 0 }))
    .sort(bySurfacedDesc);
  const surfacedUnevaluated = unusedInWindow
    .filter((n) => (ignoredByPath.get(n.path) || 0) < minIgnored)
    .sort(bySurfacedDesc);

  let neverSurfaced = [];
  if (Array.isArray(vaultNotes)) {
    neverSurfaced = vaultNotes.filter((p) => !perPath.has(p)).sort();
  }

  const coverageDays = Number.isFinite(earliestMs)
    ? Math.min(windowDays, Math.ceil((now - earliestMs) / DAY_MS))
    : null;

  const used = usage.filter((u) => u.status === 'used');
  // Counts the kinds a verdict actually carries, not just its headline: a
  // session that read a note AND drew a claim from it is both engaged and
  // informed, and counting only the strongest would understate engaged.
  // The totals can therefore exceed used_events, which is correct: they count
  // evidence, not verdicts.
  const countEngagement = (kind) =>
    used.filter((u) => (u.engagements ?? [u.engagement]).includes(kind)).length;
  const unevidenced = noteUsage.unevidenced.filter((e) => inWindow(e.ts));

  return {
    window_days: windowDays,
    coverage_days: coverageDays,
    coverage_limited: coverageDays !== null && coverageDays < windowDays,
    used_events: used.length,
    used_engaged_events: countEngagement('engaged'),
    used_informed_events: countEngagement('informed'),
    used_unspecified_events: countEngagement('unspecified'),
    unevidenced_informed_events: unevidenced.length,
    ignored_events: usage.filter((u) => u.status === 'ignored').length,
    evaluated_notes: new Set(usage.map((u) => u.path)).size,
    min_ignored: minIgnored,
    surfaced_notes: perPath.size,
    surfaced_never_used: surfacedNeverUsed,
    surfaced_unevaluated: surfacedUnevaluated,
    never_surfaced: neverSurfaced,
  };
}
