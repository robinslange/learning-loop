// hooks/session-start/vault-snapshot.mjs : federation backfill, session ID
// stamping, and stale-marker TTL sweeps.

import { writeFileSync, existsSync, readdirSync, lstatSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { DATA_PATHS, FEDERATION_PATHS } from '../../scripts/lib/paths.mjs';
import { getSessionId } from '../../scripts/lib/session.mjs';
import { readMarker, writeMarker, MARKER_PATHS } from '../../scripts/lib/marker-cache.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { monthStr } from '../../scripts/lib/retrieval.mjs';

// Sweep at most once per 24h regardless of session cadence.
const SWEEP_GATE_MS = 24 * 60 * 60 * 1000;

export async function run(ctx) {
  // Federation seed-meta backfill (one-shot for existing federations).
  if (ctx.pluginData) {
    try {
      const seedConfigPath = FEDERATION_PATHS.config(ctx.pluginData);
      const seedMetaPath = FEDERATION_PATHS.seedMeta(ctx.pluginData);
      const noticePath = FEDERATION_PATHS.seedNoticeShown(ctx.pluginData);

      if (existsSync(seedConfigPath) && !existsSync(seedMetaPath)) {
        writeFileSync(
          seedMetaPath,
          JSON.stringify(
            {
              created_at: new Date().toISOString(),
              plugin_version: ctx.pluginVersion,
              plugin_major: parseInt(ctx.pluginVersion.split('.')[0], 10),
              backfilled: true,
            },
            null,
            2,
          ),
        );
      }
      if (existsSync(seedMetaPath) && !existsSync(noticePath)) {
        const { value: meta } = safeLoad(seedMetaPath, { fallback: null });
        if (meta) {
          const currentMajor = parseInt(ctx.pluginVersion.split('.')[0], 10);
          if (meta.plugin_major !== currentMajor) {
            process.stderr.write(
              `learning-loop federation: seed created on plugin v${meta.plugin_version} (current: v${ctx.pluginVersion}). Run /learning-loop:federation to rotate.\n`,
            );
            writeFileSync(noticePath, new Date().toISOString());
          }
        }
      }
    } catch (err) {
      logError('session-start.vault-snapshot.federation', err);
    }
  }

  // Session id preference: hook payload → $CLAUDE_CODE_SESSION_ID → persisted
  // marker (getSessionId covers both) → randomBytes only as terminal fallback
  // for bare hosts. The payload id is what stop-nudge keys its snapshot diff
  // on (M4) — a fabricated id makes that diff permanently dead.
  const resolved = getSessionId();
  const sessionId =
    ctx.payloadSessionId ||
    (resolved !== 'unknown' ? resolved : '') ||
    randomBytes(4).toString('hex');
  ctx.sessionId = sessionId;

  // Session ID — single env-independent stamp in plugin-data. getSessionId()
  // reads the unsuffixed `id` (after the harness var) from any subprocess. We
  // also one-shot sweep any stale id-<ppid> files left by older versions: those
  // accumulated forever and a stale one shadowed the real id, re-splitting the
  // /reflect handshake. Removing them lets existing installs self-heal.
  if (ctx.pluginData) {
    try {
      const sessionDir = DATA_PATHS.session(ctx.pluginData);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'id'), sessionId);
      for (const name of readdirSync(sessionDir)) {
        if (/^id-\d+$/.test(name)) rmSync(join(sessionDir, name), { force: true });
      }
    } catch (err) {
      logError('session-start.vault-snapshot.writeSessionIdPluginData', err);
    }
  }

  // Session ID legacy tmp file (fallback for the resolver; retained for
  // compat). LL_SESSION_TMP_DIR mirrors the read-side seam in
  // scripts/lib/session.mjs so tests never touch the machine-global file.
  try {
    const sessionTmp = (env.LL_SESSION_TMP_DIR || '').trim() || ctx.tmp;
    writeFileSync(join(sessionTmp, 'learning-loop-session-id'), sessionId);
  } catch (err) {
    logError('session-start.vault-snapshot.writeSessionId', err);
  }

  // TTL sweeps. One pass, five targets:
  //   (a) retrieval/session-dedupe + markers/ entries older than 7 days
  //       (memory-writes-<sid> accumulates one file per session, as did the
  //       now-removed memory-snapshot-<sid> — both reaped here);
  //   (b) edges.db.<pid>.tmp orphans (crash between saveDb's write and
  //       rename) older than 1 hour;
  //   (c) tmp per-session/legacy markers older than 7 days — stop-nudged
  //       transcript-dedupe, session-label files, and the pre-v1.27 tmp
  //       marker names that nothing reads anymore. NEVER the live
  //       learning-loop-session-id fallback;
  //   (d) librarian/queue.jsonl.bak.* backups older than 7 days;
  //   (e) retrieval/<prefix>-YYYY-MM.jsonl logs beyond the newest
  //       RETRIEVAL_LOG_KEEP_MONTHS per prefix (current month always kept).
  //       provenance/ is untouched — its consumers read full history.
  function sweepDir(dir, match, cutoffMs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of names) {
      if (!match(f)) continue;
      const full = join(dir, f);
      try {
        const st = lstatSync(full);
        if (st.isFile() && st.mtimeMs < cutoffMs) rmSync(full, { force: true });
      } catch (err) {
        if (err?.code !== 'ENOENT') logError('session-start.vault-snapshot.ttlSweep', err);
      }
    }
  }

  // retrieval/<prefix>-YYYY-MM.jsonl retention: keep only the newest
  // RETRIEVAL_LOG_KEEP_MONTHS months per prefix. Grouping and cutoff are both
  // derived from the filename's YYYY-MM suffix — never from mtime or file
  // content — because a month bucket is written to (and its mtime bumped)
  // all month long; mtime can't tell a live current-month file from a stale
  // one. YYYY-MM sorts lexically = chronologically, so string comparison is
  // enough. The current month is always kept, even if the prefix has fewer
  // than RETRIEVAL_LOG_KEEP_MONTHS files. provenance/ is a different
  // directory entirely and this function never touches it.
  function sweepRetrievalLogs(dir, keepMonths) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const currentMonth = monthStr();
    const byPrefix = new Map();
    const re = /^(.+)-(\d{4}-\d{2})\.jsonl$/;
    for (const f of names) {
      const m = re.exec(f);
      if (!m) continue;
      const [, prefix, month] = m;
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push({ file: f, month });
    }
    for (const entries of byPrefix.values()) {
      const months = [...new Set(entries.map((e) => e.month))].sort();
      const keep = new Set(months.slice(-keepMonths));
      keep.add(currentMonth);
      for (const { file, month } of entries) {
        if (keep.has(month)) continue;
        try {
          rmSync(join(dir, file), { force: true });
        } catch (err) {
          if (err?.code !== 'ENOENT') logError('session-start.vault-snapshot.retrievalLogSweep', err);
        }
      }
    }
  }

  // Once per day, not per session. The reaped targets are reaped by mtime, and
  // every read side already filters stale entries by mtime — so deferring the
  // rm pass changes nothing a consumer can observe, it only spares each session
  // a stat-walk over the dedupe/marker dirs that usually deletes nothing. The
  // edges.db tmp-orphan TTL widens from 1h to ≤24h as a side effect; those
  // orphans are tiny crash artifacts, so the looser bound is harmless.
  const sweepMarker = ctx.pluginData ? MARKER_PATHS.lastSweep(ctx.pluginData) : null;
  const sweptToday = sweepMarker && readMarker(sweepMarker, { ttlMs: SWEEP_GATE_MS }) !== null;
  if (!sweptToday) {
    const weekCutoff = Date.now() - HookConfig.SESSION_SWEEP_TTL_MS;
    if (ctx.pluginData) {
      sweepDir(DATA_PATHS.retrievalSessionDedupe(ctx.pluginData), () => true, weekCutoff);
      sweepDir(DATA_PATHS.markers(ctx.pluginData), () => true, weekCutoff);
      sweepDir(
        ctx.pluginData,
        (f) => /^edges\.db\..+\.tmp$/.test(f),
        Date.now() - HookConfig.EDGES_TMP_ORPHAN_TTL_MS,
      );
      sweepDir(
        DATA_PATHS.librarian(ctx.pluginData),
        (f) => /^queue\.jsonl\.bak\..+$/.test(f),
        Date.now() - HookConfig.LIBRARIAN_QUEUE_BAK_TTL_MS,
      );
      sweepRetrievalLogs(DATA_PATHS.retrieval(ctx.pluginData), HookConfig.RETRIEVAL_LOG_KEEP_MONTHS);
    }
    const TMP_SWEEP_PATTERNS = [
      /^learning-loop-stop-nudged-/,
      /^claude-session-label-.+\.txt$/,
      /^learning-loop-memory-snapshot/,
      /^learning-loop-session-start-/,
      /^learning-loop-last-dream$/,
      /^learning-loop-last-reflect$/,
      /^learning-loop-dream-nudged$/,
      /^learning-loop-dream-lock$/,
    ];
    sweepDir(ctx.tmp, (f) => TMP_SWEEP_PATTERNS.some((re) => re.test(f)), weekCutoff);
    if (sweepMarker) writeMarker(sweepMarker, { ts: new Date().toISOString() });
  }
}
