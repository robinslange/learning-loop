#!/usr/bin/env node
// injection-precision.mjs — did the JIT injector surface notes the session used?
//
// Joins the two halves of the surfacing→use loop at RANK resolution:
//   injected side  retrieval/shadow-injection-*.jsonl, type 'gate-pass-payload'
//                  → payload.injected_paths = [{path, level}] in rank order:
//                    BODY_SLOTS bodies first, then POINTER_SLOTS pointers
//                    (hooks/lib/inject.mjs). WHICH ranks are bodies moves with
//                    the layout, so the slot is read from each row's own
//                    `level` and never inferred from the rank index.
//   used side      provenance/events-*.jsonl, two sources unioned:
//                  · action 'note-usage', status 'used' — the /reflect Step 4.7
//                    signal, model-judged, in two kinds: 'engaged' (read |
//                    edited | linked) and 'informed' (the note's content
//                    reached the session's output untouched, evidence string
//                    required). Read via loadNoteUsageEvents so its honesty
//                    contract carries through: only a literal status:'used'
//                    counts, and unevidenced 'informed' claims are dropped
//                    upstream. hits_by_engagement splits the hits so a
//                    precision number leaning on the read-only signal is
//                    visible instead of assumed.
//                  · action 'vault-edit' | 'vault-write' — a note the session
//                    actually authored/edited, keyed by (session_id, target).
//                    This widens "used" past the /reflect gate: note-usage only
//                    exists for sessions that ran /reflect, but every session
//                    that edits a note emits vault-edit for free. EDITS ONLY, not
//                    reads: a hook-level "vault Read" event can't tell engagement
//                    from pipeline reads (reflect dup-check, deepen, verifier all
//                    issue Read tool calls on notes for system reasons), so
//                    counting reads would manufacture false 'used'. Editing a
//                    note is near-always real engagement; the pipeline reads
//                    notes it checks, it does not edit them.
//
//                  Reach note (measured 2026-07-21): adding the edit source lifts
//                  joinable sessions but adds ~0 hits at current volume — sessions
//                  edit freshly-created notes, rarely a note that was injected to
//                  them. The lift is structural (un-gates the join from /reflect),
//                  not immediate; the plumbing is ready for accumulation.
//
// Join key: (session_id, path). An injected note at rank R is a HIT iff its
// session emitted a 'used' event for that path. Output is precision per rank
// and per level, with the denominators exposed.
//
// Dedup unit: precision counts each distinct (session, path, rank) ONCE, not
// once per burst. A live session re-injects the same handful of notes on every
// prompt (one session here produced 1220 rows from 56 distinct notes), so a
// per-burst denominator just measures how chatty that session was. The question
// is "of the notes surfaced to a session, how many did it use" — a distinct
// surfaced-note question. Rank is part of the key because one note can sit at
// rank 0 in one burst and rank 2 in another; each rank it occupied is a
// distinct banner whose precision we want.
//
// Window: two filters, because time alone does not separate the layouts.
//
// First, records at or after INJECTION_LAYOUT_EPOCH. That is the slot LAYOUT
// epoch, not the gate-calibration one, because every figure this file emits is
// denominated in a payload shape — how many bodies, how many pointers — and
// v2.1.0 changed that shape.
//
// Second, and this is the filter that actually holds: a burst whose shape is
// unreachable under the shipped BODY_SLOTS/POINTER_SLOTS was produced by older
// code and is dropped, whatever its timestamp. The epoch is the install moment,
// and a session already running keeps executing the inject hook it loaded, so
// old-shape bursts arrive AFTER the epoch: one 1-body/4-pointer burst was
// recorded 20 hours past it, 12% of the window at the time.
//
// What this cannot do is certify a burst as new-layout. Under the old layout a
// turn with few body-bearing hits could emit 1 body and 3 pointers, which is
// also reachable now, so such a burst is admitted and is indistinguishable.
// Shape proves old, never new; the epoch bounds how much of that can remain.
//
// TRUST GATE, read before believing any number here: the used side exists ONLY
// for sessions that ran /reflect (Step 4.7 is what emits note-usage). Most
// sessions never do, so the joinable set is a small, self-selected slice of all
// injections. This tool reports its own denominators — distinct sessions, join
// overlap, hit counts — precisely so a starved baseline announces itself instead
// of being read as a precision estimate. A per-rank precision over a handful of
// sessions is a liveness check, not a measurement.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from './lib/config.mjs';
import { DATA_PATHS } from './lib/paths.mjs';
import { INJECTION_LAYOUT_EPOCH } from './lib/hook-config.mjs';
import { BODY_SLOTS, POINTER_SLOTS } from '../hooks/lib/inject.mjs';
import { loadNoteUsageEvents } from './lib/retrieval-usage.mjs';
import { logError } from './lib/log.mjs';
import { isMainModule } from './lib/is-main.mjs';

