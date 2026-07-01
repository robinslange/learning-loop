import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGateway, UsageError } from '../../plugin/bin/source-gateway.mjs';

describe('gateway search verb', () => {
  it('returns hits + source_used from the resolved source', async () => {
    const fakeSource = {
      id: 'brave',
      capabilities: ['query'],
      query: async () => [{ url: 'u', title: 't', snippet: 's', origin: 'web', sourceId: 'brave' }],
    };
    const out = await runGateway(['search', '--q', 'rust'], { resolveSlot: () => fakeSource });
    assert.equal(out.source_used, 'brave');
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0].url, 'u');
  });
  it('throws UsageError when search has no --q', async () => {
    await assert.rejects(() => runGateway(['search'], { resolveSlot: () => ({}) }), UsageError);
  });
});

describe('gateway fetch verb', () => {
  it('returns doc + source_used from the resolved fetch source', async () => {
    const fakeSource = {
      id: 'raw',
      capabilities: ['fetch'],
      fetch: async () => ({ text: 'body', ok: true, reason: 'ok' }),
    };
    const out = await runGateway(['fetch', '--url', 'https://x'], { resolveSlot: () => fakeSource });
    assert.equal(out.source_used, 'raw');
    assert.equal(out.doc.ok, true);
    assert.equal(out.doc.text, 'body');
  });
  it('throws UsageError when fetch has no --url', async () => {
    await assert.rejects(() => runGateway(['fetch'], { resolveSlot: () => ({}) }), UsageError);
  });
});

describe('gateway unknown verb', () => {
  it('throws UsageError', async () => {
    await assert.rejects(() => runGateway(['bogus'], { resolveSlot: () => ({}) }), UsageError);
  });
});
