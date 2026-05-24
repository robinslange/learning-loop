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

  // Session ID stamping.
  const sessionId = randomBytes(4).toString('hex');
  ctx.sessionId = sessionId;
  const ppid = process.ppid;
  try {
    writeFileSync(
      join(ctx.tmp, `learning-loop-session-start-${sessionId}`),
      String(Math.floor(Date.now() / 1000)),
    );
  } catch (err) {
    logError('session-start.vault-snapshot.writeSessionStart', err);
  }

  if (ctx.projectDir) {
    const encodedPath = ctx.projectDir.replace(/[/\\]/g, '-');
    const memDir = join(ctx.memoryDir, encodedPath, 'memory');
    try {
      const files = readdirSync(memDir).filter((f) => f.endsWith('.md'));
      writeFileSync(
        join(ctx.tmp, `learning-loop-memory-snapshot-${sessionId}`),
        JSON.stringify(files),
      );
      if (ctx.pluginData) {
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

  // Session ID legacy files.
  try {
    writeFileSync(join(ctx.tmp, `learning-loop-session-id-${ppid}`), sessionId);
    writeFileSync(join(ctx.tmp, 'learning-loop-session-id'), sessionId);
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
