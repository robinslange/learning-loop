import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, http, startMockNetwork } from '../helpers/msw.mjs';

const API = 'https://www.rfc-editor.org/rfc/:file';
const server = startMockNetwork();

const RFC_RESPONSE = {
  title: 'Hypertext Transfer Protocol',
  authors: [{ name: 'Roy Fielding' }, { name: 'Jim Gettys' }],
  pub_date: 'June 1999',
  pub_status: 'DRAFT STANDARD',
  abstract: 'The Hypertext Transfer Protocol (HTTP) is an application-level protocol.',
};

describe('rfc adapter', () => {
  let adapter;

  before(async () => {
    adapter = (await import('../../plugin/scripts/lib/sources/adapters/rfc.mjs')).default;
  });

  it('fetchById returns metadata on success', async () => {
    server.use(http.get(API, () => HttpResponse.json(RFC_RESPONSE)));
    const data = await adapter.fetchById('2616');
    assert.equal(data.source, 'rfc');
    assert.equal(data.rfcNumber, 2616);
    assert.equal(data.title, 'Hypertext Transfer Protocol');
    assert.ok(data.authors.includes('Roy Fielding'));
    assert.equal(data.year, 1999);
    assert.equal(data.studyType, 'standard');
    assert.equal(data.journal, 'IETF RFC');
  });

  it('fetchById returns null on 404', async () => {
    server.use(http.get(API, () => new HttpResponse('Not Found', { status: 404 })));
    const data = await adapter.fetchById('99999');
    assert.equal(data, null);
  });

  it('verify returns verified:true on success', async () => {
    server.use(http.get(API, () => HttpResponse.json(RFC_RESPONSE)));
    const result = await adapter.verify({ rfcNumber: '2616' });
    assert.equal(result.verified, true);
    assert.deepEqual(result.issues, []);
  });

  it('verify returns error on 404', async () => {
    server.use(http.get(API, () => new HttpResponse('Not Found', { status: 404 })));
    const result = await adapter.verify({ rfcNumber: '99999' });
    assert.equal(result.verified, false);
    assert.ok(result.error);
    assert.equal(result.metadata, null);
  });
});
