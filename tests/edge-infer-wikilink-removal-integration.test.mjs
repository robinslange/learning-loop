// tests/edge-infer-wikilink-removal-integration.test.mjs
//
// Integration test: exercises runEdgeInfer directly for the wikilink-removal
// scenario.
//
// The scenario: a note previously had [[sleep]] (yielding a regex 'supports'
// edge in edges.db). The note is rewritten with wikilinks removed. Since no
// wikilinks are present the regex pass produces edges = []. No ll-search binary
// is available in the test environment, so autolinkCandidates = []. The
// early-return guard fires (edges.length === 0 && nliCandidates.length === 0)
// and the prior regex edge survives untouched.
//
// This pins the split logic at the runEdgeInfer layer — the unit test for
// removeOutgoingNliEdges checks the helper in isolation; this test confirms the
// correct branch is chosen in the production function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runEdgeInfer } from '../hooks/modules/edge-infer.mjs';

const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

// Note lives in 0-inbox so isVaultNote() accepts it.
const NOTE_REL = '0-inbox/rebuttal-note.md';
const NOTE_ABS = join(VAULT, NOTE_REL);

// Build a minimal snapshot that satisfies buildVaultIndexFromSnapshot.
// Only needs the notes array and relPathSet; version/vault_root/dates are not
// read by edge-infer (only passed through to buildVaultIndexFromSnapshot).
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

