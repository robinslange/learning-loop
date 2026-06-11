// tests/edge-infer-nli-subprocess-failures.test.mjs
//
// Exercises the failure paths inside runNliBatch (hooks/modules/edge-infer.mjs).
// The happy-path is covered by edge-infer-wikilink-removal-integration.test.mjs;
// this file covers what happens when the NLI subprocess misbehaves: timeouts,
// non-zero exits, malformed JSON, schema-version mismatches, and a missing
// binary. The contract under test: runEdgeInfer never crashes, NLI edges are
// suppressed when the subprocess fails, and any regex edges produced earlier
// in the same invocation survive.
//
// Cross-test isolation: binary.mjs caches the resolved binary path module-wide
// (positive results only — null is re-evaluated each call). To swap in a
// different stub between tests within this file we (a) write all stubs to the
// same bin/ll-search path so the cached path stays valid and (b) call
// __resetBinaryCacheForTesting before tests that need a fresh lookup (the
// missing-binary test).
//
// node --test runs each test file in its own process by default, so the cache
// state set here does not leak to other suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../plugin/scripts/lib/edges.mjs';
import { runEdgeInfer } from '../plugin/hooks/modules/edge-infer.mjs';
import { __resetBinaryCacheForTesting } from '../plugin/scripts/lib/binary.mjs';

// Most tests here fork the real stub and only need it to spawn (stubs return
// immediately); under a saturating parallel suite the production 1500ms
// execFileSync budget can be exhausted by the fork alone, flaking them. Raise
// it file-wide. The one test that genuinely asserts a subprocess *timeout*
// (sleep-past-budget) sets its own tight budget locally — see that test.
// 5000ms is a generous-but-bounded margin for stub-fork latency now that the
// Gatekeeper-saturation source (sandbox binary copies) is fixed by Task 1.
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

