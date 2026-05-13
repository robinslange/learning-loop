// tests/regenerate-viz-throw-mid-phase.test.mjs
//
// Pins the faea595 fix: when a viz phase throws mid-execution, saveDb still
// runs in main()'s finally block so DB-side writes from the previous phase
// are not lost.
//
// Scenario:
//   - frontmatter phase runs first; it writes a viz_meta sentinel
//     (nli_frontmatter_index_bootstrapped_v1=1) and a tagged-notes row.
//   - heatmap phase then throws because vaultRoot/_system is a regular file,
//     so its `mkdirSync('_system', { recursive: true })` raises EEXIST.
//   - main() catches the throw in its outer try (Node propagates the
//     rejected promise into main()), runs saveDb(db, dbPath) in finally,
//     then exits non-zero.
//
// Re-opening the DB must show the sentinel and tagged-notes row persisted.
// Before faea595, saveDb was inside the try block, so the heatmap throw
// bypassed it and the bootstrap state lived only in memory.
//
// This test drives the production CLI (scripts/regenerate-viz.mjs) via
// spawnSync rather than re-implementing the try/finally — the whole point
// is to verify the production path, and the fix is in main().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openEdgeDb, addEdge, saveDb, getMetaFlag, getTaggedNotes } from '../scripts/lib/edges.mjs';

const VIZ_SCRIPT = new URL('../scripts/regenerate-viz.mjs', import.meta.url).pathname;

test('saveDb runs in finally even when a phase throws', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-throw-'));
  const pluginData = mkdtempSync(join(tmpdir(), 'll-viz-plugin-throw-'));

  // Make _system a FILE, not a directory. The heatmap phase's
  //   mkdirSync(join(vaultRoot, '_system'), { recursive: true })
  // will then throw EEXIST. The frontmatter phase walks the vault via
  // readdirSync inside try/catch, so it does not throw on the same setup.
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  writeFileSync(join(vaultRoot, '_system'), 'sentinel-file-not-a-dir\n');
  writeFileSync(join(vaultRoot, '3-permanent', 'a.md'), '# A\n');
  writeFileSync(join(vaultRoot, '3-permanent', 'b.md'), '# B\n');

  // Seed an NLI edge so the frontmatter phase actually does work — without
  // an edge, the frontmatter phase still sets the bootstrap sentinel on
  // first run (load-bearing path), but adding a tagged-notes row makes the
  // assertion below cover both viz_meta and nli_frontmatter_tags writes.
  const dbPath = join(pluginData, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, {
    fromPath: '3-permanent/a.md',
    toPath: '3-permanent/b.md',
    edgeType: 'challenges_rebuttal',
    confidence: 'low',
    sourceGraph: 'nli',
    directionFlipped: 0,
    confidenceScore: 0.97,
  });
  saveDb(db, dbPath);
  db.close();

  // Pre-condition: sentinel not yet set on disk.
  {
    const pre = await openEdgeDb(dbPath);
    assert.equal(getMetaFlag(pre, 'nli_frontmatter_index_bootstrapped_v1'), null);
    assert.equal(getTaggedNotes(pre).size, 0);
    pre.close();
  }

  // Drive the production CLI. Must exit non-zero because heatmap throws,
  // but the finally block must still saveDb.
  const child = spawnSync(process.execPath, [VIZ_SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      VAULT_PATH: vaultRoot,
      CLAUDE_PLUGIN_DATA: pluginData,
    },
    timeout: 30_000,
  });
  assert.notEqual(
    child.status,
    0,
    `CLI must exit non-zero when heatmap phase throws (stdout: ${child.stdout}, stderr: ${child.stderr})`,
  );

  // Post-condition: bootstrap sentinel AND tagged-notes row persisted to
  // disk despite the mid-pipeline throw. This is the regression guard.
  const post = await openEdgeDb(dbPath);
  try {
    assert.equal(
      getMetaFlag(post, 'nli_frontmatter_index_bootstrapped_v1'),
      '1',
      'bootstrap sentinel must survive heatmap throw (faea595: saveDb in finally)',
    );
    const tagged = getTaggedNotes(post);
    assert.equal(tagged.size, 1, 'tagged-notes row must survive heatmap throw');
    assert.ok(tagged.has('3-permanent/a.md'));
  } finally {
    post.close();
  }

  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(pluginData, { recursive: true, force: true });
});
