// Quick health checks: file existence, version reads, no shell-outs.
// Each function takes its inputs explicitly (for testability) and never throws.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from './types.mjs';
import { DATA_FILES } from '../paths.mjs';
import { semverCmp, isPlainSemver } from '../semver.mjs';

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
      name: 'NLI socket',
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
      name: 'NLI socket',
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
        name: 'NLI socket',
        status: SEVERITIES.fail,
        severity: SEVERITIES.warn,
        detail: 'stale (file at socket path is not a socket)',
        fix: `rm ${p} and restart ll-watch`,
      });
    }
    return makeCheck({
      id: CHECK_IDS['nli-socket-fresh'],
      name: 'NLI socket',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: p,
      fix: null,
    });
  } catch (err) {
    return makeCheck({
      id: CHECK_IDS['nli-socket-fresh'],
      name: 'NLI socket',
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

// Count duplicate-gate-timeout entries in a single monthly hook-errors jsonl.
// Tolerant of partial/corrupt lines (best-effort diagnostic, never throws).
function countDuplicateGateTimeouts(path) {
  if (!existsSync(path)) return 0;
  let count = 0;
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return 0;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.code === 'duplicate-gate-timeout') count++;
    } catch {
      // Skip a corrupt line — keep counting the rest.
    }
  }
  return count;
}

// Warn when recent hook-errors logs show repeated duplicate-gate timeouts.
// The pre-write duplicate gate fails OPEN on timeout (silent pass), so a slow
// machine can permanently lose the gate with nothing surfaced but log lines.
// This check makes that visible. Scans the current + previous month files
// (`hook-errors-YYYY-MM.jsonl`), the same naming post-tool.js writes.
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
  const months = [now, new Date(now.getFullYear(), now.getMonth() - 1, 1)].map((d) =>
    d.toISOString().slice(0, 7),
  );
  let total = 0;
  for (const month of months) {
    total += countDuplicateGateTimeouts(join(pluginData, `hook-errors-${month}.jsonl`));
  }
  if (total >= DUPLICATE_GATE_TIMEOUT_WARN_THRESHOLD) {
    return makeCheck({
      id: CHECK_IDS['duplicate-gate-health'],
      name: 'Duplicate gate',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `${total} duplicate-gate timeouts in recent logs — the gate is silently disabled on writes`,
      fix: 'Start the warm daemon (ll-watch) so the gate uses the socket instead of cold-starting the model: ll-watch',
    });
  }
  return makeCheck({
    id: CHECK_IDS['duplicate-gate-health'],
    name: 'Duplicate gate',
    status: SEVERITIES.ok,
    severity: SEVERITIES.warn,
    detail: total === 0 ? 'no recent timeouts' : `${total} recent timeout(s) (under threshold)`,
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
