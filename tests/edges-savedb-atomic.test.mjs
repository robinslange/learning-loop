import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb, getEdgesFrom } from '../plugin/scripts/lib/edges.mjs';
import { skipOnWindows } from './helpers/platform.mjs';

test('saveDb round-trips via tmp+rename: db reopens, no tmp residue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  const dbPath = join(dir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
  saveDb(db, dbPath);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'tmp file left behind');
  const reopened = await openEdgeDb(dbPath);
  const edges = getEdgesFrom(reopened, 'a.md');
  assert.ok(
    edges.some((e) => e.to_path === 'b.md' && e.edge_type === 'evidence_for'),
    'a.md→b.md evidence_for edge lost in round-trip',
  );
});

// win32 file ids depend on the filesystem and can read back as 0, so an
// unchanged ino there proves nothing.
test(
  'saveDb replaces the db file instead of rewriting it in place',
  { skip: skipOnWindows('statSync().ino is not a reliable file identity on win32') },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    saveDb(db, dbPath);
    const before = statSync(dbPath).ino;
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    saveDb(db, dbPath);
    assert.notEqual(statSync(dbPath).ino, before, 'db file was rewritten in place');
  },
);
