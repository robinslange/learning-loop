// hooks/session-start/vault-snapshot.mjs : federation backfill, session ID
// stamping, memory snapshot, and stale-marker TTL sweeps.

import { writeFileSync, existsSync, readdirSync, lstatSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendJsonlLine } from '../../scripts/lib/jsonl.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { DATA_PATHS, FEDERATION_PATHS } from '../../scripts/lib/paths.mjs';
import { getSessionId } from '../../scripts/lib/session.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { writeMarker, MARKER_PATHS } from '../../scripts/lib/marker-cache.mjs';

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

  if (ctx.projectDir) {
    const encodedPath = ctx.projectDir.replace(/[/\\]/g, '-');
    const memDir = join(ctx.memoryDir, encodedPath, 'memory');
    try {
      const files = readdirSync(memDir).filter((f) => f.endsWith('.md'));
      if (ctx.pluginData) {
        writeMarker(MARKER_PATHS.memorySnapshot(ctx.pluginData, sessionId), files);
        const retrievalDir = DATA_PATHS.retrieval(ctx.pluginData);
        mkdirSync(retrievalDir, { recursive: true });
        const entry = {
          ts: new Date().toISOString(),
          session_id: sessionId,
          memories: files,
        };
        appendJsonlLine(
          join(retrievalDir, `access-${new Date().toISOString().slice(0, 7)}.jsonl`),
          entry,
        );
      }
    } catch (err) {
      logError('session-start.vault-snapshot.memorySnapshot', err);
    }
  }

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
  //       (memory-snapshot-<sid> accumulates one file per session);
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

  const weekCutoff = Date.now() - HookConfig.SESSION_DEDUPE_TTL_MS;
  if (ctx.pluginData) {
    sweepDir(DATA_PATHS.retrievalSessionDedupe(ctx.pluginData), () => true, weekCutoff);
    sweepDir(DATA_PATHS.markers(ctx.pluginData), () => true, weekCutoff);
    sweepDir(ctx.pluginData, (f) => /^edges\.db\..+\.tmp$/.test(f), Date.now() - 3_600_000);
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
}