// Derived from the injector's own constants rather than restated as 5: the
// total has survived the layout change (v2.1.0 traded a pointer for a body) but
// a future change need not, and a hardcoded bound would silently truncate the
// per-rank table instead of growing with the payload.
const MAX_RANK = BODY_SLOTS + POINTER_SLOTS;

function listFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// A burst no version of the shipped injector could have produced. Under the
// current constants a payload holds at most BODY_SLOTS bodies and at most
// POINTER_SLOTS pointers, so exceeding either proves older code wrote it --
// which is how a 1-body/4-pointer burst is caught 20 hours after the layout
// epoch, emitted by a session still running the hook it loaded before the
// upgrade. It is a one-way test: a shape reachable under both layouts says
// nothing, so this removes provable contamination rather than guaranteeing
// purity.
function isForeignLayout(paths) {
  let bodies = 0;
  let pointers = 0;
  for (const e of paths) {
    if (e?.level === 'pointer') pointers++;
    else bodies++;
  }
  return bodies > BODY_SLOTS || pointers > POINTER_SLOTS;
}

// Ranked injection bursts at or after epochMs, one row per injected note:
// { session_id, path, rank, level }. rank is the 0-based position within the
// burst's injected_paths (its retrieval rank order). Returns the rows plus a
// count of bursts rejected as foreign-layout, so a contaminated window reports
// itself instead of quietly averaging two payload shapes together.
function loadRankedInjections(pluginData, epochMs) {
  const dir = DATA_PATHS.retrieval(pluginData);
  const out = [];
  let foreignLayoutBursts = 0;
  for (const f of listFiles(dir)) {
    if (!f.startsWith('shadow-injection-') || !f.endsWith('.jsonl')) continue;
    let raw;
    try {
      raw = readFileSync(join(dir, f), 'utf-8');
    } catch (err) {
      logError('injection-precision.loadRankedInjections', err);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== 'gate-pass-payload') continue;
      const t = Date.parse(rec.ts);
      if (!Number.isFinite(t) || t < epochMs) continue;
      const paths = rec.payload?.injected_paths;
      if (!Array.isArray(paths) || paths.length === 0) continue;
      if (isForeignLayout(paths)) {
        foreignLayoutBursts++;
        continue;
      }
      paths.forEach((e, rank) => {
        if (typeof e?.path !== 'string') return;
        out.push({
          session_id: rec.session_id,
          path: e.path,
          rank,
          level: e.level === 'pointer' ? 'pointer' : 'body',
        });
      });
    }
  }
  return { rows: out, foreignLayoutBursts };
}

