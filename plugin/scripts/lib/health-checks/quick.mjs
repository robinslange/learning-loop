// Quick health checks: file existence, version reads, no shell-outs.
// Each function takes its inputs explicitly (for testability) and never throws.

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from './types.mjs';
import { DATA_FILES } from '../paths.mjs';
import { semverCmp, isPlainSemver } from '../semver.mjs';
import { INJECTION_CALIBRATION_EPOCH } from '../hook-config.mjs';
import { recentMonths } from '../retrieval.mjs';
import {
  isVaultOk,
  isEpisodicOk,
  isHealthy,
  isGatePassed,
  SHADOW_BACKEND_HEALTH_MIN_RATE,
  SHADOW_BACKEND_HEALTH_MIN_TOTAL,
} from '../shadow-gate.mjs';

// Re-exported from the writer that owns the naming. The scan basis must match
// the filenames, which monthStr() builds in LOCAL time; computing these in UTC
// made the reader miss the current month's file for the first hours of every
// month east of UTC. Kept as a named export here for the existing callers.
export { recentMonths };

const VAULT_FOLDERS = [
  '0-inbox',
  '1-fleeting',
  '2-literature',
  '3-permanent',
  '4-projects',
  '5-maps',
  '_system',
];

export function checkVaultPath({ vaultRoot } = {}) {
  if (!vaultRoot) {
    return makeCheck({
      id: CHECK_IDS['vault-path'],
      name: 'Vault path',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'not configured',
      fix: 'Run /learning-loop:init to set your vault path',
    });
  }
  if (!existsSync(vaultRoot)) {
    return makeCheck({
      id: CHECK_IDS['vault-path'],
      name: 'Vault path',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `directory missing: ${vaultRoot}`,
      fix: 'Restore the vault directory or run /learning-loop:init to pick a new path',
    });
  }
  return makeCheck({
    id: CHECK_IDS['vault-path'],
    name: 'Vault path',
    status: SEVERITIES.ok,
    severity: SEVERITIES.fail,
    detail: vaultRoot,
    fix: null,
  });
}

export function checkVaultFolders({ vaultRoot } = {}) {
  if (!vaultRoot || !existsSync(vaultRoot)) {
    return makeCheck({
      id: CHECK_IDS['vault-folders'],
      name: 'Vault folders',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'vault path not available',
      fix: 'Fix vault-path first',
    });
  }
  const missing = VAULT_FOLDERS.filter((f) => !existsSync(join(vaultRoot, f)));
  if (missing.length === 0) {
    return makeCheck({
      id: CHECK_IDS['vault-folders'],
      name: 'Vault folders',
      status: SEVERITIES.ok,
      severity: SEVERITIES.fail,
      detail: '7/7 present',
      fix: null,
    });
  }
  return makeCheck({
    id: CHECK_IDS['vault-folders'],
    name: 'Vault folders',
    status: SEVERITIES.fail,
    severity: SEVERITIES.fail,
    detail: `missing: ${missing.join(', ')}`,
    fix: `Run /learning-loop:init to create missing folders: ${missing.join(', ')}`,
  });
}

export function checkVaultSystemFiles({ vaultRoot } = {}) {
  if (!vaultRoot || !existsSync(vaultRoot)) {
    return makeCheck({
      id: CHECK_IDS['vault-system-files'],
      name: 'Vault system files',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'vault path not available',
      fix: 'Fix vault-path first',
    });
  }
  const missing = [];
  for (const f of ['_system/persona.md', '_system/capture-rules.md']) {
    if (!existsSync(join(vaultRoot, f))) missing.push(f);
  }
  if (missing.length === 0) {
    return makeCheck({
      id: CHECK_IDS['vault-system-files'],
      name: 'Vault system files',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'persona + capture rules present',
      fix: null,
    });
  }
  return makeCheck({
    id: CHECK_IDS['vault-system-files'],
    name: 'Vault system files',
    status: SEVERITIES.fail,
    severity: SEVERITIES.warn,
    detail: `missing: ${missing.join(', ')}`,
    fix: 'Run /learning-loop:init Phase 2c to restore system file defaults',
  });
}

