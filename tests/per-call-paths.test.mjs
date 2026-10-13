// Modules that resolve the vault or plugin data must do it per call, from the
// environment the call runs under. The librarian daemon outlives any one vault
// config, and a test that changes CLAUDE_PLUGIN_DATA after import must not
// write through the path the module saw first.
//
// Each module here is imported under one environment (A) and called under
// another (B); the call must land in B.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'll-per-call-paths-'));
after(() => rmSync(root, { recursive: true, force: true }));

function makeEnv(name) {
  const vault = join(root, name, 'vault');
  const pluginData = join(root, name, 'plugin-data');
  mkdirSync(vault, { recursive: true });
  mkdirSync(pluginData, { recursive: true });
  return { vault, pluginData };
}

const A = makeEnv('a');
const B = makeEnv('b');

function useEnv({ vault, pluginData }) {
  process.env.VAULT_PATH = vault;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
}

useEnv(A);
const { mtimeOf } = await import('../plugin/scripts/librarian/daemon-helpers.mjs');
const { vaultFile, indexPath } = await import('../plugin/scripts/librarian/tools/shared.mjs');
const { supersedeNoteFile } = await import('../plugin/scripts/supersede-note.mjs');
const { openEdgeDb, addEdge, saveDb, getEdgesFrom } =
  await import('../plugin/scripts/lib/edges.mjs');

test('daemon-helpers mtimeOf reads the note from the vault it is called under', () => {
  useEnv(B);
  writeFileSync(join(B.vault, 'only-in-b.md'), '# B\n');
  assert.notEqual(mtimeOf('only-in-b.md'), null);
});

test('librarian vaultFile and indexPath follow the vault they are called under', () => {
  useEnv(B);
  assert.equal(vaultFile('note.md'), join(B.vault, 'note.md'));
  assert.equal(indexPath(), join(B.vault, '.vault-search', 'vault-index.db'));
});

test('supersedeNoteFile archives edges in the plugin data it is called under', async () => {
  useEnv(B);
  const note = join(B.vault, 'old-note.md');
  writeFileSync(note, '---\ntags: [a]\n---\n\nOld claim.\n');
  const dbPath = join(B.pluginData, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: 'old-note.md', toPath: 'other.md', edgeType: 'supports' });
  saveDb(db, dbPath);
  db.close();

  const result = await supersedeNoteFile(note, { date: '2026-10-14' });
  assert.equal(result.edgesArchived, 1);

  const reopened = await openEdgeDb(dbPath);
  const rows = getEdgesFrom(reopened, 'old-note.md');
  reopened.close();
  assert.equal(rows[0].source_graph, 'archived');
});
