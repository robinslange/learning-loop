// Tests for the edges-backfill doctor check (scripts/health-check.mjs).
// Flags a justification index that has fallen behind the vault: edges.db
// missing, or present with zero edges, while the vault has notes. The fix
// string is the backfill-edges.mjs CLI, which has no other caller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEdgesBackfill, runFullChecks } from '../plugin/scripts/health-check.mjs';

test('fails with the backfill fix when edges.db is missing and the vault has notes', () => {
  const c = checkEdgesBackfill({ vaultNoteCount: 12, dbExists: false, edgeCount: null });
  assert.equal(c.id, 'edges-backfill');
  assert.equal(c.status, 'fail');
  assert.equal(c.severity, 'warn');
  assert.match(c.detail, /missing/);
  assert.match(c.fix, /node PLUGIN\/scripts\/backfill-edges\.mjs/);
});

test('fails when edges.db exists but holds zero edges', () => {
  const c = checkEdgesBackfill({ vaultNoteCount: 12, dbExists: true, edgeCount: 0 });
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /zero edges/);
  assert.match(c.fix, /backfill-edges\.mjs/);
});

test('ok when the vault has no notes (nothing to index)', () => {
  const c = checkEdgesBackfill({ vaultNoteCount: 0, dbExists: false, edgeCount: null });
  assert.equal(c.status, 'ok');
  assert.equal(c.fix, null);
});

test('ok when edges exist', () => {
  const c = checkEdgesBackfill({ vaultNoteCount: 12, dbExists: true, edgeCount: 34 });
  assert.equal(c.status, 'ok');
  assert.match(c.detail, /34 edge/);
});

test('fails when edges.db exists but is unreadable', () => {
  const c = checkEdgesBackfill({ vaultNoteCount: 12, dbExists: true, edgeCount: null });
  assert.equal(c.status, 'fail');
  assert.match(c.fix, /backfill-edges\.mjs/);
});

test('runFullChecks includes the edges-backfill check with collected inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edges-backfill-'));
  try {
    const vaultRoot = join(dir, 'vault');
    const pluginData = join(dir, 'data');
    mkdirSync(join(vaultRoot, '0-inbox'), { recursive: true });
    mkdirSync(pluginData, { recursive: true });
    writeFileSync(join(vaultRoot, '0-inbox', 'a.md'), '---\nname: a\n---\nBody.\n');
    const result = await runFullChecks({ pluginData, vaultRoot, home: dir });
    const check = result.checks.find((c) => c.id === 'edges-backfill');
    assert.ok(check, 'edges-backfill check missing from full run');
    // one note, no edges.db -> the backfill nudge fires
    assert.equal(check.status, 'fail');
    assert.match(check.fix, /backfill-edges\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a comention-only index is populated, not a backfill failure', async () => {
  // A vault whose resolved wikilinks all lack an argumentative verb produces
  // only comention rows. That index is correctly populated and backfill is
  // idempotent, so a zero-argued count must not trip the zero-edges failure.
  const { openEdgeDb, addEdge, saveDb } = await import('../plugin/scripts/lib/edges.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'll-comention-only-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, {
      fromPath: 'a.md',
      toPath: 'b.md',
      edgeType: 'associative',
      confidence: 'low',
      sourceGraph: 'comention',
    });
    saveDb(db, dbPath);
    db.close();

    const vaultRoot = join(dir, 'vault');
    mkdirSync(join(vaultRoot, '0-inbox'), { recursive: true });
    writeFileSync(join(vaultRoot, '0-inbox', 'a.md'), '# a\n\nsee [[b]]\n');
    writeFileSync(join(vaultRoot, '0-inbox', 'b.md'), '# b\n');

    const result = await runFullChecks({ pluginData: dir, vaultRoot, home: dir });
    const check = result.checks.find((c) => c.id === 'edges-backfill');
    assert.equal(check.status, 'ok', check.detail);
    assert.match(check.detail, /0 argued edge\(s\), 1 co-mention\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