// Vault authoring events (a note the session wrote or edited). These live in the
// same provenance stream as note-usage but under different actions, and
// loadNoteUsageEvents filters them out, so read them directly here.
const VAULT_EDIT_ACTIONS = new Set(['vault-edit', 'vault-write']);
function loadVaultEditEvents(pluginData) {
  const dir = DATA_PATHS.provenance(pluginData);
  const out = [];
  for (const f of listFiles(dir)) {
    if (!f.startsWith('events-') || !f.endsWith('.jsonl')) continue;
    let raw;
    try {
      raw = readFileSync(join(dir, f), 'utf-8');
    } catch (err) {
      logError('injection-precision.loadVaultEditEvents', err);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!VAULT_EDIT_ACTIONS.has(rec.action)) continue;
      const path = rec.target;
      if (typeof path !== 'string' || !path.endsWith('.md') || path.startsWith('peer:')) continue;
      out.push({ path, ts: rec.ts, session_id: rec.session_id });
    }
  }
  return out;
}

// (session_id, path) pairs a session USED, at or after epochMs, mapped to the
// engagement kind that earned the pair: 'engaged' | 'informed' | 'unspecified'
// (all from reflect note-usage) or 'vault_edit'. Union of the reflect signal
// and vault authoring (edit/write) events.
// `bySource` keeps the counts separate so a report can show what each channel
// contributed without conflating the reflect-gated and un-gated signals, and
// splits note-usage by engagement so a precision number resting on the
// read-only 'informed' signal is visible as such rather than assumed.
function loadUsedPairs(pluginData, epochMs) {
  const byPair = new Map();
  const sessions = new Set();
  const bySource = {
    note_usage: 0,
    note_usage_engaged: 0,
    note_usage_informed: 0,
    note_usage_unspecified: 0,
    vault_edit: 0,
  };

  const add = (sessionId, path, kind) => {
    const key = `${sessionId} ${path}`;
    if (!byPair.has(key)) {
      if (kind === 'vault_edit') bySource.vault_edit++;
      else {
        bySource.note_usage++;
        bySource[`note_usage_${kind}`]++;
      }
      byPair.set(key, kind);
    }
    sessions.add(sessionId);
  };

  for (const u of loadNoteUsageEvents(pluginData)) {
    if (u.status !== 'used') continue;
    const t = Date.parse(u.ts);
    if (!Number.isFinite(t) || t < epochMs) continue;
    add(u.session_id, u.path, u.engagement || 'unspecified');
  }
  for (const e of loadVaultEditEvents(pluginData)) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < epochMs) continue;
    add(e.session_id, e.path, 'vault_edit');
  }
  return { used: byPair, sessions, bySource };
}

const pct = (hit, total) => (total === 0 ? null : hit / total);

// The slot a rank carried is a property of the rows, not arithmetic on the rank.
// This was `rank === 0 ? 'body' : 'pointer'`, true only while there was exactly
// one body slot; v2.1.0 gave the injector two, so every rank-1 body was reported
// as a pointer — and once the window excludes the old layout entirely, that is
// wrong for the whole table rather than part of it. 'mixed' is what a window
// spanning a layout change looks like from inside.
function slotLabel({ body, pointer }) {
  if (body && pointer) return 'mixed';
  if (body) return 'body';
  if (pointer) return 'pointer';
  return '—';
}

/**
 * Rank-resolved surfaced→used precision over post-epoch telemetry.
 *
 * @param {string} pluginData  plugin-data root.
 * @param {object} [opts]
 * @param {string} [opts.epoch]  ISO epoch; defaults to INJECTION_LAYOUT_EPOCH.
 *   Throws on an unparseable value rather than windowing on NaN, where every
 *   `ts < epochMs` comparison is false and the filter silently admits the whole
 *   history as if it were post-epoch.
 * @returns report object (see the file header + fields below).
 */
