// Quick health checks: file existence, version reads, no shell-outs.
// Each function takes its inputs explicitly (for testability) and never throws.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
