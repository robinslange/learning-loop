// Quick health checks: file existence, version reads, no shell-outs.
// Each function takes its inputs explicitly (for testability) and never throws.

import { closeSync, existsSync, openSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { checker } from './types.mjs';
import {
  DATA_FILES,
  DATA_PATHS,
  FEDERATION_PATHS,
  SHIM_NAMES,
  binaryFileName,
  daemonSocketSupported,
  shimFileName,
} from '../paths.mjs';
import { safeLoad } from '../safe-load.mjs';
import { resolveShimRoot } from '../shims.mjs';
import { readJsonl, readTailLines } from '../jsonl.mjs';
import { semverCmp, isPlainSemver } from '../semver.mjs';
import { HookConfig, INJECTION_CALIBRATION_EPOCH } from '../hook-config.mjs';
import { recentMonths, monthStr } from '../retrieval.mjs';
import { MARKER_PATHS } from '../marker-cache.mjs';
import { OTEL_EXPORT_TTL_MS } from '../../../hooks/session-start/otel-export.mjs';

// How many trigger intervals may pass before a stamped marker counts as stale.
// Three hours rather than one: the trigger fires from session-start, so a
// machine left unused overnight is normal and must not read as broken.
const STALE_EXPORT_TTL_MULTIPLE = 3;
import { isExportEnabled as defaultIsExportEnabled } from '../../otel/export.mjs';
import {
  isVaultOk,
  isEpisodicOk,
  isHealthy,
  isGatePassed,
  SHADOW_BACKEND_HEALTH_MIN_RATE,
  SHADOW_BACKEND_HEALTH_MIN_TOTAL,
} from '../shadow-gate.mjs';

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
  const c = checker('vault-path', 'Vault path', 'fail');
  if (!vaultRoot) {
    return c.fail('not configured', 'Run /learning-loop:init to set your vault path');
  }
  if (!existsSync(vaultRoot)) {
    return c.fail(
      `directory missing: ${vaultRoot}`,
      'Restore the vault directory or run /learning-loop:init to pick a new path',
    );
  }
  return c.ok(vaultRoot);
}

export function checkVaultFolders({ vaultRoot } = {}) {
  const c = checker('vault-folders', 'Vault folders', 'fail');
  if (!vaultRoot || !existsSync(vaultRoot)) {
    return c.fail('vault path not available', 'Fix vault-path first');
  }
  const missing = VAULT_FOLDERS.filter((f) => !existsSync(join(vaultRoot, f)));
  if (missing.length === 0) {
    return c.ok('7/7 present');
  }
  return c.fail(
    `missing: ${missing.join(', ')}`,
    `Run /learning-loop:init to create missing folders: ${missing.join(', ')}`,
  );
}

export function checkVaultSystemFiles({ vaultRoot } = {}) {
  const c = checker('vault-system-files', 'Vault system files', 'warn');
  if (!vaultRoot || !existsSync(vaultRoot)) {
    return c.fail('vault path not available', 'Fix vault-path first');
  }
  const missing = [];
  for (const f of ['_system/persona.md', '_system/capture-rules.md']) {
    if (!existsSync(join(vaultRoot, f))) missing.push(f);
  }
  if (missing.length === 0) {
    return c.ok('persona + capture rules present');
  }
  return c.fail(
    `missing: ${missing.join(', ')}`,
    'Run /learning-loop:init Phase 2c to restore system file defaults',
  );
}

export function checkBinaryExists({ pluginData, platform = process.platform } = {}) {
  const c = checker('binary-exists', 'll-search binary', 'fail');
  if (!pluginData) {
    return c.fail(
      'plugin-data path not resolved',
      'Run /learning-loop:init to download the binary',
    );
  }
  // The name the DOWNLOADER writes, which differs by platform. `lib/binary.mjs`
  // already resolved it correctly, so semantic search worked while this check
  // reported the binary missing and offered to re-download it.
  const binPath = join(pluginData, 'bin', binaryFileName(platform));
  if (!existsSync(binPath)) {
    return c.fail(`missing at ${binPath}`, 'Run /learning-loop:init to re-download the binary');
  }
  try {
    const stat = statSync(binPath);
    // Same reason as the shims below: no meaningful 0o111 on a Windows `.exe`,
    // so existence is the only signal the mode bit could have added.
    if (platform !== 'win32' && !(stat.mode & 0o111)) {
      return c.fail('not executable', `chmod +x ${binPath}`);
    }
  } catch (err) {
    return c.fail(`stat error: ${err.message}`, 'Run /learning-loop:init to re-download');
  }
  return c.ok(binPath);
}

