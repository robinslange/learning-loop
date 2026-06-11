// Contract test for Phases 1 + 2 + 3b: hooks-side resolveVaultPath /
// resolveConfig / getSessionId are now thin re-exports of canonical helpers
// in scripts/lib/. This test pins that contract so a future divergence
// (someone reintroducing the local function or shadowing the export with a
// local impl) fails fast with a referenced-identity check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hooksCommon from '../plugin/hooks/lib/common.mjs';
import * as libConfig from '../plugin/scripts/lib/config.mjs';
import * as libSession from '../plugin/scripts/lib/session.mjs';

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

test('hooks/lib/common.getSessionId === scripts/lib/session.getSessionId', () => {
  assert.equal(
    hooksCommon.getSessionId,
    libSession.getSessionId,
    'getSessionId must be a direct re-export of canonical scripts/lib/session.getSessionId; shadowing it with a local impl re-creates the Phase 1 drift',
  );
});