export function checkBinaryExists({ pluginData } = {}) {
  if (!pluginData) {
    return makeCheck({
      id: CHECK_IDS['binary-exists'],
      name: 'll-search binary',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'plugin-data path not resolved',
      fix: 'Run /learning-loop:init to download the binary',
    });
  }
  const binPath = join(pluginData, 'bin', 'll-search');
  if (!existsSync(binPath)) {
    return makeCheck({
      id: CHECK_IDS['binary-exists'],
      name: 'll-search binary',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `missing at ${binPath}`,
      fix: 'Run /learning-loop:init to re-download the binary',
    });
  }
  try {
    const stat = statSync(binPath);
    if (!(stat.mode & 0o111)) {
      return makeCheck({
        id: CHECK_IDS['binary-exists'],
        name: 'll-search binary',
        status: SEVERITIES.fail,
        severity: SEVERITIES.fail,
        detail: 'not executable',
        fix: `chmod +x ${binPath}`,
      });
    }
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['binary-exists'],
      name: 'll-search binary',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `stat error: ${err.message}`,
      fix: 'Run /learning-loop:init to re-download',
    });
  }
  return makeCheck({
    id: CHECK_IDS['binary-exists'],
    name: 'll-search binary',
    status: SEVERITIES.ok,
    severity: SEVERITIES.fail,
    detail: binPath,
    fix: null,
  });
}

function stripV(s) {
  return typeof s === 'string' && s.startsWith('v') ? s.slice(1) : s;
}

export function checkBinaryVersionFile({ pluginData, pluginVersion } = {}) {
  if (!pluginData) {
    return makeCheck({
      id: CHECK_IDS['binary-version-file'],
      name: 'Binary version file',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'plugin-data not resolved',
      fix: 'Fix plugin-data resolution first',
    });
  }
  const verPath = DATA_FILES.binVersion(pluginData);
  if (!existsSync(verPath)) {
    return makeCheck({
      id: CHECK_IDS['binary-version-file'],
      name: 'Binary version file',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'missing',
      fix: 'Run /learning-loop:init to re-download (writes .version)',
    });
  }
  try {
    const version = readFileSync(verPath, 'utf-8').trim();
    // A readable .version that lags the running plugin version means the
    // session-start binary auto-update is stuck (download failing silently).
    const installed = stripV(version);
    const running = stripV(pluginVersion || '');
    if (isPlainSemver(installed) && isPlainSemver(running) && semverCmp(installed, running) < 0) {
      return makeCheck({
        id: CHECK_IDS['binary-version-file'],
        name: 'Binary version file',
        status: SEVERITIES.fail,
        severity: SEVERITIES.warn,
        detail: `binary v${installed} behind plugin v${running} — auto-update may be stuck`,
        fix: 'Run node PLUGIN/scripts/download-binary.mjs manually and check network access',
      });
    }
    return makeCheck({
      id: CHECK_IDS['binary-version-file'],
      name: 'Binary version file',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: version,
      fix: null,
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['binary-version-file'],
      name: 'Binary version file',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `read error: ${err.message}`,
      fix: 'Run /learning-loop:init to repair',
    });
  }
}

export function checkShimsExist({ home } = {}) {
  if (!home) {
    return makeCheck({
      id: CHECK_IDS['shims-exist'],
      name: 'CLI shims',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'HOME not set',
      fix: 'Set $HOME',
    });
  }
  const missing = [];
  for (const s of ['ll-watch', 'll-search']) {
    const p = join(home, '.local/bin', s);
    if (!existsSync(p)) {
      missing.push(s);
      continue;
    }
    try {
      const stat = statSync(p);
      if (!(stat.mode & 0o111)) missing.push(`${s} (not executable)`);
    } catch {
      missing.push(`${s} (stat error)`);
    }
  }
  if (missing.length === 0) {
    return makeCheck({
      id: CHECK_IDS['shims-exist'],
      name: 'CLI shims',
      status: SEVERITIES.ok,
      severity: SEVERITIES.fail,
      detail: 'll-watch + ll-search ready',
      fix: null,
    });
  }
  return makeCheck({
    id: CHECK_IDS['shims-exist'],
    name: 'CLI shims',
    status: SEVERITIES.fail,
    severity: SEVERITIES.fail,
    detail: `missing: ${missing.join(', ')}`,
    fix: 'Run node PLUGIN/scripts/install-shims.mjs --install',
  });
}