function stripV(s) {
  return typeof s === 'string' && s.startsWith('v') ? s.slice(1) : s;
}

export function checkBinaryVersionFile({ pluginData, pluginVersion } = {}) {
  const c = checker('binary-version-file', 'Binary version file', 'warn');
  if (!pluginData) {
    return c.fail('plugin-data not resolved', 'Fix plugin-data resolution first');
  }
  const verPath = DATA_FILES.binVersion(pluginData);
  if (!existsSync(verPath)) {
    return c.fail('missing', 'Run /learning-loop:init to re-download (writes .version)');
  }
  try {
    const version = readFileSync(verPath, 'utf-8').trim();
    // A readable .version that lags the running plugin version means the
    // session-start binary auto-update is stuck (download failing silently).
    const installed = stripV(version);
    const running = stripV(pluginVersion || '');
    if (isPlainSemver(installed) && isPlainSemver(running) && semverCmp(installed, running) < 0) {
      return c.fail(
        `binary v${installed} behind plugin v${running} — auto-update may be stuck`,
        'Run node PLUGIN/scripts/download-binary.mjs manually and check network access',
      );
    }
    return c.ok(version);
  } catch (err) {
    return c.fail(`read error: ${err.message}`, 'Run /learning-loop:init to repair');
  }
}

export function checkShimsExist({ home, platform = process.platform } = {}) {
  const c = checker('shims-exist', 'CLI shims', 'fail');
  if (!home) {
    return c.fail('HOME not set', 'Set $HOME');
  }
  const missing = [];
  for (const s of SHIM_NAMES) {
    // The name the INSTALLER writes, which is `<name>.cmd` on Windows. Looking
    // for the POSIX name everywhere reported a correct Windows install as four
    // missing shims and offered to reinstall them, every session.
    const file = shimFileName(s, platform);
    const p = join(home, '.local/bin', file);
    if (!existsSync(p)) {
      missing.push(file);
      continue;
    }
    // Windows decides executability by extension, not by a mode bit, and
    // `statSync().mode` there has no meaningful 0o111. Asserting it would fail
    // on every correctly installed .cmd.
    if (platform === 'win32') continue;
    try {
      const stat = statSync(p);
      if (!(stat.mode & 0o111)) missing.push(`${file} (not executable)`);
    } catch {
      missing.push(`${file} (stat error)`);
    }
  }
  if (missing.length === 0) {
    // Existence and an exec bit are not what a shim has to satisfy. Each one
    // resolves an install and runs its scripts/shim.mjs, so a shim pointing at
    // a tree without that file is present, executable, and guaranteed to exit
    // 1 — which is what 2.0.7 shipped, for a whole session, while this check
    // reported four shims ready. Mirror the resolution instead of the file.
    const root = resolveShimRoot(home);
    if (!root) {
      return c.fail(
        'installed, but no resolved root ships scripts/shim.mjs — every shim exits 1',
        // Deliberately not install-shims: rewriting four correct files that
        // resolve to a tree with no shim.mjs reproduces the same failure.
        'Upgrade the plugin, or call scripts directly: node PLUGIN/scripts/<script>.mjs',
      );
    }
    return c.ok(`${SHIM_NAMES.join(' + ')} ready`);
  }
  return c.fail(
    `missing: ${missing.join(', ')}`,
    'Run node PLUGIN/scripts/install-shims.mjs --install',
  );
}

export function checkLocalBinOnPath({ home, pathEnv, pathDelimiter = delimiter } = {}) {
  const c = checker('local-bin-on-path', '~/.local/bin on PATH', 'warn');
  if (!home) {
    return c.fail('HOME not set', 'Set $HOME');
  }
  const target = join(home, '.local', 'bin');
  // `path.delimiter`, not ':'. Windows separates PATH entries with ';', so
  // splitting on ':' there yields one giant segment that matches nothing --
  // and the drive letters make every entry contain a ':' of its own.
  const segments = (pathEnv || '').split(pathDelimiter);
  if (segments.includes(target)) {
    return c.ok(target);
  }
  return c.fail('not on PATH', 'Add to your shell rc: export PATH="$HOME/.local/bin:$PATH"');
}

