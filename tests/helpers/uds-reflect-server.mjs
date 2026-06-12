// tests/helpers/uds-reflect-server.mjs
// Standalone UDS server that mimics the ll-search watch daemon's duplicate-scan
// wire contract for pre-write-check tests. Spawned as a child process so the
// hook-under-test (itself a spawned subprocess) can reach the socket.
//
// argv: <socketPath> <mode>
//   mode = "respond:<base64-json>"  -> reply with the decoded reflect envelope
//   mode = "hang"                   -> accept the request but never respond
//                                      (exercises the timeout path)
//   mode = "stale-daemon"           -> reply with the old-daemon error envelope
//                                      ({schema_version:1,error:'parse request: ...'})
//                                      to exercise the stale-daemon detection path
//
// Reads one line-delimited JSON request per connection (the duplicate-scan
// envelope) and writes one line-delimited JSON response, matching the daemon.

import { createServer } from 'node:net';
import { existsSync, rmSync } from 'node:fs';

const [, , socketPath, mode] = process.argv;

if (existsSync(socketPath)) {
  try {
    rmSync(socketPath);
  } catch {
    /* ignore */
  }
}

const server = createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    if (!buffer.includes('\n')) return;
    if (mode === 'hang') return; // accept but never respond
    if (mode === 'stale-daemon') {
      // Mimics an old daemon binary that can't handle duplicate-scan requests.
      const envelope = JSON.stringify({ schema_version: 1, error: 'parse request: unknown kind' });
      socket.write(envelope + '\n');
      socket.end();
      return;
    }
    if (mode.startsWith('respond:')) {
      const payload = Buffer.from(mode.slice('respond:'.length), 'base64').toString('utf-8');
      socket.write(payload + '\n');
      socket.end();
    }
  });
});

server.listen(socketPath, () => {
  // Tell the parent the socket is live so it can stop polling.
  process.stdout.write('listening\n');
});

process.on('SIGTERM', () => {
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
