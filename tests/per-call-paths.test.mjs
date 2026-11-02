// Modules that resolve the vault or plugin data must do it per call, from the
// environment the call runs under. The librarian daemon outlives any one vault
// config, and a test that changes CLAUDE_PLUGIN_DATA after import must not
// write through the path the module saw first.
//
// Each module here is imported under one environment (A) and called under
// another (B); the call must land in B.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const { vaultFile, indexPath, getDb } =
  await import('../plugin/scripts/librarian/tools/shared.mjs');
const { loadLibrarianConfig } = await import('../plugin/scripts/librarian/config.mjs');
const { resetConfigCache } = await import('../plugin/scripts/lib/config.mjs');
const { initSQL } = await import('../plugin/scripts/lib/sqljs.mjs');
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

// The daemon reloads its config on each idle pass; a vault re-pointed in
// config.json then reaches every per-call lookup.
test('librarian paths follow a vault re-pointed in config.json once the config reloads', () => {
  useEnv(A);
  delete process.env.VAULT_PATH;
  resetConfigCache();
  const cfgFile = join(A.pluginData, 'config.json');
  writeFileSync(cfgFile, JSON.stringify({ vault_path: A.vault }));
  loadLibrarianConfig();
  assert.equal(indexPath(), join(A.vault, '.vault-search', 'vault-index.db'));

  writeFileSync(cfgFile, JSON.stringify({ vault_path: B.vault }));
  const later = new Date(Date.now() + 5000);
  utimesSync(cfgFile, later, later);
  loadLibrarianConfig();
  assert.equal(indexPath(), join(B.vault, '.vault-search', 'vault-index.db'));
});

test('getDb keeps its open database when the next vault has no index to open', async () => {
  useEnv(A);
  const SQL = await initSQL();
  const fresh = new SQL.Database();
  fresh.run('CREATE TABLE t (x)');
  mkdirSync(join(A.vault, '.vault-search'), { recursive: true });
  writeFileSync(indexPath(), Buffer.from(fresh.export()));
  fresh.close();
  await getDb();

  useEnv(B);
  await assert.rejects(getDb());

  useEnv(A);
  const db = await getDb();
  assert.doesNotThrow(() => db.exec('SELECT 1'));
});