const CLAUDEMD_MARKER_RE = /<!--\s*learning-loop\s+v(\d+)\s*-->/;

// { version } (null when the file has no marker), or { error, fix } when the
// file cannot be read.
function readClaudemdMarker(home) {
  const p = join(home, '.claude/CLAUDE.md');
  if (!existsSync(p)) {
    return {
      error: '~/.claude/CLAUDE.md not found',
      fix: 'Run /learning-loop:init Phase 5 to install',
    };
  }
  try {
    const m = CLAUDEMD_MARKER_RE.exec(readFileSync(p, 'utf-8'));
    return { version: m ? m[1] : null };
  } catch (err) {
    return { error: `read error: ${err.message}`, fix: 'Check ~/.claude/CLAUDE.md permissions' };
  }
}

export function checkClaudemdSectionPresent({ home } = {}) {
  const c = checker('claudemd-section-present', 'CLAUDE.md section', 'warn');
  if (!home) {
    return c.fail('HOME not set', 'Set $HOME');
  }
  const r = readClaudemdMarker(home);
  if (r.error) {
    return c.fail(r.error, r.fix);
  }
  if (r.version === null) {
    return c.fail(
      'marker missing',
      'Run /learning-loop:init Phase 5 to install the learning-loop section',
    );
  }
  return c.ok('marker found');
}

export function checkClaudemdSectionCurrent({ home, templateVersion } = {}) {
  const c = checker('claudemd-section-current', 'CLAUDE.md section version', 'warn');
  if (!home || !templateVersion) {
    return c.fail('missing inputs', 'Internal: check caller resolved templateVersion');
  }
  const r = readClaudemdMarker(home);
  if (r.error) {
    return c.fail(r.error, r.fix);
  }
  if (r.version === null) {
    return c.fail('marker missing', 'Run /learning-loop:init Phase 5');
  }
  if (r.version === String(templateVersion)) {
    return c.ok(`v${r.version}`);
  }
  return c.fail(
    `installed v${r.version}, template v${templateVersion}`,
    'Run /learning-loop:init Phase 5 to update the section',
  );
}

export function checkInstalledPluginsReadable({ home } = {}) {
  const c = checker('installed-plugins-readable', 'Plugin registry', 'fail');
  if (!home) {
    return c.fail('HOME not set', 'Set $HOME');
  }
  const p = join(home, '.claude/plugins/installed_plugins.json');
  if (!existsSync(p)) {
    return c.fail(
      'installed_plugins.json not found',
      'Claude Code may not have run yet; launch Claude Code once and try again',
    );
  }
  try {
    JSON.parse(readFileSync(p, 'utf-8'));
    return c.ok(p);
  } catch (err) {
    return c.fail(
      `parse error: ${err.message}`,
      'Inspect ~/.claude/plugins/installed_plugins.json for corruption',
    );
  }
}

export function checkPluginCacheVersionPresent({ home, installedVersion } = {}) {
  const c = checker('plugin-cache-version-present', 'Plugin cache directory', 'fail');
  if (!home || !installedVersion) {
    return c.fail('missing inputs', 'Internal: caller should pass installedVersion');
  }
  const verDir = join(
    home,
    '.claude/plugins/cache/learning-loop-marketplace/learning-loop',
    installedVersion,
  );
  if (!existsSync(verDir)) {
    return c.fail(
      `missing: ${verDir}`,
      `Run: claude plugin install learning-loop@learning-loop-marketplace`,
    );
  }
  return c.ok(verDir);
}

export function checkSearchIndexExists({ vaultRoot } = {}) {
  const c = checker('search-index-exists', 'Search index', 'warn');
  if (!vaultRoot) {
    return c.fail('vault path not available', 'Fix vault-path first');
  }
  const p = join(vaultRoot, '.vault-search/vault-index.db');
  if (!existsSync(p)) {
    return c.fail(
      'no index — run vault-search.mjs index to build',
      'Run: ll-run vault-search.mjs index',
    );
  }
  try {
    const stat = statSync(p);
    if (stat.size === 0) {
      return c.fail('index file is empty', 'Run: ll-run vault-search.mjs index');
    }
    return c.ok(`${Math.round(stat.size / 1024)} KB`);
  } catch (err) {
    return c.fail(`stat error: ${err.message}`, 'Run: ll-run vault-search.mjs index');
  }
}

