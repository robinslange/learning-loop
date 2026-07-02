import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGateway, UsageError, __resetFetchCount } from '../../plugin/bin/source-gateway.mjs';

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

describe('gateway research verb (full bundle)', () => {
  it('returns the full runResearch bundle and passes angles/maxFetch through', async () => {
    let seen;
    const fakeBundle = {
      question: 'q',
      angles: [{ label: 'a', query: 'a' }],
      sources: [{ url: 'u' }],
      claims: [{ claim: 'c' }],
      skipped: [{ url: 's', reason: 'non_html' }],
      source_used: { search: 'brave', fetch: 'raw' },
    };
    const orchestrateResearch = async (q, opts) => {
      seen = { q, ...opts };
      return { bundle: fakeBundle, exitCode: 0 };
    };
    const out = await runGateway(
      ['research', '--q', 'rust', '--angles', JSON.stringify([{ label: 'a', query: 'a' }]), '--max-fetch', '5'],
      { orchestrateResearch },
    );
    assert.deepEqual(out, fakeBundle);
    assert.equal(seen.q, 'rust');
    assert.deepEqual(seen.angles, [{ label: 'a', query: 'a' }]);
    assert.equal(seen.maxFetch, 5);
  });
  it('exits 3-signal when the model is below the research tier', async () => {
    const orchestrateResearch = async () => ({ bundle: null, exitCode: 3, model: 'gemma3:e2b' });
    await assert.rejects(
      () => runGateway(['research', '--q', 'x'], { orchestrateResearch }),
      (e) => e.exitCode === 3,
    );
  });
  it('throws UsageError when research has no --q', async () => {
    await assert.rejects(() => runGateway(['research'], {}), UsageError);
  });
});

describe('gateway fetch budget', () => {
  it('refuses fetch past the budget', async () => {
    __resetFetchCount();
    const fakeSource = { id: 'raw', capabilities: ['fetch'], fetch: async () => ({ text: 'x', ok: true, reason: 'ok' }) };
    const deps = { resolveSlot: () => fakeSource, fetchBudget: 1 };
    const first = await runGateway(['fetch', '--url', 'https://a'], deps);
    assert.equal(first.doc.ok, true); // first fetch under budget
    const second = await runGateway(['fetch', '--url', 'https://b'], deps);
    assert.equal(second.doc.ok, false);
    assert.equal(second.doc.reason, 'fetch_budget_exceeded');
    assert.equal(second.source_used, 'raw'); // source_used still populated on refusal
  });
  it('does not consume budget on search/research verbs', async () => {
    __resetFetchCount();
    const fakeQuery = { id: 'brave', query: async () => [] };
    await runGateway(['search', '--q', 'x'], { resolveSlot: () => fakeQuery, fetchBudget: 1 });
    // budget untouched by search -> a subsequent fetch still succeeds
    const fakeFetch = { id: 'raw', fetch: async () => ({ text: 'y', ok: true, reason: 'ok' }) };
    const out = await runGateway(['fetch', '--url', 'https://a'], { resolveSlot: () => fakeFetch, fetchBudget: 1 });
    assert.equal(out.doc.ok, true);
  });
});
