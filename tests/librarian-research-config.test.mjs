// tests/librarian-research-config.test.mjs : keep_alive + research gate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadLibrarianConfig,
  __test__,
  researchModelOk,
  resolveProvider,
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

describe('resolveProvider', () => {
  it('synthesizes an ollama provider for back-compat when no provider block', () => {
    const p = resolveProvider({}, { ollamaUrl: 'http://localhost:11434', model: 'gemma3:12b' });
    assert.deepEqual(p, {
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'gemma3:12b',
    });
  });

  it('builds an openai provider from a provider block, resolving the key via the injected resolver', () => {
    const p = resolveProvider(
      {
        provider: {
          kind: 'openai',
          base_url: 'https://api.fireworks.ai/inference',
          api_key_ref: 'fireworks-api-key',
          model: 'accounts/fireworks/models/glm-5p2',
        },
      },
      {
        ollamaUrl: 'http://localhost:11434',
        model: 'gemma3:12b',
        keyResolver: (ref) => (ref === 'fireworks-api-key' ? 'sk-resolved' : null),
      },
    );
    assert.equal(p.kind, 'openai');
    assert.equal(p.baseUrl, 'https://api.fireworks.ai/inference');
    assert.equal(p.model, 'accounts/fireworks/models/glm-5p2');
    assert.equal(p.apiKey, 'sk-resolved');
  });

  it('does not put the api key in the object when no ref / unresolved', () => {
    const p = resolveProvider(
      { provider: { kind: 'openai', base_url: 'https://x', model: 'm' } },
      { keyResolver: () => null },
    );
    assert.equal(p.apiKey, undefined);
  });

  it('falls back to ollama kind when provider block omits kind', () => {
    const p = resolveProvider(
      { provider: { base_url: 'http://host:1234', model: 'custom' } },
      { ollamaUrl: 'http://localhost:11434', model: 'gemma3:12b' },
    );
    assert.equal(p.kind, 'ollama');
    assert.equal(p.baseUrl, 'http://host:1234');
    assert.equal(p.model, 'custom');
  });
});