export function checkLocalBinOnPath({ home, pathEnv } = {}) {
  if (!home) {
    return makeCheck({
      id: CHECK_IDS['local-bin-on-path'],
      name: '~/.local/bin on PATH',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'HOME not set',
      fix: 'Set $HOME',
    });
  }
  const target = `${home}/.local/bin`;
  const segments = (pathEnv || '').split(':');
  if (segments.includes(target)) {
    return makeCheck({
      id: CHECK_IDS['local-bin-on-path'],
      name: '~/.local/bin on PATH',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: target,
      fix: null,
    });
  }
  return makeCheck({
    id: CHECK_IDS['local-bin-on-path'],
    name: '~/.local/bin on PATH',
    status: SEVERITIES.fail,
    severity: SEVERITIES.warn,
    detail: 'not on PATH',
    fix: 'Add to your shell rc: export PATH="$HOME/.local/bin:$PATH"',
  });
}

const CLAUDEMD_MARKER_RE = /<!--\s*learning-loop\s+v(\d+)\s*-->/;

export function checkClaudemdSectionPresent({ home } = {}) {
  if (!home) {
    return makeCheck({
      id: CHECK_IDS['claudemd-section-present'],
      name: 'CLAUDE.md section',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'HOME not set',
      fix: 'Set $HOME',
    });
  }
  const p = join(home, '.claude/CLAUDE.md');
  if (!existsSync(p)) {
    return makeCheck({
      id: CHECK_IDS['claudemd-section-present'],
      name: 'CLAUDE.md section',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: '~/.claude/CLAUDE.md not found',
      fix: 'Run /learning-loop:init Phase 5 to install',
    });
  }
  try {
    const body = readFileSync(p, 'utf-8');
    if (CLAUDEMD_MARKER_RE.test(body)) {
      return makeCheck({
        id: CHECK_IDS['claudemd-section-present'],
        name: 'CLAUDE.md section',
        status: SEVERITIES.ok,
        severity: SEVERITIES.warn,
        detail: 'marker found',
        fix: null,
      });
    }
    return makeCheck({
      id: CHECK_IDS['claudemd-section-present'],
      name: 'CLAUDE.md section',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'marker missing',
      fix: 'Run /learning-loop:init Phase 5 to install the learning-loop section',
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['claudemd-section-present'],
      name: 'CLAUDE.md section',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `read error: ${err.message}`,
      fix: 'Check ~/.claude/CLAUDE.md permissions',
    });
  }
}

