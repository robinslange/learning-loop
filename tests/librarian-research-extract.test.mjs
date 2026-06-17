// tests/librarian-research-extract.test.mjs : extractClaims() over a source.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClaims,
  EXTRACT_FORMAT,
  EXTRACT_PROMPT,
} from '../plugin/scripts/librarian/research/extract.mjs';

const fakeFetch = (obj) => async (_url, _opts) => ({
  ok: true,
  json: async () => ({ message: { content: JSON.stringify(obj) } }),
});

describe('extract constants', () => {
  it('exports EXTRACT_FORMAT and EXTRACT_PROMPT for reuse', () => {
    assert.equal(EXTRACT_FORMAT.type, 'object');
    assert.ok(EXTRACT_PROMPT.length > 0);
  });
});

describe('extractClaims', () => {
  it('posts to ollama and returns parsed claims', async () => {
    let capturedBody;
    const fetchOverride = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              sourceQuality: 'primary',
              claims: [
                { claim: 'X causes Y', quote: 'X causes Y in trials', importance: 'central' },
              ],
            }),
          },
        }),
      };
    };
    const out = await extractClaims('body text', 'does X cause Y?', {
      model: 'gemma3:12b',
      fetchOverride,
    });
    assert.equal(out.sourceQuality, 'primary');
    assert.equal(out.claims.length, 1);
    assert.equal(capturedBody.model, 'gemma3:12b');
    assert.equal(capturedBody.format.type, 'object');
    assert.equal(capturedBody.stream, false);
  });

  it('includes keep_alive in the request body when provided', async () => {
    let capturedBody;
    const fetchOverride = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({ sourceQuality: 'blog', claims: [] }) },
        }),
      };
    };
    await extractClaims('t', 'q', { keepAlive: '30m', fetchOverride });
    assert.equal(capturedBody.keep_alive, '30m');
  });

  it('omits keep_alive when not provided', async () => {
    let capturedBody;
    const fetchOverride = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({ sourceQuality: 'blog', claims: [] }) },
        }),
      };
    };
    await extractClaims('t', 'q', { fetchOverride });
    assert.equal('keep_alive' in capturedBody, false);
  });

  it('returns empty bundle on HTTP error', async () => {
    const fetchOverride = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const out = await extractClaims('t', 'q', { fetchOverride });
    assert.deepEqual(out, { sourceQuality: 'unreliable', sourceId: null, claims: [] });
  });

  it('returns empty bundle on unparseable content', async () => {
    const fetchOverride = async () => ({
      ok: true,
      json: async () => ({ message: { content: 'not json' } }),
    });
    const out = await extractClaims('t', 'q', { fetchOverride });
    assert.deepEqual(out, { sourceQuality: 'unreliable', sourceId: null, claims: [] });
  });

  it('returns empty bundle on network throw', async () => {
    const fetchOverride = async () => {
      throw new Error('boom');
    };
    const out = await extractClaims('t', 'q', { fetchOverride });
    assert.deepEqual(out, { sourceQuality: 'unreliable', sourceId: null, claims: [] });
  });

  it('re-raises the error when throwOnError is set (so a benchmark sees real failures)', async () => {
    const fetchOverride = async () => {
      throw new Error('boom');
    };
    await assert.rejects(
      () => extractClaims('t', 'q', { fetchOverride, throwOnError: true }),
      /boom/,
    );
  });

  it('captures sourceId for an academic source', async () => {
    const res = await extractClaims('PubMed page text', 'q', {
      fetchOverride: fakeFetch({
        sourceQuality: 'primary',
        sourceId: { kind: 'pmid', id: '37541198', author: 'Smith', year: 2023 },
        claims: [{ claim: 'X', quote: 'X', importance: 'central' }],
      }),
    });
    assert.deepEqual(res.sourceId, { kind: 'pmid', id: '37541198', author: 'Smith', year: 2023 });
  });

  it('returns sourceId null for a non-academic source', async () => {
    const res = await extractClaims('blog text', 'q', {
      fetchOverride: fakeFetch({
        sourceQuality: 'blog',
        sourceId: null,
        claims: [{ claim: 'Y', quote: 'Y', importance: 'supporting' }],
      }),
    });
    assert.equal(res.sourceId, null);
  });

  it('defaults sourceId to null when the field is absent', async () => {
    const res = await extractClaims('text', 'q', {
      fetchOverride: fakeFetch({ sourceQuality: 'secondary', claims: [] }),
    });
    assert.equal(res.sourceId, null);
  });
});
