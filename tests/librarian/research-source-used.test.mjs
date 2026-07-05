import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../../plugin/scripts/librarian/research.mjs';

describe('runResearch reports source_used', () => {
  it('labels injected fns as "injected"', async () => {
    const bundle = await runResearch('q', {
      angles: [{ label: 'g', query: 'q' }],
      searchFn: async () => [{ url: 'https://a', title: 'A', snippet: 's' }],
      fetchTextFn: async () => ({ text: 'body text here', ok: true, reason: 'ok' }),
      extractFn: async () => ({ sourceQuality: 'blog', sourceId: null, claims: [] }),
    });
    assert.deepEqual(bundle.source_used, { search: 'injected', fetch: 'injected' });
  });

  it('reports the resolved default id for a NON-injected slot (no network fired)', async () => {
    // Inject only searchFn, returning [] so picked is empty and the default
    // fetchTextFn is never actually called -- but source_used.fetch must still
    // report the resolved default id ('raw'), proving per-fn detection.
    const bundle = await runResearch('q', {
      angles: [{ label: 'g', query: 'q' }],
      searchFn: async () => [],
    });
    assert.equal(bundle.source_used.search, 'injected');
    assert.equal(bundle.source_used.fetch, 'raw');
    assert.equal(bundle.sources.length, 0);
  });
});
