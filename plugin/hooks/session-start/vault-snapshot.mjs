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

  // TTL sweeps. One pass, three targets:
  //   (a) retrieval/session-dedupe + markers/ entries older than 7 days
  //       (memory-writes-<sid> accumulates one file per session, as did the
  //       now-removed memory-snapshot-<sid> — both reaped here);
  //   (b) edges.db.<pid>.tmp orphans (crash between saveDb's write and
  //       rename) older than 1 hour;
  //   (c) tmp per-session/legacy markers older than 7 days — stop-nudged
  //       transcript-dedupe, session-label files, and the pre-v1.27 tmp
  //       marker names that nothing reads anymore. NEVER the live
  //       learning-loop-session-id fallback.
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