test('runEdgeInfer: wikilink removal does not wipe prior regex edges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edge-infer-intg-'));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = dir;

    // Seed edges.db with a prior regex edge from the source note.
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

    // Build ctx: note with wikilinks REMOVED, empty autolinkCandidates.
    const ctx = {
      tool: 'Write',
      input: {
        file_path: NOTE_ABS,
        content: '---\ntags: [test]\n---\n\nSleep affects cognitive performance.\n',
      },
      response: { success: true },
      vaultRoot: VAULT,
      snapshot: buildMinimalSnapshot(VAULT),
      autolinkCandidates: [],
    };

    await runEdgeInfer(ctx);

    // Verify: prior 'supports' edge must still be present.
    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT from_path, to_path, edge_type, source_graph FROM edges WHERE from_path = '${NOTE_REL}' ORDER BY to_path`,
      );
      const rows = result.length > 0 ? result[0].values : [];
      assert.equal(
        rows.length,
        1,
        `expected prior regex edge to survive; got ${rows.length} rows: ${JSON.stringify(rows)}`,
      );
      const [fromPath, toPath, edgeType, sourceGraph] = rows[0];
      assert.equal(fromPath, NOTE_REL);
      assert.equal(toPath, '3-permanent/sleep.md');
      assert.equal(edgeType, 'supports');
      assert.equal(sourceGraph, 'local');
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runEdgeInfer: wikilink write replaces prior regex edges', async () => {
  // Contrast: when new content HAS wikilinks with a classifiable context,
  // the regex path fires, removeOutgoingEdges runs, and the note's edges are
  // re-derived. The old edge to a different target is gone; a new edge to the
  // newly classified target is present.
  //
  // "reinforces [[sleep]]" matches the 'supports' high pattern (/\breinforces?\b/).
  // The snapshot resolver maps 'sleep' -> '3-permanent/sleep.md'.
  const dir = mkdtempSync(join(tmpdir(), 'll-edge-infer-intg-'));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = dir;

    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, {
      fromPath: NOTE_REL,
      toPath: '3-permanent/circadian.md',
      edgeType: 'supports',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
    saveDb(db, dbPath);
    db.close();

    const ctx = {
      tool: 'Write',
      input: {
        file_path: NOTE_ABS,
        // "reinforces [[sleep]]" hits the supports/high pattern — classifier
        // emits an edge to 3-permanent/sleep.md so edges.length > 0.
        content: '---\ntags: [test]\n---\n\nThis reinforces [[sleep]].\n',
      },
      response: { success: true },
      vaultRoot: VAULT,
      snapshot: buildMinimalSnapshot(VAULT),
      autolinkCandidates: [],
    };

    await runEdgeInfer(ctx);

    const db2 = await openEdgeDb(dbPath);
    try {
      // Old edge to circadian.md must be gone (removeOutgoingEdges ran).
      const oldResult = db2.exec(
        `SELECT to_path FROM edges WHERE from_path = '${NOTE_REL}' AND to_path = '3-permanent/circadian.md'`,
      );
      const oldRows = oldResult.length > 0 ? oldResult[0].values : [];
      assert.equal(
        oldRows.length,
        0,
        `old edge to circadian.md must be removed after classifiable wikilink write; got: ${JSON.stringify(oldRows)}`,
      );

      // New edge to sleep.md must be present.
      const newResult = db2.exec(
        `SELECT to_path, edge_type FROM edges WHERE from_path = '${NOTE_REL}' AND to_path = '3-permanent/sleep.md'`,
      );
      const newRows = newResult.length > 0 ? newResult[0].values : [];
      assert.equal(
        newRows.length,
        1,
        `expected new edge to sleep.md after classifiable wikilink write; got: ${JSON.stringify(newRows)}`,
      );
      assert.equal(newRows[0][1], 'supports');
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// NLI-only branch: edges.length === 0 && nliCandidates.length > 0
//
// This is the branch where the original wikilink-removal divergence bug lived.
// When a note has no wikilinks (regex returns []) but autolinkCandidates is
// non-empty, runEdgeInfer must:
//   1. Call removeOutgoingNliEdges (NOT removeOutgoingEdges) — prior regex
//      edges from this note survive.
//   2. Run the NLI loop against nliCandidates, writing challenges_rebuttal
//      rows with source_graph='nli' for any candidate above NLI_THRESHOLD.
//
// The ll-search binary is stubbed with a shell script. binaryPath() in
// scripts/lib/binary.mjs caches the resolved path after the first non-null
// find. To avoid stale-path ENOENT across tests (where each test has its own
// temp dir), the fake binary lives in a single shared temp dir created at
// module load time and deleted on process exit. Both NLI tests set
// CLAUDE_PLUGIN_DATA to their own dir (for edges.db isolation) and rely on
// the binaryPath() cache already pointing at the shared binary from the first
// NLI test's run.

// Shell script that mimics: ll-search nli-batch <premise> <hyps-file>
// Returns one result per hypothesis line with contradiction=0.97 wrapped in
// the schema_version envelope the binary emits ({schema_version:1, results:[...]}).
// Uses `|| [ -n "$line" ]` to handle hypothesis files without a trailing
// newline (runNliBatch writes hypotheses.join('\n') which omits the final \n).
const NLI_STUB_SCRIPT = [
  '#!/bin/sh',
  '# Stub: ll-search nli-batch — schema_version=1 wrapped response',
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

// Create the shared binary dir once at module load. This dir is deliberately
// NOT cleaned up between tests so binaryPath()'s cache stays valid across
// both NLI tests. Process exit handles cleanup.
const NLI_BIN_DIR = mkdtempSync(join(tmpdir(), 'll-edge-infer-nli-bin-'));
const NLI_BIN_PATH = join(NLI_BIN_DIR, 'bin', 'll-search');
mkdirSync(join(NLI_BIN_DIR, 'bin'), { recursive: true });
writeFileSync(NLI_BIN_PATH, NLI_STUB_SCRIPT);
chmodSync(NLI_BIN_PATH, 0o755);
process.on('exit', () => {
  try {
    rmSync(NLI_BIN_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('runEdgeInfer NLI-only branch: prior regex edges survive, NLI edge written', async () => {
  // First NLI test: also primes binaryPath() cache to point at NLI_BIN_DIR.
  // CLAUDE_PLUGIN_DATA must initially point at the dir containing the binary
  // so that binaryPath()'s findBinary() check (pluginData/bin/ll-search) hits.
  // After binaryPath() caches the path, subsequent tests can point
  // CLAUDE_PLUGIN_DATA elsewhere — the cache bypasses the lookup.
  const dir = mkdtempSync(join(tmpdir(), 'll-edge-infer-nli-'));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    mkdirSync(dir, { recursive: true });
    // Point pluginData at the shared binary dir so binaryPath() resolves it.
    // edges.db will also land there; that's fine for this test.
    process.env.CLAUDE_PLUGIN_DATA = NLI_BIN_DIR;

    // Seed a prior regex edge from the source note to neighbour A (sleep.md).
    const dbPath = join(NLI_BIN_DIR, 'edges.db');
    const db = await openEdgeDb(dbPath);
    // Clear any leftover rows from a previous run.
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

    // ctx: no wikilinks (regex returns []), NLI candidate is neighbour B.
    const ctx = {
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

    await runEdgeInfer(ctx);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT from_path, to_path, edge_type, source_graph, confidence_score FROM edges WHERE from_path = '${NOTE_REL}' ORDER BY source_graph, to_path`,
      );
      const rows = result.length > 0 ? result[0].values : [];

      // Prior regex edge to sleep.md must survive (removeOutgoingEdges was NOT called).
      const regexEdge = rows.find((r) => r[1] === '3-permanent/sleep.md');
      assert.ok(
        regexEdge,
        `prior regex 'supports' edge to sleep.md must survive in NLI-only branch; rows: ${JSON.stringify(rows)}`,
      );
      assert.equal(regexEdge[2], 'supports');
      assert.equal(regexEdge[3], 'local');

      // NLI edge to circadian.md must be written with source_graph='nli'.
      const nliEdge = rows.find((r) => r[1] === '3-permanent/circadian.md');
      assert.ok(
        nliEdge,
        `NLI challenges_rebuttal edge to circadian.md must be written; rows: ${JSON.stringify(rows)}`,
      );
      assert.equal(nliEdge[2], 'challenges_rebuttal');
      assert.equal(nliEdge[3], 'nli');
      assert.ok(
        typeof nliEdge[4] === 'number' && nliEdge[4] > 0.9,
        `confidence_score must be a number >0.9; got ${nliEdge[4]}`,
      );
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
    // dir is unused (edges.db landed in NLI_BIN_DIR); clean it up.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runEdgeInfer NLI-only branch: re-invocation re-derives NLI edges cleanly', async () => {
  // Second invocation with same content and candidates: removeOutgoingNliEdges
  // wipes the stale NLI row from the first call, then the loop re-adds it.
  // The regex edge (local) must never be touched.
  //
  // binaryPath() is already cached from the previous NLI test — no binary
  // placement needed here.
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    process.env.CLAUDE_PLUGIN_DATA = NLI_BIN_DIR;

    const dbPath = join(NLI_BIN_DIR, 'edges.db');
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

    const ctx = {
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

    // First invocation.
    await runEdgeInfer(ctx);

    // Second invocation: same ctx, same content.
    await runEdgeInfer(ctx);

    const db2 = await openEdgeDb(dbPath);
    try {
      const result = db2.exec(
        `SELECT from_path, to_path, edge_type, source_graph FROM edges WHERE from_path = '${NOTE_REL}' ORDER BY source_graph, to_path`,
      );
      const rows = result.length > 0 ? result[0].values : [];

      // Exactly two edges: one regex, one NLI (no duplicates from re-invocation).
      assert.equal(
        rows.length,
        2,
        `expected exactly 2 edges after two invocations (1 regex + 1 NLI, no duplicates); rows: ${JSON.stringify(rows)}`,
      );

      const regexEdge = rows.find((r) => r[3] === 'local');
      assert.ok(regexEdge, 'regex edge (source_graph=local) must be present after re-invocation');
      assert.equal(regexEdge[1], '3-permanent/sleep.md');

      const nliEdge = rows.find((r) => r[3] === 'nli');
      assert.ok(nliEdge, 'NLI edge (source_graph=nli) must be present after re-invocation');
      assert.equal(nliEdge[1], '3-permanent/circadian.md');
      assert.equal(nliEdge[2], 'challenges_rebuttal');
    } finally {
      db2.close();
    }
  } finally {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
  }
});
