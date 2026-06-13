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

// Track every open connection so shutdown can destroy them. server.close()
// alone stops accepting new connections but leaves a 'hang'-mode socket open,
// which keeps the event loop (and this child) alive forever — the cause of the
// CI hang when the parent SIGTERMs the server.
const open = new Set();

const server = createServer((socket) => {
  open.add(socket);
  socket.on('close', () => open.delete(socket));
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

function shutdown() {
  for (const socket of open) socket.destroy();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);

// Parent-death failsafe: if the test process that spawned us dies without
// sending SIGTERM (crash, timeout-kill), getppid() reparents us to 1. Poll for
// that and self-terminate so an orphaned server can never wedge `node --test`.
const startPpid = process.ppid;
const reaper = setInterval(() => {
  if (process.ppid !== startPpid || process.ppid === 1) shutdown();
}, 250);
reaper.unref();