export function checkClaudemdSectionCurrent({ home, templateVersion } = {}) {
  if (!home || !templateVersion) {
    return makeCheck({
      id: CHECK_IDS['claudemd-section-current'],
      name: 'CLAUDE.md section version',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'missing inputs',
      fix: 'Internal: check caller resolved templateVersion',
    });
  }
  const p = join(home, '.claude/CLAUDE.md');
  if (!existsSync(p)) {
    return makeCheck({
      id: CHECK_IDS['claudemd-section-current'],
      name: 'CLAUDE.md section version',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'CLAUDE.md missing',
      fix: 'Run /learning-loop:init Phase 5',
    });
  }
  try {
    const body = readFileSync(p, 'utf-8');
    const m = CLAUDEMD_MARKER_RE.exec(body);
    if (!m) {
      return makeCheck({
        id: CHECK_IDS['claudemd-section-current'],
        name: 'CLAUDE.md section version',
        status: SEVERITIES.fail,
        severity: SEVERITIES.warn,
        detail: 'marker missing',
        fix: 'Run /learning-loop:init Phase 5',
      });
    }
    const installed = m[1];
    if (installed === String(templateVersion)) {
      return makeCheck({
        id: CHECK_IDS['claudemd-section-current'],
        name: 'CLAUDE.md section version',
        status: SEVERITIES.ok,
        severity: SEVERITIES.warn,
        detail: `v${installed}`,
        fix: null,
      });
    }
    return makeCheck({
      id: CHECK_IDS['claudemd-section-current'],
      name: 'CLAUDE.md section version',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `installed v${installed}, template v${templateVersion}`,
      fix: 'Run /learning-loop:init Phase 5 to update the section',
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['claudemd-section-current'],
      name: 'CLAUDE.md section version',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `read error: ${err.message}`,
      fix: 'Check CLAUDE.md permissions',
    });
  }
}

export function checkInstalledPluginsReadable({ home } = {}) {
  if (!home) {
    return makeCheck({
      id: CHECK_IDS['installed-plugins-readable'],
      name: 'Plugin registry',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'HOME not set',
      fix: 'Set $HOME',
    });
  }
  const p = join(home, '.claude/plugins/installed_plugins.json');
  if (!existsSync(p)) {
    return makeCheck({
      id: CHECK_IDS['installed-plugins-readable'],
      name: 'Plugin registry',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'installed_plugins.json not found',
      fix: 'Claude Code may not have run yet; launch Claude Code once and try again',
    });
  }
  try {
    JSON.parse(readFileSync(p, 'utf-8'));
    return makeCheck({
      id: CHECK_IDS['installed-plugins-readable'],
      name: 'Plugin registry',
      status: SEVERITIES.ok,
      severity: SEVERITIES.fail,
      detail: p,
      fix: null,
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['installed-plugins-readable'],
      name: 'Plugin registry',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `parse error: ${err.message}`,
      fix: 'Inspect ~/.claude/plugins/installed_plugins.json for corruption',
    });
  }
}

export function checkPluginCacheVersionPresent({ home, installedVersion } = {}) {
  if (!home || !installedVersion) {
    return makeCheck({
      id: CHECK_IDS['plugin-cache-version-present'],
      name: 'Plugin cache directory',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'missing inputs',
      fix: 'Internal: caller should pass installedVersion',
    });
  }
  const verDir = join(
    home,
    '.claude/plugins/cache/learning-loop-marketplace/learning-loop',
    installedVersion,
  );
  if (!existsSync(verDir)) {
    return makeCheck({
      id: CHECK_IDS['plugin-cache-version-present'],
      name: 'Plugin cache directory',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `missing: ${verDir}`,
      fix: `Run: claude plugin install learning-loop@learning-loop-marketplace`,
    });
  }
  return makeCheck({
    id: CHECK_IDS['plugin-cache-version-present'],
    name: 'Plugin cache directory',
    status: SEVERITIES.ok,
    severity: SEVERITIES.fail,
    detail: verDir,
    fix: null,
  });
}

export function checkSearchIndexExists({ vaultRoot } = {}) {
  if (!vaultRoot) {
    return makeCheck({
      id: CHECK_IDS['search-index-exists'],
      name: 'Search index',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'vault path not available',
      fix: 'Fix vault-path first',
    });
  }
  const p = join(vaultRoot, '.vault-search/vault-index.db');
  if (!existsSync(p)) {
    return makeCheck({
      id: CHECK_IDS['search-index-exists'],
      name: 'Search index',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'no index — run vault-search.mjs index to build',
      fix: 'Run: node PLUGIN/scripts/vault-search.mjs index',
    });
  }
  try {
    const stat = statSync(p);
    if (stat.size === 0) {
      return makeCheck({
        id: CHECK_IDS['search-index-exists'],
        name: 'Search index',
        status: SEVERITIES.fail,
        severity: SEVERITIES.warn,
        detail: 'index file is empty',
        fix: 'Run: node PLUGIN/scripts/vault-search.mjs index',
      });
    }
    return makeCheck({
      id: CHECK_IDS['search-index-exists'],
      name: 'Search index',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: `${Math.round(stat.size / 1024)} KB`,
      fix: null,
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['search-index-exists'],
      name: 'Search index',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `stat error: ${err.message}`,
      fix: 'Run: node PLUGIN/scripts/vault-search.mjs index',
    });
  }
}

