// tests/regenerate-viz-mixed-source-graph.test.mjs
//
// Exercise each viz phase on an edges.db that contains a deliberately mixed
// set of source_graph values (local / archived / nli) and edge_type values
// (supports / challenges_*). The phases must filter consistently with their
// documented contracts:
//
//   Frontmatter — only NLI edges with confidence_score >= threshold contribute
//                 to the nli-contradicts / nli-supports / has-* keys. Local
//                 'supports' and 'archived' rows must not leak into the
//                 frontmatter on the source note.
//   Heatmap     — every source_graph='nli' row appears in the markdown table
//                 (both challenges_rebuttal and nli_supports). Local and
//                 archived rows are filtered out by getAllNliEdgesForHeatmap.
//   Cycles      — getEdgesForCycleDetection takes nli edges plus any edge
//                 whose type starts with 'challenges_', regardless of
//                 source_graph. A plain local 'supports' row must NOT seed a
//                 cycle; an 'archived' row must NOT seed a cycle; an NLI row
//                 and a regex 'challenges_*' row should both qualify.
//
// Together this pins the source_graph filtering invariants on the same DB
// snapshot, so a future refactor that loosens or tightens one phase out of
// step with the others will trip this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import {
  runFrontmatterPhase,
  runHeatmapPhase,
  runCyclesPhase,
} from '../scripts/regenerate-viz.mjs';

