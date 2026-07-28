#!/usr/bin/env node
// backfill-edges.mjs — Walk the vault and populate the justification index for
// every existing note. Re-runnable; the per-note removeOutgoingEdges call makes
// each pass idempotent.
//
// Usage:
//   node backfill-edges.mjs                  # full run, write to DB
//   node backfill-edges.mjs --dry-run        # classify but do not write
//   node backfill-edges.mjs --folder 3-permanent
//   node backfill-edges.mjs --limit 100      # cap notes processed (handy for spot-checks)
//
// Frontmatter sync is INTENTIONALLY off in backfill — only the post-write hook
// touches frontmatter, so re-running backfill never mutates note content.

import { readFileSync } from 'fs';
import { basename, sep } from 'path';
import { pathToFileURL } from 'url';
import { logError } from './lib/log.mjs';
import { PLUGIN_DATA, VAULT_PATH } from './lib/constants.mjs';
import { DATA_FILES } from './lib/paths.mjs';
import {
  openEdgeDb,
  addEdge,
  removeOutgoingEdges,
  saveDb,
  acquireLock,
  releaseLock,
} from './lib/edges.mjs';
import { classifyNoteEdges, buildVaultIndex, makeResolver } from './lib/edge-classifier.mjs';
import { hasFlag, flagValue } from './lib/cli-args.mjs';
import { listVaultNotes } from './lib/vault-walk.mjs';

const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];

// CLI-only state is resolved inside main(), never at module scope. PLUGIN_DATA
// is null wherever plugin-data isn't configured, and `DATA_FILES.edgesDb(null)`
// throws — so computing it here crashed every importer of the pure exports
// below on any machine without plugin-data, CI included.

// Truncates on any TRUTHY max, floored at one file (a negative --limit walks
// one file, never zero); isScopedRun must agree with this predicate.
function walkVault(root, dirs, max) {
  const files = listVaultNotes(root, { dirs }).map((n) => n.path);
  return max ? files.slice(0, Math.max(max, 1)) : files;
}

function countOrphanEdges(db, orphanFromPaths) {
  let total = 0;
  for (const orphan of orphanFromPaths) {
    const res = db.exec(
      "SELECT COUNT(*) FROM edges WHERE from_path = ? AND source_graph != 'archived'",
      [orphan],
    );
    total += res[0] ? res[0].values[0][0] : 0;
  }
  return total;
}

// A from_path is an orphan only when the walk that produced walkedSourceRels
// covered the WHOLE vault. On a scoped run (--folder or --limit) the un-walked
// set is not the orphaned set, so there are no orphans to remove.
export function findOrphanFromPaths(db, walkedSourceRels, { scoped }) {
  if (scoped) return [];
  const res = db.exec('SELECT DISTINCT from_path FROM edges');
  const allFromPaths = res[0] ? res[0].values.map((r) => r[0]) : [];
  return allFromPaths.filter((fp) => !walkedSourceRels.has(fp));
}

// Removes edges whose source note no longer exists in a full vault walk.
// No-ops on a scoped run — see findOrphanFromPaths. Never touches archived edges.
export function removeOrphanEdges(db, walkedSourceRels, { scoped }) {
  const orphanFromPaths = findOrphanFromPaths(db, walkedSourceRels, { scoped });
  let removed = 0;
  for (const orphan of orphanFromPaths) {
    const countRes = db.exec(
      "SELECT COUNT(*) FROM edges WHERE from_path = ? AND source_graph != 'archived'",
      [orphan],
    );
    const count = countRes[0] ? countRes[0].values[0][0] : 0;
    if (count > 0) {
      db.run("DELETE FROM edges WHERE from_path = ? AND source_graph != 'archived'", [orphan]);
      removed += count;
    }
  }
  return { removed, orphanCount: orphanFromPaths.length };
}

