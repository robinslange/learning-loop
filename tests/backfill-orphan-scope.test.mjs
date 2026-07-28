import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openEdgeDb, addEdge, saveDb, getEdgesFrom } from '../plugin/scripts/lib/edges.mjs';
import { removeOrphanEdges, isScopedRun } from '../plugin/scripts/backfill-edges.mjs';

const PLUGIN_DATA = join(tmpdir(), `ll-test-backfill-orphan-${randomBytes(8).toString('hex')}`);
const DB_PATH = join(PLUGIN_DATA, 'edges.db');
const BACKFILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'scripts',
  'backfill-edges.mjs',
);

async function seed() {
  const db = await openEdgeDb(DB_PATH);
  // Edges originating from notes in several folders.
  addEdge(db, {
    fromPath: '3-permanent/a.md',
    toPath: '3-permanent/b.md',
    edgeType: 'evidence_for',
  });
  addEdge(db, { fromPath: '0-inbox/c.md', toPath: '3-permanent/a.md', edgeType: 'evidence_for' });
  addEdge(db, {
    fromPath: '4-projects/d.md',
    toPath: '3-permanent/b.md',
    edgeType: 'derived_from',
  });
  saveDb(db, DB_PATH);
  return db;
}

// Regression (CI red on ubuntu/macos/windows, 2026-07-28): importing
// backfill-edges.mjs for its pure exports crashed the whole test FILE with
// `ERR_INVALID_ARG_TYPE: path must be of type string. Received null`.
// Module scope ran `DATA_FILES.edgesDb(PLUGIN_DATA)`, and PLUGIN_DATA is null
// wherever plugin-data isn't configured — every CI runner. It passed on dev
// machines only because they happen to have plugin-data, so the whole class of
// import-time environment coupling was invisible locally.
//
// The CLI's paths belong inside main(), not at module scope. This pins that:
// importing the module must not touch the environment at all.
describe('backfill-edges import purity', () => {
  it('imports cleanly with no plugin-data configured (the CI environment)', () => {
    // A real subprocess with HOME pointed at a nonexistent dir and every
    // plugin-data override cleared — the resolver finds nothing and returns
    // null, exactly as on a CI runner. In-process this can't be tested: the
    // module is already cached by the import at the top of this file.
    const probe = `import('${pathToFileURL(BACKFILL_PATH).href}').then(m => {
      if (typeof m.removeOrphanEdges !== 'function') { console.error('missing export'); process.exit(2); }
      process.exit(0);
    }).catch(e => { console.error(e.message); process.exit(1); });`;

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: join(tmpdir(), `ll-no-plugin-data-${randomBytes(6).toString('hex')}`),
      },
    });

    assert.equal(
      res.status,
      0,
      `importing backfill-edges.mjs without plugin-data must not throw; got: ${res.stderr}`,
    );
  });
});

describe('backfill-edges orphan removal scope', () => {
  before(() => mkdirSync(PLUGIN_DATA, { recursive: true }));
  beforeEach(() => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });
  after(() => rmSync(PLUGIN_DATA, { recursive: true, force: true }));

  it('a scoped run (--folder) does NOT delete edges from un-walked folders', async () => {
    const db = await seed();
    // Simulate `--folder 3-permanent`: only 3-permanent notes were walked.
    const walked = new Set(['3-permanent/a.md']);
    const { removed } = removeOrphanEdges(db, walked, { scoped: true });

    assert.equal(removed, 0, 'scoped run must remove nothing');
    assert.equal(
      getEdgesFrom(db, '0-inbox/c.md').length,
      1,
      '0-inbox edge must survive a 3-permanent-scoped run',
    );
    assert.equal(
      getEdgesFrom(db, '4-projects/d.md').length,
      1,
      '4-projects edge must survive a 3-permanent-scoped run',
    );
    db.close();
  });

  it('an unscoped run removes edges whose source note was not walked (genuine orphans)', async () => {
    const db = await seed();
    // Full walk that no longer sees 4-projects/d.md (note deleted from vault).
    const walked = new Set(['3-permanent/a.md', '0-inbox/c.md']);
    const { removed } = removeOrphanEdges(db, walked, { scoped: false });

    assert.equal(removed, 1, 'the one genuine orphan edge is removed');
    assert.equal(getEdgesFrom(db, '4-projects/d.md').length, 0, 'orphan edge removed');
    assert.equal(getEdgesFrom(db, '0-inbox/c.md').length, 1, 'walked note keeps its edge');
    db.close();
  });

  // The gate that decides whether a run is "scoped" (and therefore skips orphan
  // removal) must agree with walkVault's own truncation, which triggers for ANY
  // truthy limit — `if (max && out.length >= max)`. A limit of -5 truncates the
  // walk to one file, so it MUST be treated as scoped; otherwise a one-file walk
  // is mistaken for a full vault and orphan removal wipes the whole edge graph.
  it('treats a negative --limit as scoped (walkVault truncates on any truthy limit)', () => {
    assert.equal(isScopedRun({ folderFilter: null, limit: -5 }), true);
    assert.equal(isScopedRun({ folderFilter: null, limit: -1 }), true);
  });

  it('treats a positive --limit as scoped', () => {
    assert.equal(isScopedRun({ folderFilter: null, limit: 10 }), true);
  });

  it('treats a --folder run as scoped regardless of limit', () => {
    assert.equal(isScopedRun({ folderFilter: '3-permanent', limit: 0 }), true);
  });

  it('treats a full run (no folder, no/zero/NaN limit) as unscoped', () => {
    // parseInt('' || '0') === 0, parseInt('abc') === NaN — both mean "no limit",
    // and walkVault does not truncate (0 and NaN are falsy), so the run is full.
    assert.equal(isScopedRun({ folderFilter: null, limit: 0 }), false);
    assert.equal(isScopedRun({ folderFilter: null, limit: Number.NaN }), false);
  });

  it('archived edges are never removed even on an unscoped run', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, {
      fromPath: '9-archive/old.md',
      toPath: '3-permanent/b.md',
      edgeType: 'evidence_for',
      sourceGraph: 'archived',
    });
    saveDb(db, DB_PATH);
    const { removed } = removeOrphanEdges(db, new Set(), { scoped: false });
    assert.equal(removed, 0, 'archived edges are excluded from orphan removal');
    db.close();
  });
});
