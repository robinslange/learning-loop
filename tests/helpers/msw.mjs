// tests/helpers/msw.mjs
// The network boundary for node:test suites.
//
// Tests here used to replace `globalThis.fetch` with an object literal:
//
//   globalThis.fetch = async () => ({ ok: true, json: async () => ({ ... }) });
//
// Those stand-ins have no headers, no status, no body and no text() unless the
// author remembered to add one, and they answer every URL and every method
// identically. Code under test then passes for reasons production never
// reproduces -- and worse, production grew branches to tolerate them
// (`res.headers?.get?.(...)`, `typeof res.status === 'number' ? ... : 200`).
//
// MSW intercepts at the request boundary and hands back real `Response`
// objects. `onUnhandledRequest: 'error'` turns any request the test did not
// declare into a failure, which is what makes "must not fetch the loopback hop"
// assertable rather than merely counted.

import { setupServer } from 'msw/node';
import { http, HttpResponse, delay, passthrough } from 'msw';
import { after, afterEach, before } from 'node:test';

/**
 * Start an MSW server for the enclosing describe block and return it, with
 * listen/resetHandlers/close bound to before/afterEach/after. Register
 * per-test behaviour with `server.use(...)`.
 *
 * MSW patches process-global fetch, so call this at most once per test file.
 *
 * @param {...import('msw').RequestHandler} defaultHandlers
 * @returns {import('msw/node').SetupServerApi}
 */
export function startMockNetwork(...defaultHandlers) {
  const server = setupServer(...defaultHandlers);
  before(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  after(() => server.close());
  return server;
}

/**
 * Count the requests a block issues. Returns a getter rather than a number so
 * a caller can read it after the block runs.
 *
 * @param {import('msw/node').SetupServerApi} server
 * @returns {() => number}
 */
export function countRequests(server) {
  let n = 0;
  server.events.removeAllListeners();
  server.events.on('request:start', () => {
    n += 1;
  });
  return () => n;
}

/**
 * A 3xx the caller must re-check before following. Built here rather than
 * inline because `redirect: 'manual'` only tells you anything if the response
 * really carries the Location header.
 *
 * @param {string} location
 * @param {number} [status]
 */
export function redirectTo(location, status = 302) {
  return new HttpResponse(null, { status, headers: { Location: location } });
}

export { HttpResponse, delay, http, passthrough };
