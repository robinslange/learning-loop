import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import searxngSource from '../../plugin/scripts/lib/sources/searxng.mjs';
import { getBaseUrl } from '../../plugin/scripts/librarian/research/searxng.mjs';
import { resetForTests } from '../../plugin/scripts/lib/warn-once.mjs';

const baseUrl = 'http://localhost:8888';
const okFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ results: [{ url: 'https://a', title: 'A', content: 'snip' }] }),
});

describe('searxng query source', () => {
  it('declares query capability and web origin', () => {
    assert.deepEqual(searxngSource.capabilities, ['query']);
    assert.equal(searxngSource.origin, 'web');
    assert.equal(searxngSource.id, 'searxng');
  });

  it('normalizes searxng results to Hit shape with origin+sourceId', async () => {
    const hits = await searxngSource.query('rust async', { baseUrl, fetchOverride: okFetch });
    assert.deepEqual(hits, [
      { url: 'https://a', title: 'A', snippet: 'snip', origin: 'web', sourceId: 'searxng' },
    ]);
  });

  it('returns [] when searxng returns no results', async () => {
    const empty = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
    assert.deepEqual(await searxngSource.query('x', { baseUrl, fetchOverride: empty }), []);
  });

  it('honours count', async () => {
    const many = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 20 }, (_, i) => ({
          url: `https://a/${i}`,
          title: `T${i}`,
          content: '',
        })),
      }),
    });
    const hits = await searxngSource.query('x', { baseUrl, count: 3, fetchOverride: many });
    assert.equal(hits.length, 3);
  });

  it('queries the configured instance with format=json', async () => {
    let seen = '';
    const spy = async (u) => {
      seen = u;
      return okFetch();
    };
    await searxngSource.query('a b', { baseUrl: 'http://localhost:8888/', fetchOverride: spy });
    assert.equal(seen, 'http://localhost:8888/search?q=a%20b&format=json');
  });

  // The failure that costs an evening: JSON is off by default upstream, and the
  // instance answers 403 or 200-with-HTML. Both must say so, not just return [].
  it('names the formats misconfiguration on 403', async () => {
    resetForTests('searxng_http');
    const chunks = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => {
      chunks.push(s);
      return true;
    };
    try {
      const hits = await searxngSource.query('x', {
        baseUrl,
        fetchOverride: async () => ({ ok: false, status: 403 }),
      });
      assert.deepEqual(hits, []);
    } finally {
      process.stderr.write = write;
    }
    assert.match(chunks.join(''), /Add `json` to `formats`/);
  });

  it('names the formats misconfiguration when the body is not JSON', async () => {
    resetForTests('searxng_not_json');
    const chunks = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => {
      chunks.push(s);
      return true;
    };
    try {
      const hits = await searxngSource.query('x', {
        baseUrl,
        fetchOverride: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('not json');
          },
        }),
      });
      assert.deepEqual(hits, []);
    } finally {
      process.stderr.write = write;
    }
    assert.match(chunks.join(''), /Add `json` to `formats`/);
  });

  // Every engine refusing looks like "no matches": 200, results []. The
  // refusals ride in unresponsive_engines, so an empty page must name them.
  it('names the unresponsive engines when no results come back', async () => {
    resetForTests('searxng_engines_down');
    const chunks = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => {
      chunks.push(s);
      return true;
    };
    try {
      const hits = await searxngSource.query('x', {
        baseUrl,
        fetchOverride: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            results: [],
            unresponsive_engines: [
              ['brave', 'too many requests'],
              ['google cse', 'Suspended: too many requests'],
            ],
          }),
        }),
      });
      assert.deepEqual(hits, []);
    } finally {
      process.stderr.write = write;
    }
    assert.match(
      chunks.join(''),
      /brave: too many requests, google cse: Suspended: too many requests/,
    );
  });

  it('stays quiet when some engines fail but results still arrive', async () => {
    resetForTests('searxng_engines_down');
    const chunks = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => {
      chunks.push(s);
      return true;
    };
    try {
      const hits = await searxngSource.query('x', {
        baseUrl,
        fetchOverride: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            results: [{ url: 'https://a', title: 'A', content: 'snip' }],
            unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
          }),
        }),
      });
      assert.equal(hits.length, 1);
    } finally {
      process.stderr.write = write;
    }
    assert.equal(chunks.join(''), '');
  });

  it('reads the base url from sources.providers.searxng.url', () => {
    assert.equal(getBaseUrl({ providers: { searxng: { url: 'http://h:1' } } }), 'http://h:1');
    assert.equal(getBaseUrl({ providers: {} }), '');
  });
});