export function checkNliSocketFresh({ pluginData } = {}) {
  if (!pluginData) {
    return makeCheck({
      id: CHECK_IDS['nli-socket-fresh'],
      name: 'Duplicate-scan socket',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'plugin-data not available — skipped',
      fix: null,
    });
  }
  const p = DATA_FILES.nliSocket(pluginData);
  if (!existsSync(p)) {
    return makeCheck({
      id: CHECK_IDS['nli-socket-fresh'],
      name: 'Duplicate-scan socket',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'not running (no socket file)',
      fix: null,
    });
  }
  try {
    const stat = statSync(p);
    if (!stat.isSocket()) {
      return makeCheck({
        id: CHECK_IDS['nli-socket-fresh'],
        name: 'Duplicate-scan socket',
        status: SEVERITIES.fail,
        severity: SEVERITIES.warn,
        detail: 'stale (file at socket path is not a socket)',
        fix: `rm ${p} and restart ll-watch`,
      });
    }
    return makeCheck({
      id: CHECK_IDS['nli-socket-fresh'],
      name: 'Duplicate-scan socket',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: p,
      fix: null,
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['nli-socket-fresh'],
      name: 'Duplicate-scan socket',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `stat error: ${err.message}`,
      fix: `Inspect ${p}`,
    });
  }
}

// How many duplicate-gate timeouts in the scanned window count as "the gate is
// permanently disabled on this machine" rather than a one-off slow write.
const DUPLICATE_GATE_TIMEOUT_WARN_THRESHOLD = 3;

// Count duplicate-gate-timeout and duplicate-gate-stale-daemon entries in a
// single monthly hook-errors jsonl. Returns separate counts so the check can
// give targeted fix advice — including how many timeouts came from the daemon
// socket, which is what tells "no daemon" apart from "daemon too slow".
// Tolerant of partial/corrupt lines (best-effort diagnostic, never throws).
function countDuplicateGateIssues(path) {
  const empty = { timeouts: 0, daemonTimeouts: 0, staleDaemon: 0 };
  if (!existsSync(path)) return empty;
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return empty;
  }
  let timeouts = 0;
  let daemonTimeouts = 0;
  let staleDaemon = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.code === 'duplicate-gate-timeout') {
        timeouts++;
        if (obj?.source === 'daemon') daemonTimeouts++;
      } else if (obj?.code === 'duplicate-gate-stale-daemon') staleDaemon++;
    } catch {
      // Skip a corrupt line — keep counting the rest.
    }
  }
  return { timeouts, daemonTimeouts, staleDaemon };
}

