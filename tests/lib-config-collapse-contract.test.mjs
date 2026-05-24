// Contract test for Phases 2 + 3b: hooks-side resolveVaultPath / resolveConfig
// are now thin re-exports of the canonical getVaultPath / getConfig.
// This test pins that contract so a future divergence (someone reintroducing
// the local function) fails fast with a referenced-identity check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hooksCommon from '../hooks/lib/common.mjs';
import * as libConfig from '../scripts/lib/config.mjs';

test('hooks/lib/common.resolveVaultPath === scripts/lib/config.getVaultPath', () => {
  assert.equal(
    hooksCommon.resolveVaultPath,
    libConfig.getVaultPath,
    'resolveVaultPath must be a direct alias of canonical getVaultPath; reintroducing a local implementation re-creates the Phase 2 drift',
  );
});

test('hooks/lib/common.resolveConfig === scripts/lib/config.getConfig', () => {
  assert.equal(
    hooksCommon.resolveConfig,
    libConfig.getConfig,
    'resolveConfig must be a direct alias of canonical getConfig; reintroducing a local implementation re-creates the Phase 3b drift',
  );
});

test('hooks/lib/common.resolvePluginData === scripts/lib/config.resolvePluginData', () => {
  assert.equal(
    hooksCommon.resolvePluginData,
    libConfig.resolvePluginData,
    'resolvePluginData has always been a re-export; pinning the contract for consistency with the Phase 2/3b aliases',
  );
});
