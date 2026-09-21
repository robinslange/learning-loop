// tests/helpers/otlp-sink.mjs : throwaway OTLP/HTTP receiver for tests.
//
// Stands in for Alloy: accepts a POST body, parses it as JSON, and records it
// so a test can assert on exactly what export.mjs sent, with no network and
// no Pi. It proves reduction and schema conformance, not wire-format
// acceptance by a real OTLP receiver (see docs/plans/otel-consolidation.md,
// "Verifying before the Pi exists"): a malformed dataPoints shape or wrong
// value-type wrapper is invisible here because this sink accepts any JSON.

import { createServer } from 'node:http';

/**
 * Starts a local HTTP server that records every POST body as parsed JSON.
 * @param {object} [opts]
 * @param {number} [opts.status] status code to respond with (default 200)
 * @returns {Promise<{url: string, received: object[], close: () => Promise<void>}>}
 */
export function startOtlpSink({ status = 200 } = {}) {
  const received = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
