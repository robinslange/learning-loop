#!/usr/bin/env node
// Learning Loop: Stop + SessionEnd hook.
// Writes the session ledger: one 4-projects note per session, overwritten on
// every flush, and a throttled session-summary provenance record. Never prints.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPayload, emitProvenance } from './lib/common.mjs';
import { env, coerceNumber } from '../scripts/lib/env.mjs';
import { sessionIdFrom } from '../scripts/lib/session.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { readMarker, writeMarker, MARKER_PATHS } from '../scripts/lib/marker-cache.mjs';
import { withLock } from '../scripts/lib/file-lock.mjs';
import { harness } from '../scripts/lib/harness.mjs';
import { pluginVersion } from '../scripts/lib/plugin-meta.mjs';
import { parseTranscript, walkTranscript } from '../scripts/lib/transcript-walk.mjs';
import {
  execGit,
  budgetedGit,
  resolveProject,
  gitFacts,
  collectFacts,
  summarise,
  renderLedger,
  ledgerPath,
  shouldWrite,
  shouldEmitSummary,
  localDateStr,
} from '../scripts/lib/session-ledger.mjs';
import { getVaultPath, getConfig, getPluginData } from '../scripts/lib/config.mjs';
import { writeFileAtomic } from '../scripts/lib/write-atomic.mjs';

const STALE_TMP_MS = 60 * 60 * 1000;

// If Claude Code kills the hook between writeFileSync(tmp) and renameSync,
// the temp file is orphaned: indexers skip it (not .md) and nothing else
// reaps it. Sweep it out at the next flush instead, one dir at a time so a
// single unreadable/unremovable entry costs one logged failure, not the rest
// of the sweep.
function sweepStaleTmp(dir, now = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code !== 'ENOENT') logError('session-ledger.sweepTmp.readdir', err, { dir });
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= STALE_TMP_MS) continue;
      unlinkSync(path);
    } catch (err) {
      logError('session-ledger.sweepTmp', err, { path });
    }
  }
}

const t0 = Date.now();
const hookData = await readPayload('session-ledger');
if (!hookData) process.exit(0);
if (hookData.stop_hook_active) process.exit(0);

const isSessionEnd = hookData.hook_event_name === 'SessionEnd';
const sessionId = sessionIdFrom(hookData);
if (!sessionId) process.exit(0);

const vaultRoot = getVaultPath();
const pluginData = getPluginData();
if (!vaultRoot || !pluginData || !existsSync(join(vaultRoot, '4-projects'))) process.exit(0);
const config = getConfig() || {};
const cwd = typeof hookData.cwd === 'string' && hookData.cwd ? hookData.cwd : null;
if (!cwd) process.exit(0);

// 1. Transcript. A failure here still leaves git facts to write from.
let walk = walkTranscript([]);
let transcriptBytes = 0;
if (hookData.transcript_path) {
  try {
    transcriptBytes = statSync(hookData.transcript_path).size;
    if (transcriptBytes <= HookConfig.LEDGER_TRANSCRIPT_MAX_BYTES) {
      walk = walkTranscript(parseTranscript(readFileSync(hookData.transcript_path, 'utf8')));
    }
  } catch (err) {
    logError('session-ledger.transcript', err);
  }
}

// 2. Marker: pins the filename and the --since anchor across flushes.
const markerPath = MARKER_PATHS.ledger(pluginData, sessionId);
const marker = readMarker(markerPath, { ttlMs: Infinity });
// No marker and no transcript timestamp: anchor ten minutes before process
// start rather than "now". An unreadable transcript must not make every
// session look brand new to `git log --since`, or it would always be trivial.
const startedTs =
  marker?.started_ts ||
  walk.firstTs ||
  new Date(t0 - HookConfig.LEDGER_SINCE_FALLBACK_MS).toISOString();

// 3. Project + git.
let project = { project: 'unknown', source: 'cwd', repoRoot: null, worktreeRoot: null };
let git = {
  branch: null,
  commits: [],
  dirtyCount: 0,
  state: 'not_repo',
  gitMs: 0,
  head: null,
  commitsSource: 'since',
};
try {
  const seam = coerceNumber(env.LL_LEDGER_GIT_BUDGET_MS, 0);
  const gitBudget = { remaining: seam || HookConfig.LEDGER_GIT_BUDGET_MS };
  const gitTimeoutMs = seam || HookConfig.LEDGER_GIT_TIMEOUT_MS;
  const budgeted = budgetedGit(execGit, gitBudget);
  project = resolveProject(cwd, config, budgeted, gitTimeoutMs);
  git = gitFacts(project.worktreeRoot, startedTs, budgeted, gitTimeoutMs, {
    startedHead: marker?.started_head,
  });
} catch (err) {
  logError('session-ledger.git', err);
}

// 4. Facts + summary.
const facts = collectFacts(walk, {
  worktreeRoot: project.worktreeRoot,
  cwd,
  vaultRoot,
  lastAssistantMessage: isSessionEnd ? null : hookData.last_assistant_message,
});
const summary = summarise({
  walk,
  git,
  facts,
  isSessionEnd,
  reason: hookData.reason,
  projectSource: project.source,
  harness: harness(),
  version: pluginVersion(),
  latencyMs: Date.now() - t0,
  transcriptBytes,
});
if (!shouldWrite(summary, HookConfig.LEDGER_MIN_PROMPTS)) process.exit(0);