test('viz phases filter mixed source_graph rows consistently', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-mix-'));
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-mix-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);

  // Six notes: alpha, beta (local supports/archived chain), gamma->delta
  // (nli contradiction), epsilon (nli supports), zeta->eta (regex
  // challenges_undermining). They are not all real cycles — the test only
  // checks the per-phase filter, not the cycle solver.
  const notes = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'eta', 'zeta'];
  for (const n of notes) {
    writeFileSync(join(vaultRoot, '3-permanent', `${n}.md`), `# ${n}\n`);
  }

  // Local 'supports' — should never enter heatmap, frontmatter, or cycles.
  addEdge(db, {
    fromPath: '3-permanent/alpha.md',
    toPath: '3-permanent/beta.md',
    edgeType: 'supports',
    confidence: 'high',
    sourceGraph: 'local',
    directionFlipped: 0,
  });

  // Archived edge — preserved across an archive flow, must NOT enter any viz
  // surface.
  addEdge(db, {
    fromPath: '3-permanent/beta.md',
    toPath: '3-permanent/alpha.md',
    edgeType: 'challenges_rebuttal',
    confidence: 'high',
    sourceGraph: 'archived',
    directionFlipped: 0,
  });

  // Two NLI contradiction rows at >=0.95 — both should produce frontmatter
  // entries on their source notes and appear in the heatmap.
  addEdge(db, {
    fromPath: '3-permanent/gamma.md',
    toPath: '3-permanent/delta.md',
    edgeType: 'challenges_rebuttal',
    confidence: 'low',
    sourceGraph: 'nli',
    directionFlipped: 0,
    confidenceScore: 0.97,
  });
  addEdge(db, {
    fromPath: '3-permanent/delta.md',
    toPath: '3-permanent/gamma.md',
    edgeType: 'challenges_rebuttal',
    confidence: 'low',
    sourceGraph: 'nli',
    directionFlipped: 0,
    confidenceScore: 0.96,
  });

  // NLI entailment row — should produce nli-supports / has-entailment on
  // epsilon, and appear in the heatmap as 'entails'.
  addEdge(db, {
    fromPath: '3-permanent/epsilon.md',
    toPath: '3-permanent/alpha.md',
    edgeType: 'nli_supports',
    confidence: 'low',
    sourceGraph: 'nli',
    directionFlipped: 0,
    confidenceScore: 0.98,
  });

  // Regex 'challenges_undermining' (local) — should NOT enter frontmatter or
  // heatmap, but SHOULD be considered by cycle detection (edge_type starts
  // with 'challenges_').
  addEdge(db, {
    fromPath: '3-permanent/zeta.md',
    toPath: '3-permanent/eta.md',
    edgeType: 'challenges_undermining',
    confidence: 'high',
    sourceGraph: 'local',
    directionFlipped: 0,
  });

  saveDb(db, dbPath);

  // ---- Frontmatter phase ---------------------------------------------------
  const fmCounts = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: false });
  // Three NLI-qualifying source notes (gamma, delta, epsilon). alpha must
  // stay clean (its only outgoing edge is local 'supports').
  assert.equal(fmCounts.updated, 3, 'three NLI-qualifying notes updated');
  assert.equal(fmCounts.cleared, 0);

  const gammaContent = readFileSync(join(vaultRoot, '3-permanent', 'gamma.md'), 'utf-8');
  assert.match(gammaContent, /nli-contradicts:\s*\["\[\[delta\]\]"\]/);
  assert.match(gammaContent, /has-contradiction: true/);
  assert.doesNotMatch(gammaContent, /nli-supports/);

  const epsilonContent = readFileSync(join(vaultRoot, '3-permanent', 'epsilon.md'), 'utf-8');
  assert.match(epsilonContent, /nli-supports:\s*\["\[\[alpha\]\]"\]/);
  assert.match(epsilonContent, /has-entailment: true/);
  assert.doesNotMatch(epsilonContent, /nli-contradicts/);

  // alpha is the source of a local 'supports' edge only; it must not gain any
  // NLI frontmatter keys.
  const alphaContent = readFileSync(join(vaultRoot, '3-permanent', 'alpha.md'), 'utf-8');
  assert.doesNotMatch(alphaContent, /nli-contradicts/);
  assert.doesNotMatch(alphaContent, /nli-supports/);
  assert.doesNotMatch(alphaContent, /has-contradiction/);
  assert.doesNotMatch(alphaContent, /has-entailment/);

  // beta is the source of an archived 'challenges_rebuttal' — must NOT
  // surface in frontmatter.
  const betaContent = readFileSync(join(vaultRoot, '3-permanent', 'beta.md'), 'utf-8');
  assert.doesNotMatch(betaContent, /nli-contradicts/);
  assert.doesNotMatch(betaContent, /nli-supports/);

  // zeta is the source of a regex challenges_undermining — must NOT surface
  // in frontmatter (NLI-only).
  const zetaContent = readFileSync(join(vaultRoot, '3-permanent', 'zeta.md'), 'utf-8');
  assert.doesNotMatch(zetaContent, /nli-contradicts/);
  assert.doesNotMatch(zetaContent, /nli-supports/);

  // ---- Heatmap phase -------------------------------------------------------
  const hmCounts = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  // Three NLI rows total: gamma->delta, delta->gamma, epsilon->alpha.
  assert.equal(hmCounts.rows, 3);

  const heatmap = readFileSync(join(vaultRoot, '_system', 'nli-conflicts.md'), 'utf-8');
  assert.match(heatmap, /Total: 3 \(2 contradicts, 1 entails/);
  // NLI rows present.
  assert.match(heatmap, /\[\[gamma\]\][\s\S]*\[\[delta\]\][\s\S]*contradicts/);
  assert.match(heatmap, /\[\[delta\]\][\s\S]*\[\[gamma\]\][\s\S]*contradicts/);
  assert.match(heatmap, /\[\[epsilon\]\][\s\S]*\[\[alpha\]\][\s\S]*entails/);
  // Local 'supports' (alpha->beta) must NOT show as a heatmap row. The cell
  // markup uses `[[alpha]] | [[beta]] |` so this is the precise shape we'd
  // see if it leaked.
  assert.doesNotMatch(heatmap, /\| \[\[alpha\]\][^|]*\| \[\[beta\]\]/);
  // Archived row (beta->alpha) must NOT show.
  assert.doesNotMatch(heatmap, /\| \[\[beta\]\][^|]*\| \[\[alpha\]\]/);
  // Regex challenges_undermining (zeta->eta) must NOT show — heatmap is
  // NLI-only.
  assert.doesNotMatch(heatmap, /\| \[\[zeta\]\][^|]*\| \[\[eta\]\]/);

  // ---- Cycles phase --------------------------------------------------------
  // The two NLI rows gamma<->delta form a length-2 cycle; this proves the
  // NLI rows reach the solver. The regex zeta->eta edge has no return edge,
  // so it contributes no cycle on its own; what matters is that local
  // 'supports' (alpha->beta) and archived (beta->alpha) do not silently
  // form an alpha<->beta cycle (which would happen if either source_graph
  // value leaked into getEdgesForCycleDetection).
  const cyCounts = await runCyclesPhase(db, vaultRoot, { maxDepth: 4, dryRun: false });
  assert.equal(cyCounts.cycles, 1, 'only the NLI gamma<->delta cycle survives');

  const canvas = JSON.parse(
    readFileSync(join(vaultRoot, '_system', 'viz', 'cycles.canvas'), 'utf-8'),
  );
  const cycleFiles = canvas.nodes.filter((n) => n.type === 'file').map((n) => n.file);
  assert.ok(cycleFiles.includes('3-permanent/gamma.md'));
  assert.ok(cycleFiles.includes('3-permanent/delta.md'));
  // alpha and beta must not be in the cycle canvas — neither local supports
  // nor archived contributes a cycle here.
  assert.ok(!cycleFiles.includes('3-permanent/alpha.md'));
  assert.ok(!cycleFiles.includes('3-permanent/beta.md'));

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});
