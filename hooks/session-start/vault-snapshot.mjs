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

  // Session ID stamping. Prefer the harness session id ($CLAUDE_CODE_SESSION_ID)
  // — it is identical across every process in the session (this hook, the
  // post-tool hook, the skill's bash, sub-agents) and independent of $TMPDIR and
  // process.ppid, so getSessionId() resolves the same value on both sides of the
  // /reflect Step-4 marker handshake. randomBytes is only a fallback for hosts
  // that don't export the var (bare CLI/test). We write a single unsuffixed file
  // per location — NO id-<ppid>: ppid is not a session key, differs per process,
  // and stale per-ppid files accumulate and shadow the real id.
  const harnessSid = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  const sessionId = harnessSid || randomBytes(4).toString('hex');
  ctx.sessionId = sessionId;
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

  // Session ID legacy tmp file (fallback for the resolver; retained for compat).
  try {
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
