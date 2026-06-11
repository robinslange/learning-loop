// tests/edge-infer-nli-daemon.test.mjs
//
// Exercises the NLI daemon UDS path in runNliBatch (hooks/modules/edge-infer.mjs):
//   1. Happy path — daemon answers with a valid envelope; subprocess never spawned.
//   2. ECONNREFUSED-style socket error — daemon path falls through silently to
//      the subprocess stub (no warn, no schema-mismatch log).
//   3. Schema mismatch (bare array) — NLI suppressed for this fire, warn-once
//      stderr message emitted on first hit only.
//   4. Response timeout — daemon accepts but never responds; first hit logs
//      the daemon.timeout scope ONCE (5000ms outer timer), subsequent hits
//      silent; subprocess fallback fires both times.
//
// The four tests share this file's process, so the module-level warn-once
// latches inside edge-infer.mjs (daemonSchemaMismatchWarned,
// daemonHardFailureWarned) persist across tests in declaration order. Tests 1
// and 2 do not touch either latch (happy path / silent-fallback branches), so
// tests 3 and 4 see pristine latches and can verify the "warn the first time,
// silent the second time" contract. node:test runs each file in its own
// process, so the latch state does not leak to other suites.
//
// Subprocess detection: every test points CLAUDE_PLUGIN_DATA at its own temp
// dir with a stub `bin/ll-search` that (a) `touch`es a sentinel file when run
// and (b) emits the schema_version=1 envelope so the subprocess fallback
// produces a real NLI edge. Tests assert on sentinel presence/absence to prove
// whether the daemon or subprocess path served the request.
//
// UDS socket paths on macOS have a ~104-char limit, so each server listens on
// `<pluginData>/nli.sock` (mkdtempSync under tmpdir() stays under that limit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runEdgeInfer } from '../hooks/modules/edge-infer.mjs';
import { __resetBinaryCacheForTesting } from '../scripts/lib/binary.mjs';

// These tests fork the real ll-search stub to exercise the daemon->subprocess
// fallback. The production 1500ms execFileSync budget is too tight under a
// saturating parallel suite (the stub spawn itself can exceed it), so the test
// raises it. 5000ms is a generous-but-bounded margin for stub-fork latency now
// that the Gatekeeper-saturation source (sandbox binary copies) is fixed.
// Production is unaffected — it never sets this var.
process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS = process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS || '5000';

const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;
const NOTE_REL = '0-inbox/rebuttal-note.md';
const NOTE_ABS = join(VAULT, NOTE_REL);

function buildMinimalSnapshot(vaultRoot) {
  const notes = [
    { folder: '3-permanent', basename: 'sleep', rel_path: '3-permanent/sleep.md' },
    { folder: '3-permanent', basename: 'circadian', rel_path: '3-permanent/circadian.md' },
    { folder: '0-inbox', basename: 'fresh-capture', rel_path: '0-inbox/fresh-capture.md' },
    { folder: '0-inbox', basename: 'orphan', rel_path: '0-inbox/orphan.md' },
  ];
  return {
    version: 1,
    vault_root: vaultRoot,
    built_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30_000).toISOString(),
    notes,
    relPathSet: new Set(notes.map((n) => n.rel_path)),
  };
}

// Stub ll-search nli-batch: touch a sentinel ($PLUGIN_DATA/stub-invoked) so the
// test can detect whether the subprocess was spawned, then emit the wrapped
// envelope the production binary returns.
function nliStubScript(sentinelPath) {
  return [
    '#!/bin/sh',
    `: > ${JSON.stringify(sentinelPath)}`,
    'hyps_file="$3"',
    'printf \'{"schema_version":1,"results":[\'',
    'i=0',
    'while IFS= read -r line || [ -n "$line" ]; do',
    '  if [ $i -gt 0 ]; then printf ","; fi',
    '  printf \'{"contradiction":0.97,"entailment":0.02,"neutral":0.01,"label":"contradiction"}\'',
    '  i=$((i+1))',
    'done < "$hyps_file"',
    'printf "]}"',
  ].join('\n');
}

// Per-test env: temp dir, stub binary with sentinel, edges.db seeded with one
// prior regex edge (so we can prove regex survives independent of daemon work).
async function makeDaemonTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'll-nli-daemon-'));
  const sentinel = join(dir, 'stub-invoked');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const binPath = join(dir, 'bin', 'll-search');
  writeFileSync(binPath, nliStubScript(sentinel));
  chmodSync(binPath, 0o755);

  const dbPath = join(dir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, {
    fromPath: NOTE_REL,
    toPath: '3-permanent/sleep.md',
    edgeType: 'supports',
    confidence: 'high',
    sourceGraph: 'local',
    directionFlipped: 0,
  });
  saveDb(db, dbPath);
  db.close();

  return { dir, sentinel, dbPath, socketPath: join(dir, 'nli.sock') };
}