export function checkDupScanSocketFresh({ pluginData } = {}) {
  const c = checker('dup-scan-socket-fresh', 'Duplicate-scan socket', 'warn');
  if (!pluginData) {
    return c.ok('plugin-data not available — skipped');
  }
  const p = DATA_FILES.dupScanSocket(pluginData);
  if (!existsSync(p)) {
    return c.ok('not running (no socket file)');
  }
  try {
    const stat = statSync(p);
    if (!stat.isSocket()) {
      return c.fail('stale (file at socket path is not a socket)', `rm ${p} and restart ll-watch`);
    }
    return c.ok(p);
  } catch (err) {
    return c.fail(`stat error: ${err.message}`, `Inspect ${p}`);
  }
}

// How many duplicate-gate timeouts in the scanned window count as "the gate is
// permanently disabled on this machine" rather than a one-off slow write.
const DUPLICATE_GATE_TIMEOUT_WARN_THRESHOLD = 3;

// Every record in the current and previous month's hook-errors logs
// (`hook-errors-YYYY-MM.jsonl`). A corrupt line is skipped.
function recentHookErrors(pluginData, now) {
  return recentMonths(now).flatMap((m) => readJsonl(join(pluginData, `hook-errors-${m}.jsonl`)));
}

/**
 * Whether federation is still syncing.
 *
 * The daemon already knows when it stops: it writes the error to
 * sync-state.json every cycle and `ll-search status` renders it. But status
 * only speaks to whoever runs it, and the session-start federation line is
 * sealed inside the untrusted-data envelope with the retrieved notes -- one
 * unmarked sentence in a block the model is told not to act on. So a vault
 * could stop federating indefinitely with the evidence sitting in a file
 * nobody reads.
 *
 * `fail` rather than `warn` on purpose: health-detector.mjs surfaces only
 * `fail`, and this is the channel that reaches the user unframed.
 */
export function checkFederationSyncHealth({
  pluginData,
  syncIntervalSecs = 300,
  now = Date.now(),
} = {}) {
  const c = checker('federation-sync-health', 'Federation sync', 'fail');
  const bad = (detail) =>
    c.fail(
      detail,
      'Run `ll-search status` for the full report; the detail above is the error the daemon last recorded.',
    );

  if (!pluginData) return c.ok('plugin-data not available — skipped');

  // Same profile walk as the session-start federation line: the registry when
  // there is one, otherwise the single implicit profile.
  let profiles = [{ id: null, config_dir: pluginData }];
  const registryPath = FEDERATION_PATHS.vaultRegistry(pluginData);
  if (existsSync(registryPath)) {
    const doc = safeLoad(registryPath, { fallback: null }).value;
    // A registry that is present and unreadable is not "no registry". Every
    // vault profile on the machine is named in this file, so nothing can be
    // resolved and nothing syncs -- and reporting that as `not configured`
    // makes a broken install indistinguishable from a fresh one, which is
    // the shape of the outage this check was added for.
    if (!Array.isArray(doc?.vaults)) {
      return bad(
        `${registryPath} is present but names no vault list, so no profile can be ` +
          'resolved and nothing syncs',
      );
    }
    profiles = doc.vaults;
  }

  let configured = 0;
  for (const profile of profiles) {
    const dir = profile?.config_dir;
    if (typeof dir !== 'string' || !existsSync(FEDERATION_PATHS.config(dir))) continue;
    configured += 1;
    const who = profile.id ? `${profile.id}: ` : '';
    const state = safeLoad(FEDERATION_PATHS.syncState(dir), { fallback: null }).value;

    if (!state) return bad(`${who}no sync cycle has ever completed`);

    const detail = state.detail || 'no detail recorded';
    if (state.outcome === 'error' && state.terminal === true) {
      return bad(`${who}federation cannot recover by retrying: ${detail}`);
    }
    const streak = state.consecutive_failures ?? (state.outcome === 'error' ? 1 : 0);
    if (state.outcome === 'error' && streak >= 3) {
      return bad(`${who}federation has failed ${streak} times in a row: ${detail}`);
    }
    // Catches the daemon that stopped ticking entirely, which no counter sees
    // because nothing is writing one.
    const nowSecs = Math.floor(now / 1000);
    if (state.last_success_at && nowSecs - state.last_success_at > 6 * syncIntervalSecs) {
      const mins = Math.round((nowSecs - state.last_success_at) / 60);
      return bad(`${who}no successful sync in ${mins} minutes`);
    }
  }
  return c.ok(configured === 0 ? 'not configured' : 'syncing');
}

