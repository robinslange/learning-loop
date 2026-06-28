// tests/sources-offline.test.mjs : LL_OFFLINE gates the web-research fetch leaves.
//
// All ~14 source adapters route through fetchJSON/fetchXML (sources/http.mjs)
// and page text goes through fetchPageText (sources/web-fetch.mjs). Gating the
// leaves covers every adapter. We assert the leaves short-circuit WITHOUT
// calling fetch (a tripwire fetch throws), and that the pubmed adapter — which
// imports fetchJSON — inherits the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const HTTP = JSON.stringify(new URL('../plugin/scripts/lib/sources/http.mjs', import.meta.url).href);
const WEBFETCH = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/web-fetch.mjs', import.meta.url).href,
);
const PUBMED = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/adapters/pubmed.mjs', import.meta.url).href,
);

// Run a snippet in a child with LL_OFFLINE set and a tripwire fetch installed
// before any source module is imported.
function offline(snippet) {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      globalThis.fetch = () => { throw new Error('FETCH_CALLED'); };
      ${snippet}
    `,
    ],
    { encoding: 'utf-8', env: { ...process.env, LL_OFFLINE: '1' } },
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('fetchJSON/fetchXML return null offline without calling fetch', () => {
  const r = offline(`
    const { fetchJSON, fetchXML } = await import(${HTTP});
    const j = await fetchJSON('https://example.com/x.json');
    const x = await fetchXML('https://example.com/x.xml');
    console.log(JSON.stringify({ j, x }));
  `);
  assert.equal(r.j, null);
  assert.equal(r.x, null);
});

test('fetchPageText returns {ok:false, kind:"offline"} without calling fetch', () => {
  const r = offline(`
    const { fetchPageText } = await import(${WEBFETCH});
    const res = await fetchPageText('https://example.com/page');
    console.log(JSON.stringify(res));
  `);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'offline');
});

test('pubmed adapter inherits the offline gate via the shared leaf', () => {
  // pubmed.fetchById -> fetchJSON/fetchXML. Offline, it must resolve to a
  // no-result shape rather than throwing on the tripwire fetch.
  const r = offline(`
    const pubmed = (await import(${PUBMED})).default;
    let threw = false, result = null;
    try { result = await pubmed.fetchById('12345678'); }
    catch (e) { threw = e.message; }
    console.log(JSON.stringify({ threw, isNullish: result == null }));
  `);
  assert.equal(r.threw, false, 'adapter must not throw on the tripwire fetch when offline');
  assert.equal(r.isNullish, true, 'offline adapter fetch yields no metadata');
});
