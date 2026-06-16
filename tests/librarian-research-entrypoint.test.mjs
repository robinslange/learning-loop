// tests/librarian-research-entrypoint.test.mjs : runResearch orchestration.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../plugin/scripts/librarian/research.mjs';

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
});
