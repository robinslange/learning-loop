#!/usr/bin/env node
// hooks/session-start.js : SessionStart dispatcher.
//
// All real work delegated to ./session-start/*.mjs. Submodules consume ctx
// and mutate it in place; failures are logged and isolated per submodule.

import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warnOnce } from '../scripts/lib/warn-once.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { safeLoad } from '../scripts/lib/safe-load.mjs';
import { env } from '../scripts/lib/env.mjs';
import {
  resolvePluginData,
  resolveVaultPath,
  findEpisodicBinary,
  home,
  readStdin,
} from './lib/common.mjs';
import { emitJson } from './lib/io.mjs';

import { run as runCacheCleanup } from './session-start/cache-cleanup.mjs';
import { run as runUpdateCheck } from './session-start/update-check.mjs';
import { run as runHealthDetector } from './session-start/health-detector.mjs';
import { run as runVaultSnapshot } from './session-start/vault-snapshot.mjs';
import { run as runContextAssembly } from './session-start/context-assembly.mjs';
import { run as runWatchDaemon } from './session-start/watch-daemon.mjs';

const PLUGIN_DIR = resolve(import.meta.dirname, '..');

const pluginData = resolvePluginData();
const updateCacheFile = pluginData ? join(pluginData, 'update-check.json') : null;

const ctx = {
  pluginDir: PLUGIN_DIR,
  pluginVersion:
    safeLoad(`${PLUGIN_DIR}/package.json`, { fallback: { version: '0.0.0' } }).value?.version ||
    '0.0.0',
  pluginData,
  vaultRoot: resolveVaultPath(),
  projectDir: env.CLAUDE_PROJECT_DIR,
  memoryDir: `${home()}/.claude/projects`,
  // Resolve tmp the same way the canonical readers do: bare tmpdir()
  // (scripts/lib/session.mjs:getSessionId and hooks/stop-nudge.js both use
  // `const tmp = tmpdir()`). vault-snapshot.mjs writes learning-loop-session-id
  // under ctx.tmp; that is read only by other hook subprocesses, which — like
  // this one — don't inherit the interactive shell's $TMPDIR, so all agree on
  // /tmp. (The /reflect marker handshake, whose reader IS the interactive
  // shell, is anchored in plugin-data instead of tmp for exactly this reason —
  // see hooks/modules/reflect-track.mjs.)
  tmp: tmpdir(),
  context: '',
  depsAllSatisfied: true,
  depsMissing: '',
  updateCacheFile,
  sessionId: null,
  payloadSessionId: '',
};

// SessionStart payload: the harness writes { session_id, source, ... } on
// stdin. The payload id is the canonical session key (M4) — prefer it over
// $CLAUDE_CODE_SESSION_ID, which is absent in some hosts.
try {
  const raw = await readStdin();
  if (raw.trim()) {
    const payload = JSON.parse(raw);
    if (payload && typeof payload.session_id === 'string') {
      ctx.payloadSessionId = payload.session_id.trim();
    }
  }
} catch (err) {
  logError('session-start.payload', err);
}

// Order matters: cache-cleanup before update-check (uses cache parent).
await runCacheCleanup(ctx);
await runUpdateCheck(ctx);

// No vault → emit empty and bail (matches 0D 'no vault' test).
if (!ctx.vaultRoot) {
  emitJson({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' } });
  process.exit(0);
}

await runHealthDetector(ctx);
await runVaultSnapshot(ctx);
await runWatchDaemon(ctx);
await runContextAssembly(ctx);

// Episodic pre-warm — kept inline: three lines, no cross-submodule dep.
try {
  const epBin = findEpisodicBinary();
  if (epBin) {
    const { spawn } = await import('node:child_process');
    const child = spawn(epBin, ['search', '--vector', '--limit', '1', 'warmup'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else {
    warnOnce(
      'episodic-unavailable',
      'learning-loop: episodic-memory unavailable; semantic recall disabled. Install via `claude plugin install episodic-memory@superpowers-marketplace` for full functionality.\n',
    );
  }
} catch (err) {
  logError('session-start.episodic-prewarm', err);
}

emitJson({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.context },
});
