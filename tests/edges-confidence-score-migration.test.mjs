import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb } from '../scripts/lib/edges.mjs';

test('edges schema has confidence_score REAL column', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    const res = db.exec("PRAGMA table_info(edges)");
    const cols = res[0]?.values || [];
    const names = cols.map((row) => row[1]);
    assert.ok(names.includes('confidence_score'));
    const idx = names.indexOf('confidence_score');
    assert.equal(cols[idx][2], 'REAL');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration is idempotent on reopened db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    let db = await openEdgeDb(dbPath);
    db.close();
    db = await openEdgeDb(dbPath);
    const res = db.exec("PRAGMA table_info(edges)");
    const cols = res[0]?.values || [];
    const names = cols.map((row) => row[1]);
    assert.ok(names.includes('confidence_score'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