// A run is scoped (walked only part of the vault) when a --folder is given, or
// when --limit truncated the walk. walkVault truncates on any TRUTHY limit, so
// this must too: Boolean(limit) is true for a negative limit and false only
// for 0/NaN. A positive-only check would mis-flag a negative-limit one-file
// walk as a full run and wipe the edge graph on removal.
export function isScopedRun({ folderFilter, limit }) {
  return Boolean(folderFilter) || Boolean(limit);
}

async function main() {
  if (!VAULT_PATH) {
    console.error('VAULT_PATH not configured');
    process.exit(1);
  }
  if (!PLUGIN_DATA) {
    console.error('plugin data dir not configured');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = hasFlag(args, '--dry-run');
  const folderFilter = flagValue(args, '--folder');
  const limit = parseInt(flagValue(args, '--limit') || '0', 10);
  const DB_FILE = DATA_FILES.edgesDb(PLUGIN_DATA);

  const folders = folderFilter ? [folderFilter] : VAULT_DIRS;
  const files = walkVault(VAULT_PATH, folders, limit);
  const scoped = isScopedRun({ folderFilter, limit });
  console.error(`Scanning ${files.length} notes from ${folders.join(', ')}...`);

  console.error('Building vault index for link resolution...');
  const resolver = makeResolver(buildVaultIndex(VAULT_PATH));

  const stats = {
    notes_scanned: 0,
    notes_with_edges: 0,
    edges_total: 0,
    by_type: {},
    by_confidence: { high: 0, medium: 0 },
  };

  const walkedSourceRels = new Set(
    files.map((fp) =>
      fp
        .slice(VAULT_PATH.length + 1)
        .split(sep)
        .join('/'),
    ),
  );

  if (!dryRun && !acquireLock(DB_FILE)) {
    console.error('edges: another writer holds the lock; retry shortly');
    process.exit(1);
  }

  try {
    const db = dryRun ? null : await openEdgeDb(DB_FILE);

    let progress = 0;
    for (const filePath of files) {
      progress++;
      if (progress % 100 === 0) {
        console.error(`  ${progress}/${files.length} (edges so far: ${stats.edges_total})`);
      }
      let content;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (err) {
        logError('backfill-edges.readFile', err);
        continue;
      }

      const sourceName = basename(filePath, '.md');
      const sourceRel = filePath
        .slice(VAULT_PATH.length + 1)
        .split(sep)
        .join('/');
      const classified = classifyNoteEdges(content, sourceName, resolver);

      stats.notes_scanned++;

      if (db) {
        removeOutgoingEdges(db, sourceRel);
      }

      if (classified.length === 0) continue;
      stats.notes_with_edges++;

      for (const edge of classified) {
        stats.edges_total++;
        stats.by_type[edge.edgeType] = (stats.by_type[edge.edgeType] || 0) + 1;
        stats.by_confidence[edge.confidence]++;
        if (db) {
          addEdge(db, {
            fromPath: sourceRel,
            toPath: edge.toPath,
            edgeType: edge.edgeType,
            confidence: edge.confidence,
            directionFlipped: edge.flip ? 1 : 0,
          });
        }
      }
    }

    if (db) {
      const { removed, orphanCount } = removeOrphanEdges(db, walkedSourceRels, { scoped });
      stats.orphans_removed = removed;
      stats.orphan_from_paths = orphanCount;
      saveDb(db, DB_FILE);
      db.close();
    } else {
      const dryDb = await openEdgeDb(DB_FILE);
      try {
        const orphanFromPaths = findOrphanFromPaths(dryDb, walkedSourceRels, { scoped });
        stats.orphans_would_remove = countOrphanEdges(dryDb, orphanFromPaths);
        stats.orphan_from_paths = orphanFromPaths.length;
      } finally {
        dryDb.close();
      }
    }
  } finally {
    if (!dryRun) releaseLock(DB_FILE);
  }

  console.log(JSON.stringify({ ...stats, dry_run: dryRun }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
