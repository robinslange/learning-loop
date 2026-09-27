import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import rawFetch from '../../plugin/scripts/lib/sources/fetch-source.mjs';
import { HttpResponse, http, startMockNetwork } from '../helpers/msw.mjs';

const server = startMockNetwork();

describe('raw fetch source', () => {
  it('declares fetch capability', () => {
    assert.deepEqual(rawFetch.capabilities, ['fetch']);
  });
  it('returns a Doc {text,ok,reason}', async () => {
    server.use(http.get('https://x.example.com/', () => HttpResponse.html('<p>hi</p>')));
    const doc = await rawFetch.fetch('https://x.example.com/');
    assert.equal(doc.ok, true);
    assert.match(doc.text, /hi/);
    assert.equal(doc.reason, 'ok');
  });
});
