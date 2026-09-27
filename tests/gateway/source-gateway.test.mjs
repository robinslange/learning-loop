import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGateway, UsageError } from '../../plugin/bin/source-gateway.mjs';
import { readCount } from '../../plugin/scripts/lib/fetch-budget.mjs';

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
    const out = await runGateway(['fetch', '--url', 'https://x'], {
      resolveSlot: () => fakeSource,
      sessionId: '',
      pluginData: null,
    });
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
      [
        'research',
        '--q',
        'rust',
        '--angles',
        JSON.stringify([{ label: 'a', query: 'a' }]),
        '--max-fetch',
        '5',
      ],
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

function tmpSession() {
  return {
    sessionId: 'gateway-test-session',
    pluginData: mkdtempSync(join(tmpdir(), 'gateway-budget-')),
  };
}

describe('gateway fetch budget', () => {
  const okSource = { id: 'raw', fetch: async () => ({ text: 'x', ok: true, reason: 'ok' }) };

  it('lets exactly `budget` fetches through per session, refusing the rest', async () => {
    const session = tmpSession();
    const deps = { resolveSlot: () => okSource, fetchBudget: 3, ...session };
    const outs = [];
    for (let i = 0; i < 6; i++) {
      outs.push(await runGateway(['fetch', '--url', `https://example.com/${i}`], deps));
    }
    assert.deepEqual(
      outs.map((o) => o.doc.ok),
      [true, true, true, false, false, false],
    );
    assert.equal(outs[5].doc.reason, 'fetch_budget_exceeded');
    assert.equal(outs[5].source_used, 'raw');
    rmSync(session.pluginData, { recursive: true, force: true });
  });

  it('does not consume budget on search/research verbs', async () => {
    const session = tmpSession();
    await runGateway(['search', '--q', 'x'], {
      resolveSlot: () => ({ id: 'brave', query: async () => [] }),
      ...session,
    });
    assert.equal(readCount(session.sessionId, session.pluginData), 0);
    rmSync(session.pluginData, { recursive: true, force: true });
  });

  it('skips enforcement when there is no session to count against', async () => {
    const out = await runGateway(['fetch', '--url', 'https://example.com/c'], {
      resolveSlot: () => okSource,
      fetchBudget: 0,
      sessionId: '',
      pluginData: null,
    });
    assert.equal(out.doc.ok, true);
  });
});
