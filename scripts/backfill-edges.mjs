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

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, sep } from 'path';
import { PLUGIN_DATA, VAULT_PATH } from './lib/constants.mjs';
import { openEdgeDb, addEdge, removeOutgoingEdges, saveDb } from './lib/edges.mjs';
import { classifyNoteEdges, buildVaultIndex, makeResolver } from './lib/edge-classifier.mjs';

const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];
const DB_FILE = join(PLUGIN_DATA, 'edges.db');

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function flagValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const dryRun = hasFlag('--dry-run');
const folderFilter = flagValue('--folder');
const limit = parseInt(flagValue('--limit') || '0', 10);

function walkVault(root, dirs, max) {
  const out = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    try {
      const entries = readdirSync(dirPath, { recursive: true });
      for (const e of entries) {
        const full = join(dirPath, String(e));
        try {
          const st = statSync(full);
          if (!st.isFile()) continue;
        } catch { continue; }
        if (!String(e).endsWith('.md')) continue;
        out.push(full);
        if (max && out.length >= max) return out;
      }
    } catch {}
  }
  return out;
}

function countOrphanEdges(db, orphanFromPaths) {
  let total = 0;
  for (const orphan of orphanFromPaths) {
    const res = db.exec("SELECT COUNT(*) FROM edges WHERE from_path = ? AND source_graph != 'archived'", [orphan]);
    total += res[0] ? res[0].values[0][0] : 0;
  }
  return total;
}

async function main() {
  if (!VAULT_PATH) {
    console.error('VAULT_PATH not configured');
    process.exit(1);
  }

  const folders = folderFilter ? [folderFilter] : VAULT_DIRS;
  const files = walkVault(VAULT_PATH, folders, limit);
  console.error(`Scanning ${files.length} notes from ${folders.join(', ')}...`);

  console.error('Building vault index for link resolution...');
  const resolver = makeResolver(buildVaultIndex(VAULT_PATH));

  const db = dryRun ? null : await openEdgeDb(DB_FILE);
  const stats = {
    notes_scanned: 0,
    notes_with_edges: 0,
    edges_total: 0,
    by_type: {},
    by_confidence: { high: 0, medium: 0 },
  };

  const walkedSourceRels = new Set(files.map(fp => fp.slice(VAULT_PATH.length + 1).split(sep).join('/')));

  let progress = 0;
  for (const filePath of files) {
    progress++;
    if (progress % 100 === 0) {
      console.error(`  ${progress}/${files.length} (edges so far: ${stats.edges_total})`);
    }
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

    const sourceName = basename(filePath, '.md');
    const sourceRel = filePath.slice(VAULT_PATH.length + 1).split(sep).join('/');
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
    const allFromPathsRes = db.exec('SELECT DISTINCT from_path FROM edges');
    const allFromPaths = allFromPathsRes[0] ? allFromPathsRes[0].values.map(r => r[0]) : [];
    const orphanFromPaths = allFromPaths.filter(fp => !walkedSourceRels.has(fp));
    let orphansRemoved = 0;
    for (const orphan of orphanFromPaths) {
      const countRes = db.exec("SELECT COUNT(*) FROM edges WHERE from_path = ? AND source_graph != 'archived'", [orphan]);
      const count = countRes[0] ? countRes[0].values[0][0] : 0;
      if (count > 0) {
        db.run("DELETE FROM edges WHERE from_path = ? AND source_graph != 'archived'", [orphan]);
        orphansRemoved += count;
      }
    }
    stats.orphans_removed = orphansRemoved;
    stats.orphan_from_paths = orphanFromPaths.length;
    saveDb(db, DB_FILE);
    db.close();
  } else {
    const dryDb = await openEdgeDb(DB_FILE);
    try {
      const allFromPathsRes = dryDb.exec('SELECT DISTINCT from_path FROM edges');
      const allFromPaths = allFromPathsRes[0] ? allFromPathsRes[0].values.map(r => r[0]) : [];
      const orphanFromPaths = allFromPaths.filter(fp => !walkedSourceRels.has(fp));
      stats.orphans_would_remove = countOrphanEdges(dryDb, orphanFromPaths);
      stats.orphan_from_paths = orphanFromPaths.length;
    } finally {
      dryDb.close();
    }
  }

  console.log(JSON.stringify({ ...stats, dry_run: dryRun }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