// Warn when recent hook-errors logs show repeated duplicate-gate timeouts or a
// stale daemon. The pre-write duplicate gate fails OPEN on timeout (silent
// pass), so a slow machine can permanently lose the gate with nothing surfaced
// but log lines. A stale daemon binary (which lacks duplicate-scan support)
// pays the round-trip + cold subprocess on every vault Write indefinitely.
// Scans the current + previous UTC month files (`hook-errors-YYYY-MM.jsonl`),
// the same naming pre-write-check.js writes.
export function checkDuplicateGateHealth({ pluginData, now = new Date() } = {}) {
  if (!pluginData) {
    return makeCheck({
      id: CHECK_IDS['duplicate-gate-health'],
      name: 'Duplicate gate',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'plugin-data not available — skipped',
      fix: null,
    });
  }
  const months = recentMonths(now);
  let totalTimeouts = 0;
  let totalDaemonTimeouts = 0;
  let totalStaleDaemon = 0;
  for (const month of months) {
    const { timeouts, daemonTimeouts, staleDaemon } = countDuplicateGateIssues(
      join(pluginData, `hook-errors-${month}.jsonl`),
    );
    totalTimeouts += timeouts;
    totalDaemonTimeouts += daemonTimeouts;
    totalStaleDaemon += staleDaemon;
  }
  if (totalStaleDaemon > 0) {
    return makeCheck({
      id: CHECK_IDS['duplicate-gate-health'],
      name: 'Duplicate gate',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `stale daemon binary: ${totalStaleDaemon} stale-daemon error(s) in recent logs — the duplicate gate is paying cold-start on every vault write`,
      fix: 'Restart the watch daemon to pick up the new binary: kill the current ll-watch, then ll-watch',
    });
  }
  if (totalTimeouts >= DUPLICATE_GATE_TIMEOUT_WARN_THRESHOLD) {
    // A timeout logged against source 'daemon' proves the socket was there and a
    // live daemon accepted the connection — it just answered too slowly. Advising
    // a start would send the user to fix a daemon that is already running.
    const daemonIsUp = totalDaemonTimeouts > 0;
    return makeCheck({
      id: CHECK_IDS['duplicate-gate-health'],
      name: 'Duplicate gate',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: daemonIsUp
        ? `${totalTimeouts} duplicate-gate timeouts in recent logs (${totalDaemonTimeouts} from the daemon socket) — the daemon is running but too slow to answer inside the write budget, so the gate is silently disabled on writes`
        : `${totalTimeouts} duplicate-gate timeouts in recent logs — the gate is silently disabled on writes`,
      fix: daemonIsUp
        ? 'The daemon is up but slow — usually because it is mid-reindex. Check ll-watch status and whether a reindex is in flight; the gate falls open until it settles.'
        : 'Start the warm daemon (ll-watch) so the gate uses the socket instead of cold-starting the model: ll-watch',
    });
  }
  return makeCheck({
    id: CHECK_IDS['duplicate-gate-health'],
    name: 'Duplicate gate',
    status: SEVERITIES.ok,
    severity: SEVERITIES.warn,
    detail:
      totalTimeouts === 0
        ? 'no recent timeouts'
        : `${totalTimeouts} recent timeout(s) (under threshold)`,
    fix: null,
  });
}

// --- General hook-error summary ---
// Counts every well-formed JSON line in the hook-errors monthly logs (all
// error events, regardless of code) and surfaces the most recent one. Distinct
// from checkDuplicateGateHealth which counts only specific gate-failure codes.
const HOOK_ERROR_WARN_THRESHOLD = 5;

function readHookErrorLines(path) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const result = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      result.push(JSON.parse(line));
    } catch {
      // Skip corrupt line — keep counting the rest.
    }
  }
  return result;
}

export function checkHookErrors({ pluginData, now = new Date() } = {}) {
  if (!pluginData) {
    return makeCheck({
      id: CHECK_IDS['hook-errors'],
      name: 'Hook errors',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'plugin-data not available — skipped',
      fix: null,
    });
  }
  const months = recentMonths(now);
  let totalCount = 0;
  let latest = null;
  for (const month of months) {
    const lines = readHookErrorLines(join(pluginData, `hook-errors-${month}.jsonl`));
    totalCount += lines.length;
    for (const obj of lines) {
      if (!latest || !latest.ts || (obj.ts && obj.ts > latest.ts)) latest = obj;
    }
  }
  if (totalCount > HOOK_ERROR_WARN_THRESHOLD) {
    const latestSummary = latest
      ? `${latest.module ?? 'unknown'} @ ${latest.ts ?? '?'} — ${String(latest.message ?? '').slice(0, 80)}`
      : 'unknown';
    return makeCheck({
      id: CHECK_IDS['hook-errors'],
      name: 'Hook errors',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `${totalCount} hook errors in the last 2 months; latest: ${latestSummary}`,
      fix: `Check ~/.claude/plugins/data/.../hook-errors-*.jsonl to identify which hook/module is failing`,
    });
  }
  return makeCheck({
    id: CHECK_IDS['hook-errors'],
    name: 'Hook errors',
    status: SEVERITIES.ok,
    severity: SEVERITIES.warn,
    detail:
      totalCount === 0 ? 'no hook errors logged' : `${totalCount} hook error(s) (under threshold)`,
    fix: null,
  });
}

