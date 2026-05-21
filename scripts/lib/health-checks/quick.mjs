// Quick health checks: file existence, version reads, no shell-outs.
// Each function takes its inputs explicitly (for testability) and never throws.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from './types.mjs';

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
  if (!vaultRoot) {
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

export function checkBinaryVersionFile({ pluginData } = {}) {
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
  const verPath = join(pluginData, 'bin', '.version');
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
