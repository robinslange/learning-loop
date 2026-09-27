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
// objects. A request the test did not declare fails that test. MSW on its own
// only rejects the fetch, and code that catches network errors turns the
// rejection into an ordinary `{ ok: false }`, so every unhandled request is
// recorded here and the recording is asserted empty after each test.

import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import assert from 'node:assert/strict';
import { after, afterEach, before } from 'node:test';

let requestsStarted = 0;

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
  const unhandled = [];
  server.events.on('request:start', () => {
    requestsStarted += 1;
  });
  before(() =>
    server.listen({
      onUnhandledRequest(request, print) {
        unhandled.push(`${request.method} ${request.url}`);
        print.error();
      },
    }),
  );
  afterEach(() => {
    server.resetHandlers();
    assert.deepEqual(unhandled.splice(0), [], 'requests no handler declared');
  });
  after(() => server.close());
  return server;
}

/**
 * Count the requests issued from now on. Returns a getter rather than a number
 * so a caller can read it after the block runs.
 *
 * @returns {() => number}
 */
export function countRequests() {
  const from = requestsStarted;
  return () => requestsStarted - from;
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

/**
 * A real Response whose body records whether anything pulled it, for cases that
 * must reject on headers alone. Not served through MSW: MSW reads every mocked
 * body itself to emit its response events, so a pull there proves nothing.
 * highWaterMark 0 keeps the stream from pulling before a reader asks.
 *
 * @param {Record<string, string>} headers
 * @returns {{ response: Response, bodyRead: () => boolean }}
 */
export function lazyResponse(headers) {
  let read = false;
  const body = new ReadableStream(
    {
      pull(c) {
        read = true;
        c.enqueue(new TextEncoder().encode('never reached'));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body, { headers }), bodyRead: () => read };
}

export { HttpResponse, http };