export function injectionPrecision(pluginData, opts = {}) {
  const epoch = opts.epoch || INJECTION_LAYOUT_EPOCH;
  const epochMs = Date.parse(epoch);
  if (!Number.isFinite(epochMs)) {
    throw new Error(`epoch is not a parseable timestamp: ${epoch}`);
  }

  const { rows: injections, foreignLayoutBursts } = loadRankedInjections(pluginData, epochMs);
  const { used, sessions: usedSessions, bySource } = loadUsedPairs(pluginData, epochMs);

  // A session can only contribute a hit if it also has usage provenance; without
  // a usage event the whole burst is unjoinable (not "ignored", just unknown).
  const injSessions = new Set(injections.map((i) => i.session_id));
  const joinableSessions = new Set([...injSessions].filter((s) => usedSessions.has(s)));

  // Restrict to joinable sessions, then dedup to one row per (session, path,
  // rank): a session's repeated re-injection of the same note counts once per
  // rank it occupied, not once per burst. Every rank a note reached is its own
  // banner, so all distinct ranks are kept.
  const joinable = [];
  const seen = new Set();
  for (const i of injections) {
    if (!joinableSessions.has(i.session_id)) continue;
    const key = `${i.session_id} ${i.path} ${i.rank}`;
    if (seen.has(key)) continue;
    seen.add(key);
    joinable.push(i);
  }

  const perRank = Array.from({ length: MAX_RANK }, () => ({
    total: 0,
    hit: 0,
    body: 0,
    pointer: 0,
  }));
  const perLevel = { body: { total: 0, hit: 0 }, pointer: { total: 0, hit: 0 } };
  const overall = { total: 0, hit: 0 };
  const hitsByEngagement = { engaged: 0, informed: 0, unspecified: 0, vault_edit: 0 };
  for (const i of joinable) {
    const kind = used.get(`${i.session_id} ${i.path}`);
    const hit = kind ? 1 : 0;
    if (kind) hitsByEngagement[kind]++;
    if (i.rank < MAX_RANK) {
      perRank[i.rank].total++;
      perRank[i.rank].hit += hit;
      perRank[i.rank][i.level]++;
    }
    perLevel[i.level].total++;
    perLevel[i.level].hit += hit;
    overall.total++;
    overall.hit += hit;
  }

  return {
    epoch,
    diagnostics: {
      ranked_injection_bursts_rows: injections.length,
      // Bursts dropped as unreachable under the shipped layout, i.e. written by
      // an older version after the epoch. Non-zero means the window was
      // contaminated and this filter caught it, not that data was lost.
      foreign_layout_bursts_dropped: foreignLayoutBursts,
      injection_sessions: injSessions.size,
      usage_sessions: usedSessions.size,
      used_pairs_by_source: bySource, // note_usage (by engagement) vs vault_edit
      hits_by_engagement: hitsByEngagement, // what kind of evidence each hit rests on
      joinable_sessions: joinableSessions.size,
      joinable_distinct_surfaced: joinable.length,
      total_hits: overall.hit,
    },
    overall: { ...overall, precision: pct(overall.hit, overall.total) },
    per_rank: perRank.map((r, rank) => ({
      rank,
      slot: slotLabel(r),
      body: r.body,
      pointer: r.pointer,
      total: r.total,
      hit: r.hit,
      precision: pct(r.hit, r.total),
    })),
    per_level: ['body', 'pointer'].map((lvl) => ({
      level: lvl,
      total: perLevel[lvl].total,
      hit: perLevel[lvl].hit,
      precision: pct(perLevel[lvl].hit, perLevel[lvl].total),
    })),
  };
}

function fmtPct(p) {
  return p === null ? '  —  ' : `${(p * 100).toFixed(0).padStart(3)}%`;
}

