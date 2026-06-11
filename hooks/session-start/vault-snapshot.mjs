// hooks/session-start/vault-snapshot.mjs : federation backfill, session ID
// stamping, memory snapshot, and session-dedupe TTL sweep.

import { writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
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

  // TTL sweep for session-dedupe files older than SESSION_DEDUPE_TTL_MS.
  if (ctx.pluginData) {
    try {
      const dedupeDir = DATA_PATHS.retrievalSessionDedupe(ctx.pluginData);
      if (existsSync(dedupeDir)) {
        const cutoff = Date.now() - HookConfig.SESSION_DEDUPE_TTL_MS;
        for (const f of readdirSync(dedupeDir)) {
          const full = join(dedupeDir, f);
          try {
            if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
          } catch (err) {
            logError('session-start.vault-snapshot.dedupeSwept', err);
          }
        }
      }
    } catch (err) {
      logError('session-start.vault-snapshot.dedupeSweep', err);
    }
  }
}
