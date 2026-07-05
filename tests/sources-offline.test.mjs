// tests/sources-offline.test.mjs : LL_OFFLINE gates the web-research fetch leaves.
//
// All ~14 source adapters route through fetchJSON/fetchXML (sources/http.mjs)
// and page text goes through fetchPageText (sources/web-fetch.mjs). The source
// gateway's search/fetch verbs route through two further leaves that call fetch
// directly: web-search.mjs (brave) and fetch-source.mjs (raw). Gating all four
// leaves covers every egress path. We assert each short-circuits WITHOUT calling
// fetch (a tripwire fetch throws), and that the pubmed adapter, which imports
// fetchJSON, inherits the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const HTTP = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/http.mjs', import.meta.url).href,
);
const WEBFETCH = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/web-fetch.mjs', import.meta.url).href,
);
const PUBMED = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/adapters/pubmed.mjs', import.meta.url).href,
);
const FETCHSRC = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/fetch-source.mjs', import.meta.url).href,
);
const WEBSEARCH = JSON.stringify(
  new URL('../plugin/scripts/lib/sources/web-search.mjs', import.meta.url).href,
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

// The source-gateway's search/fetch verbs resolve to these two web leaves; they call
// globalThis.fetch directly (not the shared http.mjs leaf), so they need their own gate.
test('gateway fetch source returns {ok:false, reason:"offline"} without calling fetch', () => {
  const r = offline(`
    const rawFetch = (await import(${FETCHSRC})).default;
    const doc = await rawFetch.fetch('https://example.com/page');
    console.log(JSON.stringify(doc));
  `);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'offline');
});

test('gateway brave search returns [] without calling fetch when offline', () => {
  const r = offline(`
    const brave = (await import(${WEBSEARCH})).default;
    const hits = await brave.query('anything', { apiKey: 'x' });
    console.log(JSON.stringify({ hits }));
  `);
  assert.deepEqual(r.hits, []);
});