// Shared bin directory: every stub test rewrites this same path so the cached
// binaryPath() stays valid across tests within this file.
const STUB_BIN_DIR = mkdtempSync(join(tmpdir(), 'll-nli-failures-bin-'));
const STUB_BIN_PATH = join(STUB_BIN_DIR, 'bin', 'll-search');
mkdirSync(join(STUB_BIN_DIR, 'bin'), { recursive: true });
process.on('exit', () => {
  try {
    rmSync(STUB_BIN_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function writeStub(scriptBody) {
  writeFileSync(STUB_BIN_PATH, scriptBody);
  chmodSync(STUB_BIN_PATH, 0o755);
}

// Helper: set up a fresh edges.db under STUB_BIN_DIR with one prior regex edge
// from NOTE_REL → sleep.md so we can verify post-NLI survival.
async function seedPriorRegexEdge() {
  const dbPath = join(STUB_BIN_DIR, 'edges.db');
  const db = await openEdgeDb(dbPath);
  db.run(`DELETE FROM edges WHERE from_path = '${NOTE_REL}'`);
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
  return dbPath;
}

// Helper: ctx that drives the NLI-only branch (no wikilinks → regex returns
// nothing in-invocation; nliCandidates non-empty → runNliBatch is called).
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

// Helper: ctx that fires BOTH regex (via "reinforces [[sleep]]") AND NLI.
// Use this to verify regex edges written in-invocation survive an NLI failure.
function regexAndNliCtx() {
  return {
    tool: 'Write',
    input: {
      file_path: NOTE_ABS,
      content: '---\ntags: [test]\n---\n\nThis reinforces [[sleep]] disrupts circadian.\n',
    },
    response: { success: true },
    vaultRoot: VAULT,
    snapshot: buildMinimalSnapshot(VAULT),
    autolinkCandidates: [{ path: '3-permanent/circadian.md', score: 0.7 }],
  };
}

// runEdgeInfer runs IN-PROCESS here, so logError lines land on our own
// stderr. Capture them to assert the failure CLASS, not just the shared
// end-state (a timeout also yields "no NLI edges" — these tests must not
// pass for the wrong reason).
function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return orig.call(process.stderr, chunk, ...rest);
  };
  return {
    subprocessErrors: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
        .filter((e) => e.scope === 'edge-infer.runNliBatch.subprocess'),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

// Tests are intentionally serial: they share STUB_BIN_PATH and edges.db.
// node:test runs tests within a file serially by default.

test('runEdgeInfer NLI subprocess: timeout does not crash, regex edges survive', async () => {
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const savedTimeout = process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS;
  try {
    process.env.CLAUDE_PLUGIN_DATA = STUB_BIN_DIR;
    // This test genuinely asserts the subprocess timeout path. Override the
    // file-wide generous budget with a tight one and a stub that sleeps past
    // it; execFileSync raises ETIMEDOUT, caught by the try/catch. (Short sleep
    // keeps the test fast and the margin over the budget unambiguous.)
    process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS = '500';
    writeStub(['#!/bin/sh', 'sleep 1', 'echo "should not get here"'].join('\n'));
    __resetBinaryCacheForTesting();

    const dbPath = await seedPriorRegexEdge();
    const ctx = regexAndNliCtx();

    const cap = captureStderr();
    try {
      await runEdgeInfer(ctx);
    } finally {
      cap.restore();
    }
    const errs = cap.subprocessErrors();
    assert.equal(errs.length, 1, `expected exactly one subprocess logError; got ${JSON.stringify(errs)}`);
    assert.equal(errs[0].meta.err.code, 'ETIMEDOUT', `expected a genuine timeout; got ${JSON.stringify(errs[0].meta.err)}`);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT to_path, edge_type, source_graph FROM edges WHERE from_path = '${NOTE_REL}' ORDER BY to_path`,
      );
      const rows = result.length > 0 ? result[0].values : [];

      // Regex 'supports' edge to sleep.md written in this invocation must
      // survive (NLI failure must not roll back regex work).
      const regexEdge = rows.find((r) => r[0] === '3-permanent/sleep.md');
      assert.ok(regexEdge, `regex edge to sleep.md missing; rows: ${JSON.stringify(rows)}`);
      assert.equal(regexEdge[1], 'supports');
      assert.equal(regexEdge[2], 'local');

      // No NLI edges should be written on timeout.
      const nliRows = rows.filter((r) => r[2] === 'nli');
      assert.equal(
        nliRows.length,
        0,
        `expected no NLI edges after timeout; got: ${JSON.stringify(nliRows)}`,
      );
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    if (savedTimeout === undefined) delete process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS;
    else process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS = savedTimeout;
  }
});

test('runEdgeInfer NLI subprocess: non-zero exit writes no NLI edges, no crash', async () => {
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = STUB_BIN_DIR;
    writeStub(['#!/bin/sh', 'echo "garbage to stderr — onnx crash etc" 1>&2', 'exit 1'].join('\n'));
    __resetBinaryCacheForTesting();

    const dbPath = await seedPriorRegexEdge();
    const ctx = nliOnlyCtx();

    const cap = captureStderr();
    try {
      await runEdgeInfer(ctx);
    } finally {
      cap.restore();
    }
    const errs = cap.subprocessErrors();
    assert.equal(errs.length, 1, `expected exactly one subprocess logError; got ${JSON.stringify(errs)}`);
    assert.notEqual(errs[0].meta.err.code, 'ETIMEDOUT', 'must be an exit-status failure, not a timeout masquerading as one');
    assert.match(errs[0].meta.err.message, /Command failed/, `expected execFileSync exit-status error; got ${JSON.stringify(errs[0].meta.err)}`);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT to_path, source_graph FROM edges WHERE from_path = '${NOTE_REL}'`,
      );
      const rows = result.length > 0 ? result[0].values : [];

      // Prior regex edge survives (NLI-only branch never wiped it).
      const regexEdge = rows.find((r) => r[0] === '3-permanent/sleep.md');
      assert.ok(regexEdge, `prior regex edge to sleep.md missing; rows: ${JSON.stringify(rows)}`);
      assert.equal(regexEdge[1], 'local');

      // No NLI edges were written.
      const nliRows = rows.filter((r) => r[1] === 'nli');
      assert.equal(
        nliRows.length,
        0,
        `expected no NLI edges after non-zero exit; got: ${JSON.stringify(nliRows)}`,
      );
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  }
});

test('runEdgeInfer NLI subprocess: malformed JSON output writes no NLI edges, no crash', async () => {
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = STUB_BIN_DIR;
    // Subprocess exits 0 but stdout is unparseable. JSON.parse throws, caught
    // by the runNliBatch try/catch.
    writeStub(['#!/bin/sh', 'printf "not valid json"'].join('\n'));
    __resetBinaryCacheForTesting();

    const dbPath = await seedPriorRegexEdge();
    const ctx = nliOnlyCtx();

    const cap = captureStderr();
    try {
      await runEdgeInfer(ctx);
    } finally {
      cap.restore();
    }
    const errs = cap.subprocessErrors();
    assert.equal(errs.length, 1, `expected exactly one subprocess logError; got ${JSON.stringify(errs)}`);
    assert.equal(errs[0].meta.err.name, 'SyntaxError', `expected a JSON parse failure; got ${JSON.stringify(errs[0].meta.err)}`);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT to_path, source_graph FROM edges WHERE from_path = '${NOTE_REL}'`,
      );
      const rows = result.length > 0 ? result[0].values : [];
      const nliRows = rows.filter((r) => r[1] === 'nli');
      assert.equal(
        nliRows.length,
        0,
        `expected no NLI edges after malformed JSON; got: ${JSON.stringify(nliRows)}`,
      );
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  }
});

test('runEdgeInfer NLI subprocess: bare-array (pre-v1 schema) writes no NLI edges, no crash', async () => {
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = STUB_BIN_DIR;
    // Pre-handshake binary format: a bare array of result objects, no
    // schema_version envelope. runNliBatch must refuse to interpret it.
    // See edge-infer.mjs:221-235 for the schema-mismatch check.
    writeStub(
      [
        '#!/bin/sh',
        'printf \'[{"contradiction":0.97,"entailment":0.02,"neutral":0.01,"label":"contradiction"}]\'',
      ].join('\n'),
    );
    __resetBinaryCacheForTesting();

    const dbPath = await seedPriorRegexEdge();
    const ctx = nliOnlyCtx();

    await runEdgeInfer(ctx);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT to_path, source_graph FROM edges WHERE from_path = '${NOTE_REL}'`,
      );
      const rows = result.length > 0 ? result[0].values : [];
      const nliRows = rows.filter((r) => r[1] === 'nli');
      assert.equal(
        nliRows.length,
        0,
        `expected no NLI edges after schema mismatch; got: ${JSON.stringify(nliRows)}`,
      );
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  }
});

test('runEdgeInfer NLI subprocess: missing binary skips NLI gracefully', async (t) => {
  // findBinary() in binary.mjs has two lookup paths:
  //   1. $CLAUDE_PLUGIN_DATA/bin/ll-search
  //   2. <repo>/native/target/release/ll-search   (dev-build fallback)
  // Pointing CLAUDE_PLUGIN_DATA at an empty dir is not sufficient when (2)
  // exists. In that case the dev build is found and the test cannot simulate
  // a literally-missing binary without renaming a global artefact, which is
  // unsafe under parallel test runs. Skip with a clear reason; on CI (no dev
  // build) the test runs.
  const devBuild = resolve(new URL('../native/target/release/ll-search', import.meta.url).pathname);
  if (existsSync(devBuild)) {
    t.skip(
      `dev build present at ${devBuild}; cannot simulate missing binary without unsafe rename under parallel test runs`,
    );
    return;
  }

  const emptyDir = mkdtempSync(join(tmpdir(), 'll-nli-empty-'));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = emptyDir;
    __resetBinaryCacheForTesting();

    const dbPath = join(emptyDir, 'edges.db');
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

    // Regex-AND-NLI ctx: regex fires AND nliCandidates is non-empty. With no
    // binary, runNliBatch returns [] early, regex edges still get persisted.
    const ctx = regexAndNliCtx();
    await runEdgeInfer(ctx);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT to_path, source_graph FROM edges WHERE from_path = '${NOTE_REL}'`,
      );
      const rows = result.length > 0 ? result[0].values : [];

      const regexEdge = rows.find((r) => r[0] === '3-permanent/sleep.md');
      assert.ok(regexEdge, `regex edge missing; rows: ${JSON.stringify(rows)}`);
      assert.equal(regexEdge[1], 'local');

      const nliRows = rows.filter((r) => r[1] === 'nli');
      assert.equal(
        nliRows.length,
        0,
        `expected no NLI edges when binary missing; got: ${JSON.stringify(nliRows)}`,
      );
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