// 5. Label + date: independent of the marker, always the current transcript.
let label = null;
try {
  label =
    readFileSync(join(tmpdir(), `claude-session-label-${sessionId}.txt`), 'utf8').trim() || null;
} catch (err) {
  if (err?.code !== 'ENOENT') logError('session-ledger.label', err);
}
const date = localDateStr(startedTs);

// 6. Pin the marker under the lock, first-writer-wins: the second of two
// racing flushes must adopt whatever the first one already committed
// (path, started_ts, started_head), not clobber it with its own
// independently-computed values. The note is written AFTER the lock
// resolves the pin, at pin.path, so a losing flush's note lands where the
// winner's marker says it should.
//
// mkdir happens before the lock: withLock's O_EXCL lockfile create fails if
// markers/ doesn't exist yet, which it may not on a fresh install.
mkdirSync(dirname(markerPath), { recursive: true });

// Own computation, used only if no marker has claimed the pin yet.
const computed = {
  path: ledgerPath(project.project, date, label, sessionId),
  started_ts: startedTs,
  started_head: git.head || null,
};

let pin;
let latest;
try {
  withLock(markerPath, { retries: 10, retryDelayMs: 40 }, () => {
    latest = readMarker(markerPath, { ttlMs: Infinity });
    pin = latest?.path
      ? {
          path: latest.path,
          started_ts: latest.started_ts,
          started_head: latest.started_head ?? computed.started_head,
        }
      : computed;
  });
} catch (err) {
  logError('session-ledger.lock', err);
  // Lost the lock: fall back to the unlocked read so a busy marker never
  // costs the session its pin, only (at worst) a race with the true winner.
  latest = marker;
  pin = latest?.path
    ? {
        path: latest.path,
        started_ts: latest.started_ts,
        started_head: latest.started_head ?? computed.started_head,
      }
    : computed;
}

// 7. Note, written at the pinned path.
let wrote = false;
try {
  const abs = join(vaultRoot, pin.path);
  mkdirSync(dirname(abs), { recursive: true });
  sweepStaleTmp(dirname(abs));
  writeFileAtomic(
    abs,
    renderLedger({
      project: project.project,
      label,
      date,
      sessionId,
      repoRoot: project.repoRoot,
      git,
      facts,
      isSessionEnd,
      reason: hookData.reason,
      summary,
      harness: summary.harness,
      // Only "fell back" if a PRIOR flush already had a started_head to
      // range from and git still landed on --since; pin.started_head alone
      // is always truthy on this session's first flush (computed just now
      // from git.head) and would wrongly read as a fallback.
      rangeFellBack: Boolean(latest?.started_head) && git.commitsSource === 'since',
    }),
  );
  wrote = true;
} catch (err) {
  logError('session-ledger.write', err);
}

// 7. Summary event, throttled. A note that failed to write still gets its
// numbers recorded; that failure is already counted in the error log.
//
// Stop and SessionEnd for one session can fire close together and interleave
// their read-modify-write of the marker, so the throttle decision and the
// write it produces run under one lock -- re-reading the marker fresh inside
// it, the same shape appendMemoryWrite (marker-cache.mjs) uses. Retries/delay
// keep the worst-case wait under 500ms: the note write already happened above
// and is not part of this critical section, so contention here is brief.
let emitNow;
try {
  withLock(markerPath, { retries: 10, retryDelayMs: 40 }, () => {
    const fresh = readMarker(markerPath, { ttlMs: Infinity });
    emitNow = shouldEmitSummary(
      fresh,
      Date.now(),
      isSessionEnd,
      HookConfig.SESSION_SUMMARY_MIN_INTERVAL_MS,
    );
    // The pin is persisted unconditionally: it was resolved first-writer-wins
    // under the lock above, and a flush whose note write failed before the
    // throttle was due used to leave it unwritten, so the next flush
    // recomputed its own and the two could diverge. Only last_summary_ts is
    // gated on the throttle decision.
    writeMarker(markerPath, {
      path: pin.path,
      started_ts: pin.started_ts,
      started_head: pin.started_head,
      last_summary_ts: emitNow ? new Date().toISOString() : (fresh?.last_summary_ts ?? null),
    });
  });
} catch (err) {
  logError('session-ledger.lock', err);
  // Lost the lock: fall back to the unlocked decision so a busy marker never
  // costs the session its ledger, only (at worst) a duplicate throttle tick.
  emitNow = shouldEmitSummary(
    latest,
    Date.now(),
    isSessionEnd,
    HookConfig.SESSION_SUMMARY_MIN_INTERVAL_MS,
  );
  writeMarker(markerPath, {
    path: pin.path,
    started_ts: pin.started_ts,
    started_head: pin.started_head,
    last_summary_ts: emitNow ? new Date().toISOString() : (latest?.last_summary_ts ?? null),
  });
}
if (emitNow) {
  try {
    emitProvenance({ ...summary, latency_ms: Date.now() - t0, session_id: sessionId });
  } catch (err) {
    logError('session-ledger.emit', err);
  }
}
if (wrote) {
  writeMarker(MARKER_PATHS.ledgerProject(pluginData, env.CLAUDE_PROJECT_DIR || cwd), {
    project: project.project,
  });
}
process.exit(0);