function printReport(report) {
  const d = report.diagnostics;
  console.log('Injection precision (rank-resolved surfaced→used join)');
  console.log('='.repeat(60));
  console.log(`  Epoch:                 ${report.epoch}`);
  console.log(
    `  Injection bursts:      ${d.ranked_injection_bursts_rows} rows  (${d.injection_sessions} sessions)`,
  );
  if (d.foreign_layout_bursts_dropped > 0) {
    console.log(
      `  Foreign-layout bursts: ${d.foreign_layout_bursts_dropped} dropped  (older code writing after the epoch)`,
    );
  }
  console.log(`  Sessions w/ usage:     ${d.usage_sessions}`);
  const src = d.used_pairs_by_source;
  console.log(
    `  Used pairs by source:  note-usage ${src.note_usage} (${src.note_usage_engaged} engaged, ${src.note_usage_informed} informed, ${src.note_usage_unspecified} unspecified), vault-edit ${src.vault_edit}`,
  );
  const h = d.hits_by_engagement;
  console.log(
    `  Hits by evidence:      ${h.engaged} engaged, ${h.informed} informed, ${h.unspecified} unspecified, ${h.vault_edit} vault-edit`,
  );
  console.log(
    `  Joinable sessions:     ${d.joinable_sessions}  (${d.joinable_distinct_surfaced} distinct surfaced, ${d.total_hits} hits)`,
  );
  console.log();

  if (d.joinable_sessions === 0 || d.joinable_distinct_surfaced === 0) {
    console.log('  JOIN EMPTY — no session has both a ranked injection burst and a');
    console.log('  note-usage event post-epoch. The instrument is wired but starved;');
    console.log('  precision is unmeasurable until more sessions run /reflect.');
    return;
  }

  if (d.joinable_sessions < 5) {
    console.log(`  ⚠ THIN SAMPLE: ${d.joinable_sessions} joinable session(s). Treat the`);
    console.log('  numbers below as a liveness check, not a baseline. Let post-epoch');
    console.log('  telemetry accumulate across more /reflect sessions before trusting.');
    console.log();
  }

  console.log(
    `  Overall: ${fmtPct(report.overall.precision)}  (${report.overall.hit}/${report.overall.total})`,
  );
  console.log();
  console.log('  By rank:');
  for (const r of report.per_rank) {
    console.log(
      `    rank ${r.rank} (${r.slot.padEnd(7)}) ${fmtPct(r.precision)}  (${r.hit}/${r.total})`,
    );
  }
  console.log();
  console.log('  By level:');
  for (const l of report.per_level) {
    console.log(`    ${l.level.padEnd(8)} ${fmtPct(l.precision)}  (${l.hit}/${l.total})`);
  }
  // This table is NOT an effect size for the format, and has been misread once
  // already as evidence that a body converts ~3.75x better than a pointer. Its
  // two rows are different notes: the ranker hands its best candidate to a body
  // slot, so bodies outscore pointers here even where format contributes
  // nothing. The comparison that isolates format is within-note — the notes that
  // appeared at BOTH levels on different turns, each compared against itself.
  // That measurement lives with the change it justified, in the BODY_SLOTS
  // comment in `hooks/lib/inject.mjs`, rather than being restated here as frozen
  // prose beside a table this script recomputes every run.
  console.log();
  console.log('  Note: by-level is confounded by rank. See the comment above');
  console.log('  this line before quoting it as a format effect.');
}

// CLI entry — thin: resolve plugin-data, compute, print.
//
// `--epoch <iso>` exists because the default window is deliberately narrow, and
// without an override an earlier window is unreachable from the command line:
// the function has always taken one, the CLI just never exposed it.
//
// It moves the TIME bound only. The foreign-layout filter still applies, so
// passing the calibration epoch does not reproduce the old pooled-layout
// numbers -- measured over that window it drops 131 bursts and reports the
// shape-compatible subset instead. Pooling two payload shapes is the thing this
// file exists to refuse, so there is deliberately no flag to switch that off.
if (isMainModule(import.meta.url)) {
  const PD = getPluginData();
  if (!PD) {
    console.error('injection-precision: no plugin-data dir resolved.');
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const epochFlag = argv.indexOf('--epoch');
  if (epochFlag !== -1 && !argv[epochFlag + 1]) {
    console.error('injection-precision: --epoch needs an ISO timestamp');
    process.exit(2);
  }
  let report;
  try {
    report = injectionPrecision(PD, epochFlag === -1 ? {} : { epoch: argv[epochFlag + 1] });
  } catch (err) {
    console.error(`injection-precision: ${err.message}`);
    process.exit(2);
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}
