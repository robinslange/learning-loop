// tests/edge-infer-regex-and-nli-both-fire.test.mjs
//
// Pins the dedup-vs-let-through branches in hooks/modules/edge-infer.mjs
// (~lines 286-303 contradiction side, ~lines 324-345 entailment side) for the
// case where BOTH the regex classifier and NLI fire on the same note.
//
// Two suppression rules:
//   1. Regex challenges_* to a target SUPPRESSES the NLI challenges_rebuttal
//      edge to that same target — regex wins on contradiction conflicts.
//      A regex supports/evidence_for to the SAME target does NOT block NLI's
//      contradiction edge (a note can both support and rebut the same target).
//   2. Regex supports/evidence_for to a target SUPPRESSES the NLI nli_supports
//      edge to that same target — regex wins on support relations too.
//
// The NLI signal is injected via __setNliBatchOverrideForTesting — bypasses
// the daemon/subprocess plumbing entirely. The earlier shell-script stub
// forked under a 1500ms execFileSync timeout, which became flaky under
// parallel test load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runEdgeInfer, __setNliBatchOverrideForTesting } from '../hooks/modules/edge-infer.mjs';

const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

const NOTE_REL = '0-inbox/rebuttal-note.md';
const NOTE_ABS = join(VAULT, NOTE_REL);

