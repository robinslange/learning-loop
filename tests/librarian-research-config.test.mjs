// tests/librarian-research-config.test.mjs : keep_alive + research gate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadLibrarianConfig,
  __test__,
  researchModelOk,
} from '../plugin/scripts/librarian/config.mjs';

describe('librarian consolidation config', () => {
  it('exposes a default keepAlive of 30m', () => {
    __test__.resetCache();
    const cfg = loadLibrarianConfig({ configPath: '/nonexistent-so-defaults-apply.json' });
    assert.equal(cfg.keepAlive, '30m');
  });

  it('researchModelOk accepts 12b/27b, rejects e2b and tiny models', () => {
    assert.equal(researchModelOk('gemma3:12b'), true);
    assert.equal(researchModelOk('gemma3:27b'), true);
    assert.equal(researchModelOk('gemma4:e2b'), false);
    assert.equal(researchModelOk('gemma3:1b'), false);
    assert.equal(researchModelOk('qwen3:0.6b'), false);
  });
});