// Warn when recent hook-errors logs show repeated duplicate-gate timeouts or a
// stale daemon. The pre-write duplicate gate fails OPEN on timeout (silent
// pass), so a slow machine can permanently lose the gate with nothing surfaced
// but log lines. A stale daemon binary (which lacks duplicate-scan support)
// pays the round-trip + cold subprocess on every vault Write indefinitely.
// Timeouts from the daemon socket are counted apart, since they are what tell
// "no daemon" from "daemon too slow".
export function checkDuplicateGateHealth({
  pluginData,
  now = new Date(),
  platform = process.platform,
} = {}) {
  const c = checker('duplicate-gate-health', 'Duplicate gate', 'warn');
  if (!pluginData) {
    return c.ok('plugin-data not available — skipped');
  }
  const rows = recentHookErrors(pluginData, now);
  const timeouts = rows.filter((r) => r?.code === 'duplicate-gate-timeout');
  const totalTimeouts = timeouts.length;
  const totalDaemonTimeouts = timeouts.filter((r) => r.source === 'daemon').length;
  // A daemon timeout still falls through to the subprocess. Only a subprocess
  // or budget failure means the write itself skipped the gate.
  const totalHardFailures = timeouts.filter(
    (r) => r.source === 'subprocess' || r.source === 'budget',
  ).length;
  const totalStaleDaemon = rows.filter((r) => r?.code === 'duplicate-gate-stale-daemon').length;
  if (totalStaleDaemon > 0) {
    return c.fail(
      `stale daemon binary: ${totalStaleDaemon} stale-daemon error(s) in recent logs — the duplicate gate is paying cold-start on every vault write`,
      'Restart the watch daemon to pick up the new binary: kill the current ll-watch, then ll-watch',
    );
  }
  if (totalTimeouts >= DUPLICATE_GATE_TIMEOUT_WARN_THRESHOLD) {
    // A timeout logged against source 'daemon' proves the socket was there and a
    // live daemon accepted the connection — it just answered too slowly. Advising
    // a start would send the user to fix a daemon that is already running.
    const daemonIsUp = totalDaemonTimeouts > 0;

    // On a platform with no socket transport there is no warm path to start, so
    // every call pays a cold subprocess and the only lever is the write budget.
    // Prescribing ll-watch here is advice that cannot work at any daemon state.
    if (!daemonSocketSupported(platform)) {
      return c.fail(
        `${totalTimeouts} duplicate-gate timeouts in recent logs — this platform has no daemon socket, so every write pays a cold model start and the gate falls open when it overruns`,
        'No daemon can serve the gate here, so starting one changes nothing. Set LL_PRE_WRITE_BUDGET_MS above your measured cold start: it is the only part of this that survives an upgrade, because the plugin replaces hooks.json on every release. Raising the pre-write-check timeout in plugin/hooks/hooks.json to match makes the longer budget usable now, but expect to redo it after the next update.',
      );
    }

    return c.fail(
      daemonIsUp
        ? `${totalTimeouts} duplicate-gate timeouts in recent logs (${totalDaemonTimeouts} from the daemon socket) — the daemon is running but answered too slowly, so each of those writes fell back to a cold subprocess` +
            (totalHardFailures > 0
              ? `; ${totalHardFailures} of them then failed there too, and those writes were saved without a duplicate check`
              : ' (the fallback caught every one, so no write went unchecked)')
        : `${totalTimeouts} duplicate-gate timeouts in recent logs — no daemon answered, so each of those writes fell back to a cold subprocess start` +
            (totalHardFailures > 0
              ? `; ${totalHardFailures} of them then failed there too, and those writes were saved without a duplicate check`
              : ' (the fallback caught every one, so no write went unchecked)'),
      daemonIsUp
        ? totalHardFailures > 0
          ? `The daemon answered outside its ${HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS}ms socket wait and the cold subprocess behind it ran out of room as well. That second window is what the outer hook deadline sizes, so raise LL_PRE_WRITE_BUDGET_MS to give a cold scan time to finish.`
          : `The daemon is answering, just not inside its ${HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS}ms socket wait, so these writes paid a cold subprocess instead of the warm path. The scan's slowest responses sit close to that wait, so load on the machine or several writes landing together will cross it. Nothing was left unchecked and there is no override for this constant: the cost is latency. If it is frequent, cut what competes with the daemon, or change PRE_WRITE_DAEMON_TIMEOUT_MS in the plugin.`
        : 'Start the warm daemon (ll-watch) so the gate uses the socket instead of cold-starting the model: ll-watch',
    );
  }
  return c.ok(
    totalTimeouts === 0
      ? 'no recent timeouts'
      : `${totalTimeouts} recent timeout(s) (under threshold)`,
  );
}