function nliOnlyCtx() {
  return {
    tool: 'Write',
    input: {
      file_path: NOTE_ABS,
      content: '---\ntags: [test]\n---\n\nSleep disrupts circadian rhythm entrainment.\n',
    },
    response: { success: true },
    vaultRoot: VAULT,
    snapshot: buildMinimalSnapshot(VAULT),
    autolinkCandidates: [{ path: '3-permanent/circadian.md', score: 0.7 }],
  };
}

// Spin up a UDS server with the given connection handler. Returns
// { server, close } where close() awaits a clean shutdown.
// Tracks all open sockets and destroys them on close so server.close() doesn't
// hang waiting for a half-open peer (matters in the response-timeout test
// where the daemon-side socket stays open after the client times out).
function startUdsServer(socketPath, onConnection) {
  return new Promise((resolve, reject) => {
    const openSockets = new Set();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
      onConnection(socket);
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        server,
        close: () =>
          new Promise((res) => {
            for (const s of openSockets) {
              try {
                s.destroy();
              } catch {
                /* best effort */
              }
            }
            server.close(() => res());
          }),
      });
    });
  });
}

// Capture process.stderr.write output during fn(). Returns the captured text.
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

async function readNliRows(dbPath) {
  const db = await openEdgeDb(dbPath);
  try {
    const result = db.exec(
      `SELECT to_path, edge_type, source_graph, confidence_score FROM edges WHERE from_path = '${NOTE_REL}' AND source_graph = 'nli' ORDER BY to_path`,
    );
    return result.length > 0 ? result[0].values : [];
  } finally {
    db.close();
  }
}

