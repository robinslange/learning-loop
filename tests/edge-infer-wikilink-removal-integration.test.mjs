// tests/edge-infer-wikilink-removal-integration.test.mjs
//
// Integration test: exercises runEdgeInfer directly for the wikilink-removal
// scenario.
//
// The scenario: a note previously had [[sleep]] (yielding a regex 'supports'
// edge in edges.db). The note is rewritten with wikilinks removed. Since no
// wikilinks are present the regex pass produces edges = []. The early-return
// guard fires (edges.length === 0) and the prior regex edge survives untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../plugin/scripts/lib/edges.mjs';
import { runEdgeInfer } from '../plugin/hooks/modules/edge-infer.mjs';

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

test('runEdgeInfer: partial wikilink removal keeps surviving wikilink edge, drops removed one', async () => {
  // Note previously linked to BOTH sleep.md and circadian.md (two prior regex edges).
  // New content keeps [[sleep]] but drops [[circadian]]. Expected:
  //   - removeOutgoingEdges wipes both prior edges (regex pass produced edges>0).
  //   - Regex re-derives the supports edge to sleep.md (still in content).
  //   - circadian.md is NOT in the new content so no edge is regenerated.
  const dir = mkdtempSync(join(tmpdir(), 'll-edge-infer-intg-'));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;

  try {
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = dir;

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
        content: '---\ntags: [test]\n---\n\nThis reinforces [[sleep]]. Some other text.\n',
      },
      response: { success: true },
      vaultRoot: VAULT,
      snapshot: buildMinimalSnapshot(VAULT),
    };

    await runEdgeInfer(ctx);

    const db2 = await openEdgeDb(dbPath);
    try {
      // Surviving wikilink: edge to sleep.md must be present and classified as supports.
      const sleepResult = db2.exec(
        `SELECT to_path, edge_type FROM edges WHERE from_path = '${NOTE_REL}' AND to_path = '3-permanent/sleep.md'`,
      );
      const sleepRows = sleepResult.length > 0 ? sleepResult[0].values : [];
      assert.equal(
        sleepRows.length,
        1,
        `expected surviving 'supports' edge to sleep.md; got: ${JSON.stringify(sleepRows)}`,
      );
      assert.equal(sleepRows[0][1], 'supports');

      // Removed wikilink: edge to circadian.md must be gone (wiped by
      // removeOutgoingEdges and not regenerated because circadian isn't in new content).
      const circadianResult = db2.exec(
        `SELECT to_path FROM edges WHERE from_path = '${NOTE_REL}' AND to_path = '3-permanent/circadian.md'`,
      );
      const circadianRows = circadianResult.length > 0 ? circadianResult[0].values : [];
      assert.equal(
        circadianRows.length,
        0,
        `edge to circadian.md must be gone after partial wikilink removal; got: ${JSON.stringify(circadianRows)}`,
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
