// tests/helpers/ollama-mock.mjs
// The ollama half of the network boundary: handlers for the two endpoints the
// librarian talks to, and the response shapes it expects back.
//
// The lifecycle wiring lives in ./msw.mjs; see its header for why these are
// real Responses rather than hand-written object literals.

import { http, HttpResponse, delay } from 'msw';
import { startMockNetwork } from './msw.mjs';
import { DEFAULT_OLLAMA_URL } from '../../plugin/scripts/lib/defaults.mjs';

/**
 * The base URL the librarian reaches when nothing overrides it. Imported
 * rather than restated so a change to the default cannot leave the handlers
 * silently matching an address nothing calls.
 */
export const OLLAMA_URL = DEFAULT_OLLAMA_URL;

/** @see startMockNetwork — re-exported under the name the ollama suites read. */
export const startOllamaMock = startMockNetwork;

/**
 * Handler for `POST {base}/api/chat`.
 *
 * @param {import('msw').HttpResponseResolver} resolver
 * @param {{ base?: string }} [opts]
 */
export function chat(resolver, { base = OLLAMA_URL } = {}) {
  return http.post(`${base}/api/chat`, resolver);
}

/**
 * Handler for `GET {base}/api/tags`.
 *
 * @param {import('msw').HttpResponseResolver} resolver
 * @param {{ base?: string }} [opts]
 */
export function tags(resolver, { base = OLLAMA_URL } = {}) {
  return http.get(`${base}/api/tags`, resolver);
}

/**
 * The shape ollama returns for a structured-output request: the model's answer
 * is a JSON *string* inside `message.content`, not a nested object. Tests that
 * built the envelope by hand kept getting this one level wrong.
 *
 * @param {unknown} value  Parsed value the model is pretending to have emitted.
 */
export function structured(value) {
  return HttpResponse.json({ message: { content: JSON.stringify(value) } });
}

/**
 * A 200 whose `message.content` is not JSON at all -- the case where ollama
 * ignored the schema and answered in prose.
 *
 * @param {string} content
 */
export function unstructured(content) {
  return HttpResponse.json({ message: { content } });
}

/**
 * An ollama error status. ollama answers these with a JSON body, which is what
 * makes an unchecked `res.ok` fail late and confusingly rather than at the
 * `fetch` call -- so the body is JSON here too.
 *
 * @param {number} status
 * @param {string} [message]
 */
export function httpError(status, message = 'mock ollama failure') {
  return HttpResponse.json({ error: message }, { status });
}

/**
 * A response that never arrives in time, for exercising a caller's
 * AbortSignal.timeout. `ms` must exceed the timeout under test.
 *
 * @param {number} ms
 */
export async function tooSlow(ms) {
  await delay(ms);
  return HttpResponse.json({});
}

export { HttpResponse, delay, http };
