import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';

test('saveDb round-trips via tmp+rename: db reopens, no tmp residue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  const dbPath = join(dir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
  saveDb(db, dbPath);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'tmp file left behind');
  const reopened = await openEdgeDb(dbPath);
  assert.ok(reopened);
});

test('saveDb uses rename, not a direct writeFileSync to the db path', () => {
  const src = readFileSync(new URL('../scripts/lib/edges.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function saveDb'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.match(body, /renameSync/);
});
