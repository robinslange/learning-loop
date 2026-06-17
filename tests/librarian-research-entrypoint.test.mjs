// tests/librarian-research-entrypoint.test.mjs : runResearch orchestration.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch, resolveModel } from '../plugin/scripts/librarian/research.mjs';

describe('resolveModel', () => {
  it('prefers an explicit model arg over config', () => {
    assert.deepEqual(resolveModel('gemma3:27b', 'gemma3:12b'), { model: 'gemma3:27b', ok: true });
  });

  it('falls back to the config model when no arg', () => {
    assert.deepEqual(resolveModel(undefined, 'gemma3:12b'), { model: 'gemma3:12b', ok: true });
  });

  it('reports ok:false when the resolved model is below the research tier', () => {
    assert.deepEqual(resolveModel(undefined, 'gemma4:e2b'), { model: 'gemma4:e2b', ok: false });
    assert.deepEqual(resolveModel('gemma3:1b', 'gemma3:12b'), { model: 'gemma3:1b', ok: false });
  });
});

describe('runResearch', () => {
  it('dedups URLs across angles, fetches, extracts, builds bundle', async () => {
    const angles = [
      { label: 'a', query: 'q1' },
      { label: 'b', query: 'q2' },
    ];
    const searchFn = async (query) =>
      query === 'q1'
        ? [
            { url: 'https://x.com', title: 'X', snippet: '' },
            { url: 'https://dup.com', title: 'D', snippet: '' },
          ]
        : [
            { url: 'https://dup.com', title: 'D', snippet: '' },
            { url: 'https://y.com', title: 'Y', snippet: '' },
          ];
    const fetchTextFn = async (url) =>
      url === 'https://y.com'
        ? { text: '', ok: false, reason: 'http_403' }
        : { text: 'body of ' + url, ok: true, reason: 'ok' };
    const extractFn = async (text) => ({
      sourceQuality: 'secondary',
      claims: [{ claim: 'c for ' + text, quote: 'q', importance: 'central' }],
    });

    const bundle = await runResearch('does q?', { angles, searchFn, fetchTextFn, extractFn });

    // 3 unique URLs (x, dup, y); y failed fetch -> skipped; x and dup extracted.
    assert.equal(bundle.sources.length, 2);
    assert.equal(bundle.skipped.length, 1);
    assert.equal(bundle.skipped[0].url, 'https://y.com');
    assert.equal(bundle.skipped[0].reason, 'http_403');
    assert.equal(bundle.claims.length, 2);
    assert.ok(bundle.claims.every((c) => c.url));
    assert.equal(bundle.question, 'does q?');
  });

  it('threads keepAlive through to extractFn', async () => {
    let seenOpts;
    const angles = [{ label: 'a', query: 'q' }];
    const searchFn = async () => [{ url: 'https://x.com', title: 'X', snippet: '' }];
    const fetchTextFn = async () => ({ text: 'body', ok: true, reason: 'ok' });
    const extractFn = async (_text, _q, opts) => {
      seenOpts = opts;
      return { sourceQuality: 'blog', claims: [] };
    };
    await runResearch('q?', { angles, keepAlive: '30m', searchFn, fetchTextFn, extractFn });
    assert.equal(seenOpts.keepAlive, '30m');
  });

  it('respects maxFetch', async () => {
    const angles = [{ label: 'a', query: 'q' }];
    const searchFn = async () =>
      Array.from({ length: 10 }, (_, i) => ({
        url: 'https://s' + i + '.com',
        title: '',
        snippet: '',
      }));
    const fetchTextFn = async () => ({ text: 'b', ok: true, reason: 'ok' });
    const extractFn = async () => ({ sourceQuality: 'blog', claims: [] });
    const bundle = await runResearch('q?', {
      angles,
      maxFetch: 3,
      searchFn,
      fetchTextFn,
      extractFn,
    });
    assert.equal(bundle.sources.length, 3);
  });

  it('fetches sources concurrently but extracts serially', async () => {
    const angles = [{ label: 'a', query: 'q' }];
    const searchFn = async () =>
      Array.from({ length: 4 }, (_, i) => ({
        url: 'https://s' + i + '.com',
        title: '',
        snippet: '',
      }));

    let fetchInFlight = 0;
    let maxFetchConcurrency = 0;
    const fetchTextFn = async () => {
      fetchInFlight++;
      maxFetchConcurrency = Math.max(maxFetchConcurrency, fetchInFlight);
      await new Promise((r) => setTimeout(r, 20));
      fetchInFlight--;
      return { text: 'body', ok: true, reason: 'ok' };
    };

    let extractInFlight = 0;
    let maxExtractConcurrency = 0;
    const extractFn = async () => {
      extractInFlight++;
      maxExtractConcurrency = Math.max(maxExtractConcurrency, extractInFlight);
      await new Promise((r) => setTimeout(r, 20));
      extractInFlight--;
      return { sourceQuality: 'blog', claims: [] };
    };

    await runResearch('q?', { angles, searchFn, fetchTextFn, extractFn });
    // Fetches overlap (I/O-bound); extracts never overlap (Ollama serializes a single model).
    assert.ok(maxFetchConcurrency > 1, `expected concurrent fetch, saw max ${maxFetchConcurrency}`);
    assert.equal(
      maxExtractConcurrency,
      1,
      `expected serial extract, saw max ${maxExtractConcurrency}`,
    );
  });

  it('preserves source/claim order regardless of fetch completion order', async () => {
    const angles = [{ label: 'a', query: 'q' }];
    const searchFn = async () =>
      Array.from({ length: 3 }, (_, i) => ({
        url: 'https://s' + i + '.com',
        title: '',
        snippet: '',
      }));
    // s0 resolves slowest, s2 fastest — output must still be s0, s1, s2.
    const delays = { 'https://s0.com': 30, 'https://s1.com': 15, 'https://s2.com': 1 };
    const fetchTextFn = async (url) => {
      await new Promise((r) => setTimeout(r, delays[url]));
      return { text: 'body', ok: true, reason: 'ok' };
    };
    const extractFn = async (_t, _q, _o) => ({ sourceQuality: 'blog', claims: [] });
    const bundle = await runResearch('q?', { angles, searchFn, fetchTextFn, extractFn });
    assert.deepEqual(
      bundle.sources.map((s) => s.url),
      ['https://s0.com', 'https://s1.com', 'https://s2.com'],
    );
  });

  it('defaults to a single angle from the question when none given', async () => {
    let seenQuery;
    const searchFn = async (q) => {
      seenQuery = q;
      return [];
    };
    const bundle = await runResearch('lone question?', { searchFn });
    assert.equal(seenQuery, 'lone question?');
    assert.equal(bundle.sources.length, 0);
    assert.equal(bundle.claims.length, 0);
    assert.equal(bundle.angles.length, 1);
  });

  it('stamps sourceId onto bundle source and each claim', async () => {
    const bundle = await runResearch('q', {
      angles: [{ label: 'a', query: 'a' }],
      searchFn: async () => [{ url: 'http://x', title: 'X', snippet: '' }],
      fetchTextFn: async () => ({ text: 'body', ok: true, reason: 'ok' }),
      extractFn: async () => ({
        sourceQuality: 'primary',
        sourceId: { kind: 'pmid', id: '1', author: 'A', year: 2020 },
        claims: [{ claim: 'c', quote: 'q', importance: 'central' }],
      }),
      maxFetch: 1,
    });
    assert.deepEqual(bundle.sources[0].sourceId, {
      kind: 'pmid',
      id: '1',
      author: 'A',
      year: 2020,
    });
    assert.deepEqual(bundle.claims[0].sourceId, { kind: 'pmid', id: '1', author: 'A', year: 2020 });
  });

  it('derives sourceId from a PubMed URL when the model extracted none', async () => {
    const bundle = await runResearch('q', {
      angles: [{ label: 'a', query: 'a' }],
      searchFn: async () => [
        { url: 'https://pubmed.ncbi.nlm.nih.gov/39070254/', title: 'X', snippet: '' },
      ],
      fetchTextFn: async () => ({
        text: 'chrome-heavy body with no visible PMID',
        ok: true,
        reason: 'ok',
      }),
      extractFn: async () => ({
        sourceQuality: 'primary',
        sourceId: null,
        claims: [{ claim: 'c', quote: 'q', importance: 'central' }],
      }),
      maxFetch: 1,
    });
    assert.deepEqual(bundle.sources[0].sourceId, {
      kind: 'pmid',
      id: '39070254',
      author: null,
      year: null,
    });
    assert.deepEqual(bundle.claims[0].sourceId, {
      kind: 'pmid',
      id: '39070254',
      author: null,
      year: null,
    });
  });

  it('prefers the URL-derived id but keeps the model author/year for the citation check', async () => {
    const bundle = await runResearch('q', {
      angles: [{ label: 'a', query: 'a' }],
      searchFn: async () => [
        { url: 'https://pubmed.ncbi.nlm.nih.gov/39070254/', title: 'X', snippet: '' },
      ],
      fetchTextFn: async () => ({ text: 'body', ok: true, reason: 'ok' }),
      extractFn: async () => ({
        sourceQuality: 'primary',
        sourceId: { kind: 'pmid', id: '99999999', author: 'Smith', year: 2020 },
        claims: [{ claim: 'c', quote: 'q', importance: 'central' }],
      }),
      maxFetch: 1,
    });
    // The URL is authoritative for the id (the model is unreliable in chrome-heavy
    // text), but the claimed author/year come from the document body and are kept so
    // the resolver can flag a citation mismatch.
    assert.deepEqual(bundle.sources[0].sourceId, {
      kind: 'pmid',
      id: '39070254',
      author: 'Smith',
      year: 2020,
    });
    assert.deepEqual(bundle.claims[0].sourceId, {
      kind: 'pmid',
      id: '39070254',
      author: 'Smith',
      year: 2020,
    });
  });
});