// --- General hook-error summary ---
// Counts every well-formed JSON line in the hook-errors monthly logs (all
// error events, regardless of code) and surfaces the most recent one. Distinct
// from checkDuplicateGateHealth which counts only specific gate-failure codes.
const HOOK_ERROR_WARN_THRESHOLD = 5;

export function checkHookErrors({ pluginData, now = new Date() } = {}) {
  const c = checker('hook-errors', 'Hook errors', 'warn');
  if (!pluginData) {
    return c.ok('plugin-data not available — skipped');
  }
  const rows = recentHookErrors(pluginData, now);
  const totalCount = rows.length;
  let latest = null;
  for (const obj of rows) {
    if (!latest || !latest.ts || (obj.ts && obj.ts > latest.ts)) latest = obj;
  }
  if (totalCount > HOOK_ERROR_WARN_THRESHOLD) {
    const latestSummary = latest
      ? `${latest.module ?? 'unknown'} @ ${latest.ts ?? '?'} — ${String(latest.message ?? '').slice(0, 80)}`
      : 'unknown';
    return c.fail(
      `${totalCount} hook errors in the last 2 months; latest: ${latestSummary}`,
      `Check ~/.claude/plugins/data/.../hook-errors-*.jsonl to identify which hook/module is failing`,
    );
  }
  return c.ok(
    totalCount === 0 ? 'no hook errors logged' : `${totalCount} hook error(s) (under threshold)`,
  );
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
  const c = checker('injection-shadow-gate', 'Injection shadow gate', 'warn');
  const mode = injectionMode || 'shadow';
  if (mode === 'live') {
    return c.ok('injection_mode live — JIT injection active');
  }
  if (mode === 'off') {
    return c.ok('injection_mode off — JIT injection disabled by config');
  }
  if (!pluginData) {
    return c.ok('plugin-data not available — skipped');
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
    return c.ok(
      `infrastructure: backend health ${(healthyRate * 100).toFixed(0)}% across ${total} post-epoch entries — fix backend errors before drawing gate conclusions (run \`node PLUGIN/scripts/review-shadow.mjs\`)`,
    );
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
      return c.ok(
        `shadow mode: gate-ready (${passed}/${healthy} healthy entries pass) but nudge dismissed — run /learning-loop:doctor when you want to reconsider`,
      );
    }
    return c.fail(
      `shadow gate passing (${passed}/${healthy} recent healthy entries, ${(passRate * 100).toFixed(1)}% pass rate) — ready for review before flipping injection_mode to live`,
      'Review with `node PLUGIN/scripts/review-shadow.mjs`, then run /learning-loop:doctor to apply the flip or hold in shadow (config.json injection_mode: shadow -> live)',
    );
  }
  return c.ok(
    `shadow mode: ${passed}/${healthy} recent healthy entries passed the gate — keep collecting`,
  );
}

export function checkAbiDrift({ abiDriftResult } = {}) {
  const c = checker('abi-drift', 'Native ABI', 'fail');
  // The caller is responsible for invoking detectAbiDrift from check-deps.mjs.
  // This check accepts the result so it stays in the quick library (no native module loads).
  if (!abiDriftResult || abiDriftResult.status === 'ok') {
    return c.ok('no drift');
  }
  if (abiDriftResult.status === 'abi-mismatch') {
    return c.fail(
      `expected NODE_MODULE_VERSION ${abiDriftResult.expectedAbi}, got ${abiDriftResult.actualAbi}`,
      abiDriftResult.fix || 'Run npm rebuild in the affected plugin',
    );
  }
  return c.fail(
    abiDriftResult.message || 'unknown error',
    'Inspect native plugin modules; consider reinstall',
  );
}