function buildMinimalSnapshot(vaultRoot) {
  const notes = [
    { folder: '3-permanent', basename: 'sleep', rel_path: '3-permanent/sleep.md' },
    { folder: '3-permanent', basename: 'circadian', rel_path: '3-permanent/circadian.md' },
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

// Canned NLI result: contradiction AND entailment both above threshold, so the
// only thing that can prevent NLI edges from being written is the regex
// suppression branches this file is pinning.
const BOTH_ABOVE_THRESHOLD = {
  contradiction: 0.97,
  entailment: 0.97,
  neutral: 0.01,
  label: 'contradiction',
};

function installNliOverride() {
  __setNliBatchOverrideForTesting(async (_premise, candidates) =>
    candidates.map(() => ({ ...BOTH_ABOVE_THRESHOLD })),
  );
}

// Shared edges.db dir for this file. Each test clears its rows for NOTE_REL
// before running, so sharing the file across tests is safe and avoids the
// per-test mkdtemp overhead.
const PLUGIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'll-edge-infer-bothfire-'));
process.on('exit', () => {
  try {
    rmSync(PLUGIN_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function clearEdgesFor(dbPath, rel) {
  const db = await openEdgeDb(dbPath);
  db.run(`DELETE FROM edges WHERE from_path = '${rel}'`);
  saveDb(db, dbPath);
  db.close();
}

async function readEdgesFor(dbPath, rel) {
  const db = await openEdgeDb(dbPath);
  try {
    const res = db.exec(
      `SELECT to_path, edge_type, source_graph FROM edges WHERE from_path = '${rel}' ORDER BY source_graph, to_path, edge_type`,
    );
    return res.length > 0 ? res[0].values : [];
  } finally {
    db.close();
  }
}

test('regex challenges_rebuttal to X suppresses NLI challenges_rebuttal to X; NLI to Y still fires', async () => {
  // Setup:
  //   - X = sleep (regex 'rebuts [[sleep]]' -> challenges_rebuttal/high)
  //   - Y = circadian (regex 'reinforces [[circadian]]' -> supports/high)
  //   - autolinkCandidates = [X, Y] — NLI stub returns contradiction=0.97 for BOTH.
  //
  // Expected:
  //   - regex challenges_rebuttal to sleep WRITTEN (regex path)
  //   - NLI challenges_rebuttal to sleep NOT written (suppressed by line 354-356)
  //   - NLI challenges_rebuttal to circadian WRITTEN — regex 'supports' to the
  //     SAME target does not block NLI's contradiction edge per the spec at
  //     edge-infer.mjs:348-352 ("a note can both support and rebut the same
  //     target").
  //   - The regex 'supports' edge to circadian SUPPRESSES the NLI nli_supports
  //     edge to circadian (entailment-side suppression at line 374-382).
  //   - The regex challenges_rebuttal to sleep SUPPRESSES nothing on the
  //     entailment side, so the NLI nli_supports edge to sleep IS written.
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA_DIR;
    installNliOverride();
    const dbPath = join(PLUGIN_DATA_DIR, 'edges.db');
    await clearEdgesFor(dbPath, NOTE_REL);

    const ctx = {
      tool: 'Write',
      input: {
        file_path: NOTE_ABS,
        content:
          '---\ntags: [test]\n---\n\nThis rebuts [[sleep]]. Separately, the model reinforces [[circadian]].\n',
      },
      response: { success: true },
      vaultRoot: VAULT,
      snapshot: buildMinimalSnapshot(VAULT),
      autolinkCandidates: [
        { path: '3-permanent/sleep.md', score: 0.7 },
        { path: '3-permanent/circadian.md', score: 0.7 },
      ],
    };

    await runEdgeInfer(ctx);

    const rows = await readEdgesFor(dbPath, NOTE_REL);

    const findEdge = (to, type, graph) =>
      rows.find((r) => r[0] === to && r[1] === type && r[2] === graph);

    // Regex side — both wikilink edges land.
    assert.ok(
      findEdge('3-permanent/sleep.md', 'challenges_rebuttal', 'local'),
      `regex challenges_rebuttal to sleep.md must be written; rows: ${JSON.stringify(rows)}`,
    );
    assert.ok(
      findEdge('3-permanent/circadian.md', 'supports', 'local'),
      `regex supports to circadian.md must be written; rows: ${JSON.stringify(rows)}`,
    );

    // Contradiction-side suppression: regex challenges_* on sleep blocks NLI on sleep.
    assert.equal(
      findEdge('3-permanent/sleep.md', 'challenges_rebuttal', 'nli'),
      undefined,
      `NLI challenges_rebuttal to sleep.md must be SUPPRESSED by regex challenges_*; rows: ${JSON.stringify(rows)}`,
    );

    // NLI contradiction to circadian DOES fire — regex 'supports' to same target
    // is not a block.
    assert.ok(
      findEdge('3-permanent/circadian.md', 'challenges_rebuttal', 'nli'),
      `NLI challenges_rebuttal to circadian.md must be written even though regex emitted 'supports' (epistemic tension); rows: ${JSON.stringify(rows)}`,
    );

    // Entailment-side suppression: regex 'supports' on circadian blocks NLI nli_supports on circadian.
    assert.equal(
      findEdge('3-permanent/circadian.md', 'nli_supports', 'nli'),
      undefined,
      `NLI nli_supports to circadian.md must be SUPPRESSED by regex 'supports' to same target; rows: ${JSON.stringify(rows)}`,
    );

    // No entailment-side regex match on sleep, so NLI nli_supports to sleep IS written.
    assert.ok(
      findEdge('3-permanent/sleep.md', 'nli_supports', 'nli'),
      `NLI nli_supports to sleep.md must be written (regex challenges_* does not block entailment side); rows: ${JSON.stringify(rows)}`,
    );
  } finally {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
    __setNliBatchOverrideForTesting(null);
  }
});

test('regex evidence_for to X also suppresses NLI nli_supports to X', async () => {
  // Mirror of the entailment-side check, but with 'evidence_for' verb instead
  // of 'supports' — the suppression check at line 378-382 lists both edge types
  // explicitly. 'proves' triggers evidence_for/high in edge-classifier.mjs.
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA_DIR;
    installNliOverride();
    const dbPath = join(PLUGIN_DATA_DIR, 'edges.db');
    await clearEdgesFor(dbPath, NOTE_REL);

    const ctx = {
      tool: 'Write',
      input: {
        file_path: NOTE_ABS,
        content: '---\ntags: [test]\n---\n\nThis proves [[sleep]].\n',
      },
      response: { success: true },
      vaultRoot: VAULT,
      snapshot: buildMinimalSnapshot(VAULT),
      autolinkCandidates: [{ path: '3-permanent/sleep.md', score: 0.7 }],
    };

    await runEdgeInfer(ctx);

    const rows = await readEdgesFor(dbPath, NOTE_REL);
    const findEdge = (to, type, graph) =>
      rows.find((r) => r[0] === to && r[1] === type && r[2] === graph);

    assert.ok(
      findEdge('3-permanent/sleep.md', 'evidence_for', 'local'),
      `regex evidence_for to sleep.md must be written; rows: ${JSON.stringify(rows)}`,
    );
    assert.equal(
      findEdge('3-permanent/sleep.md', 'nli_supports', 'nli'),
      undefined,
      `NLI nli_supports to sleep.md must be SUPPRESSED by regex evidence_for; rows: ${JSON.stringify(rows)}`,
    );
  } finally {
    if (savedPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    }
    __setNliBatchOverrideForTesting(null);
  }
});