test('runEdgeInfer NLI daemon: happy path — daemon answers, subprocess NOT spawned', async () => {
  const env = await makeDaemonTestEnv();
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  let server;
  try {
    process.env.CLAUDE_PLUGIN_DATA = env.dir;
    __resetBinaryCacheForTesting();

    server = await startUdsServer(env.socketPath, (socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          socket.write(
            JSON.stringify({
              schema_version: 1,
              results: [
                { contradiction: 0.97, entailment: 0.02, neutral: 0.01, label: 'contradiction' },
              ],
            }) + '\n',
          );
          socket.end();
        }
      });
      socket.on('error', () => {
        /* test-server best effort */
      });
    });

    await runEdgeInfer(nliOnlyCtx());

    assert.equal(
      existsSync(env.sentinel),
      false,
      'subprocess stub must NOT be spawned when daemon answers',
    );

    const rows = await readNliRows(env.dbPath);
    assert.equal(rows.length, 1, `expected 1 NLI edge from daemon; got: ${JSON.stringify(rows)}`);
    assert.equal(rows[0][0], '3-permanent/circadian.md');
    assert.equal(rows[0][1], 'challenges_rebuttal');
    assert.equal(rows[0][2], 'nli');
    assert.ok(
      typeof rows[0][3] === 'number' && Math.abs(rows[0][3] - 0.97) < 1e-6,
      `confidence_score must be ~0.97; got ${rows[0][3]}`,
    );
  } finally {
    if (server) await server.close();
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    __resetBinaryCacheForTesting();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('runEdgeInfer NLI daemon: socket-error — silent fallback to subprocess', async () => {
  // Plant an empty regular file at nli.sock so existsSync(socketPath) succeeds
  // but createConnection({path}) raises ENOTSOCK/ECONNREFUSED. The hook
  // classifies this as 'socket-error' and falls through to subprocess WITHOUT
  // logging (silent branch in runNliBatch).
  const env = await makeDaemonTestEnv();
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = env.dir;
    __resetBinaryCacheForTesting();
    writeFileSync(env.socketPath, '');

    const stderr = await captureStderr(async () => {
      await runEdgeInfer(nliOnlyCtx());
    });

    assert.equal(
      existsSync(env.sentinel),
      true,
      'subprocess stub must be spawned when daemon socket errors',
    );
    assert.equal(
      stderr.includes('schemaMismatch'),
      false,
      `no schemaMismatch should be logged on socket-error; stderr: ${stderr}`,
    );
    assert.equal(
      stderr.includes('edge-infer.runNliBatch.daemon.'),
      false,
      `no daemon hard-failure should be logged on socket-error; stderr: ${stderr}`,
    );

    const rows = await readNliRows(env.dbPath);
    assert.equal(
      rows.length,
      1,
      `expected 1 NLI edge from subprocess fallback; got: ${JSON.stringify(rows)}`,
    );
    assert.equal(rows[0][1], 'challenges_rebuttal');
    assert.equal(rows[0][2], 'nli');
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    __resetBinaryCacheForTesting();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('runEdgeInfer NLI daemon: schema mismatch suppresses NLI + warns once', async () => {
  // Daemon returns a bare array (pre-envelope binary). validateNliEnvelope
  // rejects it, NLI is suppressed for this fire, and the warn-once stderr
  // sentence fires on the first invocation only. Both invocations must write
  // zero NLI edges (no subprocess fallback on schema mismatch — that would
  // reload the model every write).
  const env = await makeDaemonTestEnv();
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  let server;
  try {
    process.env.CLAUDE_PLUGIN_DATA = env.dir;
    __resetBinaryCacheForTesting();

    server = await startUdsServer(env.socketPath, (socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          socket.write(
            JSON.stringify([
              { contradiction: 0.97, entailment: 0.02, neutral: 0.01, label: 'contradiction' },
            ]) + '\n',
          );
          socket.end();
        }
      });
      socket.on('error', () => {
        /* test-server best effort */
      });
    });

    const stderr1 = await captureStderr(async () => {
      await runEdgeInfer(nliOnlyCtx());
    });
    const stderr2 = await captureStderr(async () => {
      await runEdgeInfer(nliOnlyCtx());
    });

    const rows = await readNliRows(env.dbPath);
    assert.equal(
      rows.length,
      0,
      `schema mismatch must suppress NLI edges across both fires; got: ${JSON.stringify(rows)}`,
    );

    // schemaMismatch JSON log fires every time validateNliEnvelope rejects (it
    // is a structured logError, not the warn-once stderr sentence). The
    // user-facing warn-once sentence is the contract under test.
    const warnOncePhrase = 'NLI daemon returned mismatched schema envelope';
    assert.ok(
      stderr1.includes(warnOncePhrase),
      `first invocation must emit warn-once stderr sentence; stderr1: ${stderr1}`,
    );
    assert.equal(
      stderr2.includes(warnOncePhrase),
      false,
      `second invocation must NOT re-emit warn-once; stderr2: ${stderr2}`,
    );
  } finally {
    if (server) await server.close();
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    __resetBinaryCacheForTesting();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('runEdgeInfer NLI daemon: response-timeout logs once + falls through to subprocess', async () => {
  // Daemon accepts the connection but never writes a byte back. The 'connect'
  // handler clears the 50ms initial idle-timeout via socket.setTimeout(0), so
  // the post-connect path is governed by the 5000ms outer timer → resolves
  // with reason='timeout'. First call logs edge-infer.runNliBatch.daemon.timeout,
  // sets the warn-once latch, and falls through to the subprocess stub.
  // Second call falls through silently (still spawns subprocess). Both calls
  // produce one NLI edge via the subprocess.
  //
  // The DB already has a row from the first call when the second runs;
  // removeOutgoingNliEdges in the NLI-only branch wipes it before the second
  // INSERT, so the final state is exactly one NLI edge with the subprocess
  // sentinel touched (idempotent — sentinel exists is the assertion).
  const env = await makeDaemonTestEnv();
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  let server;
  try {
    process.env.CLAUDE_PLUGIN_DATA = env.dir;
    __resetBinaryCacheForTesting();

    server = await startUdsServer(env.socketPath, (socket) => {
      // Accept, then sit silent. Hold the socket open until the client closes.
      socket.on('error', () => {
        /* test-server best effort */
      });
    });

    const stderr1 = await captureStderr(async () => {
      await runEdgeInfer(nliOnlyCtx());
    });
    assert.equal(
      existsSync(env.sentinel),
      true,
      'subprocess stub must be spawned after idle-timeout fallback',
    );

    // Reset sentinel so second invocation can prove fallback fired again.
    rmSync(env.sentinel);
    const stderr2 = await captureStderr(async () => {
      await runEdgeInfer(nliOnlyCtx());
    });
    assert.equal(
      existsSync(env.sentinel),
      true,
      'second invocation must also fall through to subprocess',
    );

    const timeoutScope = 'edge-infer.runNliBatch.daemon.timeout';
    assert.ok(
      stderr1.includes(timeoutScope),
      `first invocation must log daemon.timeout scope; stderr1: ${stderr1}`,
    );
    assert.equal(
      stderr2.includes(timeoutScope),
      false,
      `second invocation must NOT re-log daemon.timeout (warn-once latch); stderr2: ${stderr2}`,
    );

    const rows = await readNliRows(env.dbPath);
    assert.equal(
      rows.length,
      1,
      `expected exactly 1 NLI edge after two subprocess fallbacks; got: ${JSON.stringify(rows)}`,
    );
    assert.equal(rows[0][1], 'challenges_rebuttal');
    assert.equal(rows[0][2], 'nli');
  } finally {
    if (server) await server.close();
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    __resetBinaryCacheForTesting();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