// --- Injection shadow gate (injection_mode flip readiness) ---
// Mirrors the go/no-go verdict in scripts/review-shadow.mjs: with >=100
// healthy shadow evaluations, >=20 gate passes, and a >=5% healthy pass rate,
// the shadow data supports flipping injection_mode from shadow to live. This
// check only surfaces readiness — the flip itself stays consent-gated behind
// /learning-loop:doctor and is never applied automatically.
const SHADOW_GATE_MIN_HEALTHY = 100;
const SHADOW_GATE_MIN_PASSED = 20;
const SHADOW_GATE_MIN_PASS_RATE = 0.05;

// Shadow logs grow to tens of MB per month (each entry embeds the payload it
// would have injected); the session-start detector runs quick checks under a
// tight time budget, so read only the tail of each month file. 2MB covers
// hundreds of recent entries — far more than the gate criteria need.
const SHADOW_LOG_TAIL_BYTES = 2 * 1024 * 1024;

function readTailLines(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Scan the current + previous local month shadow-injection logs (the same naming
// session-label.js writes) and count healthy entries vs gate passes.
// Only counts entries ts >= INJECTION_CALIBRATION_EPOCH so stale-pipeline
// decisions (old threshold / old BM25 mode) don't inflate the ready-to-flip
// signal toward a pipeline those entries never exercised.
function collectShadowGateStats(pluginData, now) {
  const months = recentMonths(now);
  let healthy = 0;
  let passed = 0;
  let vaultOkCount = 0;
  let episodicOkCount = 0;
  let total = 0;
  for (const month of months) {
    const p = join(pluginData, 'retrieval', `shadow-injection-${month}.jsonl`);
    if (!existsSync(p)) continue;
    for (const line of readTailLines(p, SHADOW_LOG_TAIL_BYTES)) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      // Epoch filter: skip entries produced by the old pipeline.
      if (!e?.ts || e.ts < INJECTION_CALIBRATION_EPOCH) continue;
      total++;
      if (isVaultOk(e)) vaultOkCount++;
      if (isEpisodicOk(e)) episodicOkCount++;
      if (!isHealthy(e)) continue;
      healthy++;
      if (isGatePassed(e)) passed++;
    }
  }
  return { healthy, passed, total, vaultOkCount, episodicOkCount };
}

// injectionMode is the PERSISTENT config value (config.json injection_mode,
// default 'shadow') — per-session env overrides deliberately don't count,
// since this check reports on what every future session will do.
// injectionNudge is config.json injection_nudge — set to 'dismissed' by
// /doctor's 'hold in shadow' option to silence the nag after the user has
// reviewed the data and decided not to go live yet.
export function checkInjectionShadowGate({
  pluginData,
  injectionMode,
  injectionNudge,
  now = new Date(),
} = {}) {
  const mode = injectionMode || 'shadow';
  if (mode === 'live') {
    return makeCheck({
      id: CHECK_IDS['injection-shadow-gate'],
      name: 'Injection shadow gate',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'injection_mode live — JIT injection active',
      fix: null,
    });
  }
  if (mode === 'off') {
    return makeCheck({
      id: CHECK_IDS['injection-shadow-gate'],
      name: 'Injection shadow gate',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'injection_mode off — JIT injection disabled by config',
      fix: null,
    });
  }
  if (!pluginData) {
    return makeCheck({
      id: CHECK_IDS['injection-shadow-gate'],
      name: 'Injection shadow gate',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'plugin-data not available — skipped',
      fix: null,
    });
  }
  const { healthy, passed, total, vaultOkCount, episodicOkCount } = collectShadowGateStats(
    pluginData,
    now,
  );
  // INFRASTRUCTURE precondition (mirrors review-shadow.mjs verdict):
  // when backend health is below the floor the surviving entries aren't
  // representative and we must not draw gate conclusions from them.
  const healthyRate = total > 0 ? Math.min(vaultOkCount, episodicOkCount) / total : 1;
  if (total >= SHADOW_BACKEND_HEALTH_MIN_TOTAL && healthyRate < SHADOW_BACKEND_HEALTH_MIN_RATE) {
    return makeCheck({
      id: CHECK_IDS['injection-shadow-gate'],
      name: 'Injection shadow gate',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: `infrastructure: backend health ${(healthyRate * 100).toFixed(0)}% across ${total} post-epoch entries — fix backend errors before drawing gate conclusions (run \`node PLUGIN/scripts/review-shadow.mjs\`)`,
      fix: null,
    });
  }
  const passRate = healthy > 0 ? passed / healthy : 0;
  if (
    healthy >= SHADOW_GATE_MIN_HEALTHY &&
    passed >= SHADOW_GATE_MIN_PASSED &&
    passRate >= SHADOW_GATE_MIN_PASS_RATE
  ) {
    // Snooze: user reviewed shadow data and chose to stay in shadow mode.
    // Re-nudge only when the reviewed count has meaningfully grown.
    if (injectionNudge === 'dismissed') {
      return makeCheck({
        id: CHECK_IDS['injection-shadow-gate'],
        name: 'Injection shadow gate',
        status: SEVERITIES.ok,
        severity: SEVERITIES.warn,
        detail: `shadow mode: gate-ready (${passed}/${healthy} healthy entries pass) but nudge dismissed — run /learning-loop:doctor when you want to reconsider`,
        fix: null,
      });
    }
    return makeCheck({
      id: CHECK_IDS['injection-shadow-gate'],
      name: 'Injection shadow gate',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `shadow gate passing (${passed}/${healthy} recent healthy entries, ${(passRate * 100).toFixed(1)}% pass rate) — ready for review before flipping injection_mode to live`,
      fix: 'Review with `node PLUGIN/scripts/review-shadow.mjs`, then run /learning-loop:doctor to apply the flip or hold in shadow (config.json injection_mode: shadow -> live)',
    });
  }
  return makeCheck({
    id: CHECK_IDS['injection-shadow-gate'],
    name: 'Injection shadow gate',
    status: SEVERITIES.ok,
    severity: SEVERITIES.warn,
    detail: `shadow mode: ${passed}/${healthy} recent healthy entries passed the gate — keep collecting`,
    fix: null,
  });
}

export function checkAbiDrift({ abiDriftResult } = {}) {
  // The caller is responsible for invoking detectAbiDrift from check-deps-impl.mjs.
  // This check accepts the result so it stays in the quick library (no native module loads).
  if (!abiDriftResult || abiDriftResult.status === 'ok') {
    return makeCheck({
      id: CHECK_IDS['abi-drift'],
      name: 'Native ABI',
      status: SEVERITIES.ok,
      severity: SEVERITIES.fail,
      detail: 'no drift',
      fix: null,
    });
  }
  if (abiDriftResult.status === 'abi-mismatch') {
    return makeCheck({
      id: CHECK_IDS['abi-drift'],
      name: 'Native ABI',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `expected NODE_MODULE_VERSION ${abiDriftResult.expectedAbi}, got ${abiDriftResult.actualAbi}`,
      fix: abiDriftResult.fix || 'Run npm rebuild in the affected plugin',
    });
  }
  return makeCheck({
    id: CHECK_IDS['abi-drift'],
    name: 'Native ABI',
    status: SEVERITIES.fail,
    severity: SEVERITIES.fail,
    detail: abiDriftResult.message || 'unknown error',
    fix: 'Inspect native plugin modules; consider reinstall',
  });
}
