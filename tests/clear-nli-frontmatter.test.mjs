import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAllNliFrontmatter } from '../scripts/clear-nli-frontmatter.mjs';
import { openEdgeDb, saveDb, getMetaFlag, setMetaFlag } from '../scripts/lib/edges.mjs';

const CONFLICTS_REL = '_system/nli-conflicts.md';
const CYCLES_REL = '_system/viz/cycles.canvas';

function seedVault() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-clear-'));
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  mkdirSync(join(vaultRoot, '_system', 'viz'), { recursive: true });
  return vaultRoot;
}

test('strips NLI keys from every affected note, leaves others alone', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-clear-'));
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  const a = join(vaultRoot, '3-permanent', 'a.md');
  const b = join(vaultRoot, '3-permanent', 'b.md');
  writeFileSync(
    a,
    '---\ntags: [foo]\nnli-contradicts: ["[[x]]"]\nhas-contradiction: true\n---\n\n# A\n',
  );
  writeFileSync(b, '---\nrelated: ["[[y]]"]\n---\n\n# B\n');

  const counts = await clearAllNliFrontmatter(vaultRoot);
  assert.equal(counts.cleared, 1);

  const aContent = readFileSync(a, 'utf-8');
  assert.doesNotMatch(aContent, /nli-contradicts/);
  assert.doesNotMatch(aContent, /has-contradiction/);
  assert.match(aContent, /tags: \[foo\]/);

  const bContent = readFileSync(b, 'utf-8');
  assert.match(bContent, /related: \["\[\[y\]\]"\]/);

  rmSync(vaultRoot, { recursive: true, force: true });
});

test('rollback renames both artifacts to .bak when present', async () => {
  const vaultRoot = seedVault();
  const conflicts = join(vaultRoot, CONFLICTS_REL);
  const cycles = join(vaultRoot, CYCLES_REL);
  writeFileSync(conflicts, '# conflicts artifact original\n');
  writeFileSync(cycles, '{"nodes":[],"edges":[]}\n');

  const counts = await clearAllNliFrontmatter(vaultRoot);

  assert.equal(existsSync(conflicts), false, 'original conflicts file should be renamed');
  assert.equal(existsSync(cycles), false, 'original cycles file should be renamed');
  assert.equal(existsSync(`${conflicts}.bak`), true, 'conflicts .bak should exist');
  assert.equal(existsSync(`${cycles}.bak`), true, 'cycles .bak should exist');

  assert.ok(
    counts.artifactsRemoved.includes(`${CONFLICTS_REL} → ${CONFLICTS_REL}.bak`),
    `expected conflicts rename entry; got: ${JSON.stringify(counts.artifactsRemoved)}`,
  );
  assert.ok(
    counts.artifactsRemoved.includes(`${CYCLES_REL} → ${CYCLES_REL}.bak`),
    `expected cycles rename entry; got: ${JSON.stringify(counts.artifactsRemoved)}`,
  );

  rmSync(vaultRoot, { recursive: true, force: true });
});

test('rollback overwrites pre-existing .bak files with current artifact content', async () => {
  const vaultRoot = seedVault();
  const conflicts = join(vaultRoot, CONFLICTS_REL);
  const cycles = join(vaultRoot, CYCLES_REL);

  // Prior .bak files simulate an earlier rollback. These must be replaced —
  // the newest artifact is the most useful thing to keep recoverable.
  writeFileSync(`${conflicts}.bak`, 'OLD conflicts bak from a previous rollback\n');
  writeFileSync(`${cycles}.bak`, 'OLD cycles bak from a previous rollback\n');

  const newConflicts = '# NEW conflicts artifact written by latest /viz run\n';
  const newCycles = '{"nodes":[{"id":"n1"}],"edges":[]}\n';
  writeFileSync(conflicts, newConflicts);
  writeFileSync(cycles, newCycles);

  await clearAllNliFrontmatter(vaultRoot);

  assert.equal(readFileSync(`${conflicts}.bak`, 'utf-8'), newConflicts);
  assert.equal(readFileSync(`${cycles}.bak`, 'utf-8'), newCycles);
  assert.equal(existsSync(conflicts), false);
  assert.equal(existsSync(cycles), false);

  rmSync(vaultRoot, { recursive: true, force: true });
});

test('rollback tolerates missing artifacts and renames only the one present', async () => {
  const vaultRoot = seedVault();
  const conflicts = join(vaultRoot, CONFLICTS_REL);
  const cycles = join(vaultRoot, CYCLES_REL);

  writeFileSync(conflicts, '# only conflicts exists\n');

  const counts = await clearAllNliFrontmatter(vaultRoot);

  assert.equal(existsSync(`${conflicts}.bak`), true);
  assert.equal(existsSync(conflicts), false);
  assert.equal(existsSync(`${cycles}.bak`), false, 'no cycles.bak should be produced');
  assert.equal(existsSync(cycles), false);

  assert.deepEqual(counts.artifactsRemoved, [`${CONFLICTS_REL} → ${CONFLICTS_REL}.bak`]);

  rmSync(vaultRoot, { recursive: true, force: true });
});

test('rollback with db resets bootstrap flag to "0"', async () => {
  const vaultRoot = seedVault();
  const dbDir = mkdtempSync(join(tmpdir(), 'll-clear-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);

  // Pre-populate the flag — the rollback is the thing that resets it to '0'.
  setMetaFlag(db, 'nli_frontmatter_index_bootstrapped_v1', '1');
  saveDb(db, dbPath);

  await clearAllNliFrontmatter(vaultRoot, db);

  assert.equal(getMetaFlag(db, 'nli_frontmatter_index_bootstrapped_v1'), '0');

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});