// --- Otel export status (TD, T2h exit criteria) ---
// Reports whether otel export is active (endpoint configured AND the
// config.json opt-in is set) or inactive, and when active, the age in
// seconds of the last successful export, read from the otelExport marker's
// mtime (T2h's worker stamps it only on a successful run). See
// docs/plans/otel-consolidation.md, "Config and consent" and phase 2's exit
// criteria: health-check.mjs --full --json reports export active/inactive
// and the age of the last successful export in seconds.
export function checkOtelExportStatus({
  pluginData,
  isExportEnabled = defaultIsExportEnabled,
  now = Date.now(),
} = {}) {
  const c = checker('otel-export-status', 'Otel export', 'warn');
  if (!pluginData) {
    return c.ok('plugin-data not available, skipped');
  }
  if (!isExportEnabled()) {
    return c.ok('inactive (no endpoint configured or opt-in not set)');
  }
  let stat;
  try {
    stat = statSync(MARKER_PATHS.otelExport(pluginData));
  } catch {
    stat = null;
  }
  if (!stat) {
    return c.fail(
      'active, but no export has succeeded yet: either no telemetry has accumulated or the export is failing',
      'Open a session (the worker runs detached from session-start), then see the otel-error-log check',
    );
  }
  const ageSecs = Math.max(0, Math.round((now - stat.mtimeMs) / 1000));
  // A marker that exists is not the same as an export that is working. The
  // worker stamps it only on success, so once the endpoint dies the marker
  // simply stops moving: reporting ok on any age meant a dead Pi looked
  // healthy indefinitely, with the operator expected to do the arithmetic on
  // "last export 691207s ago" themselves. Threshold against the trigger's own
  // interval, with slack for a machine that was asleep or simply unused.
  const staleAfterMs = OTEL_EXPORT_TTL_MS * STALE_EXPORT_TTL_MULTIPLE;
  if (now - stat.mtimeMs > staleAfterMs) {
    return c.fail(
      `active, but the last successful export was ${ageSecs}s ago (over ${Math.round(staleAfterMs / 1000)}s): exports are failing or no session has opened`,
      'Check the endpoint is reachable and see the otel-error-log check; a failing POST leaves this marker unstamped',
    );
  }
  return c.ok(`active, last successful export ${ageSecs}s ago`);
}

// --- Otel error log (TD, T1i coverage) ---
// Counts error records in the current month's log-YYYY-MM.jsonl (T1i's
// durable sink for log.mjs's logError()) and names the top scope, so the
// previously-invisible failure modes T1i started persisting are surfaced in
// /doctor. Uses the tail-read idiom already established by
// collectShadowGateStats/readTailLines rather than loading the whole file:
// the log can grow, and only a bounded recent window is needed for a count.
const OTEL_ERROR_LOG_TAIL_BYTES = 2 * 1024 * 1024;

export function checkOtelErrorLog({ pluginData, now = new Date() } = {}) {
  const c = checker('otel-error-log', 'Error log', 'warn');
  if (!pluginData) {
    return c.ok('plugin-data not available, skipped');
  }
  const path = join(DATA_PATHS.logs(pluginData), `log-${monthStr(now)}.jsonl`);
  // log.mjs's sink swallows its own write failures by design (an error
  // boundary cannot throw), so an unwritable log dir left this check saying
  // "no errors" while the export-status check said the export was failing:
  // a contradictory pair that sent the operator to an empty file. Probe the
  // sink here, where the finding can be shown.
  const sinkError = probeAppendable(path);
  if (sinkError) {
    return c.fail(
      `error log sink is not writable (${sinkError}): failures are not being recorded`,
      `Make ${path} appendable; until then, failures reach stderr only`,
    );
  }
  const scopeCounts = new Map();
  let total = 0;
  for (const line of readTailLines(path, OTEL_ERROR_LOG_TAIL_BYTES)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.level !== 'error') continue;
    total++;
    const scope = obj.scope || 'unknown';
    scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
  }
  if (total === 0) {
    return c.ok('no errors logged this month');
  }
  // Every error scope shares this log, so name the top few rather than one:
  // a single otel failure behind a noisier unrelated scope was invisible.
  const top = [...scopeCounts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topScope = top[0][0];
  return c.fail(
    `${total} error(s) logged this month, top scopes: ${top.map(([s, c]) => `${s} (${c})`).join(', ')}`,
    `Check ${path} for details on the ${topScope} scope`,
  );
}

// The error string when `path` cannot be appended to (its directory created
// if absent), or null when it can. Opens for append and closes without
// writing, so the probe leaves an empty file at most.
function probeAppendable(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'a'));
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}
