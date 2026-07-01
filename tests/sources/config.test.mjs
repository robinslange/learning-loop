import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSourcesConfig, SLOT_DEFAULTS } from '../../plugin/scripts/lib/sources/config.mjs';

describe('loadSourcesConfig', () => {
  it('absent sources block → all slots are defaults', () => {
    const c = loadSourcesConfig({ getConfigFn: () => ({}) });
    assert.equal(c.web_search, 'brave');
    assert.equal(c.fetch, 'raw');
    assert.equal(c.research, 'librarian');
    assert.deepEqual(c.providers, {});
  });
  it('a configured slot overrides its default', () => {
    const c = loadSourcesConfig({ getConfigFn: () => ({ sources: { web_search: 'ygrep' } }) });
    assert.equal(c.web_search, 'ygrep');
    assert.equal(c.fetch, 'raw'); // untouched slot still default
  });
  it('exposes providers passthrough', () => {
    const c = loadSourcesConfig({ getConfigFn: () => ({ sources: { providers: { brave: { api_key_ref: 'x' } } } }) });
    assert.deepEqual(c.providers, { brave: { api_key_ref: 'x' } });
  });
});
