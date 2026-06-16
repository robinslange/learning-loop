// tests/librarian-research-extract.test.mjs : extractClaims() over a source.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClaims,
  EXTRACT_FORMAT,
  EXTRACT_PROMPT,
} from '../plugin/scripts/librarian/research/extract.mjs';

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
    assert.deepEqual(out, { sourceQuality: 'unreliable', claims: [] });
  });

  it('returns empty bundle on unparseable content', async () => {
    const fetchOverride = async () => ({
      ok: true,
      json: async () => ({ message: { content: 'not json' } }),
    });
    const out = await extractClaims('t', 'q', { fetchOverride });
    assert.deepEqual(out, { sourceQuality: 'unreliable', claims: [] });
  });

  it('returns empty bundle on network throw', async () => {
    const fetchOverride = async () => {
      throw new Error('boom');
    };
    const out = await extractClaims('t', 'q', { fetchOverride });
    assert.deepEqual(out, { sourceQuality: 'unreliable', claims: [] });
  });
});
