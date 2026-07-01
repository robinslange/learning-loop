import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import rawFetch from '../../plugin/scripts/lib/sources/fetch-source.mjs';

const fetchOverride = async () => ({
  ok: true, status: 200,
  headers: { get: (h) => (h === 'content-type' ? 'text/html' : null) },
  text: async () => '<p>hi</p>',
});

describe('raw fetch source', () => {
  it('declares fetch capability', () => {
    assert.deepEqual(rawFetch.capabilities, ['fetch']);
  });
  it('returns a Doc {text,ok,reason}', async () => {
    const doc = await rawFetch.fetch('https://x', { fetchOverride });
    assert.equal(doc.ok, true);
    assert.match(doc.text, /hi/);
    assert.equal(doc.reason, 'ok');
  });
});
