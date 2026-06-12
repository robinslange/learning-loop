#!/usr/bin/env node
// nli-cleanup.mjs — One-shot data cleanup for the removed NLI contradiction subsystem.
//
// Removes NLI artifacts from existing edges.db databases and vault note frontmatter:
//   1. Deletes all rows where source_graph='nli' from edges.db
//   2. Drops viz_meta and nli_frontmatter_tags tables if they exist
//   3. Strips nli-contradicts:, has-contradiction:, nli_tension: frontmatter keys
//      from vault notes
//
// --dry-run (DEFAULT): scan and report what would be changed without writing.
// --execute:           apply all changes. Requires explicit flag.
//
// Usage:
//   node nli-cleanup.mjs                     # dry-run (default)
//   node nli-cleanup.mjs --dry-run           # explicit dry-run
//   node nli-cleanup.mjs --execute           # apply changes
//   node nli-cleanup.mjs --db <path>         # override edges.db path
//   node nli-cleanup.mjs --vault <path>      # override vault path
//
// Safe to re-run: all operations are idempotent.
// Do NOT run against the live vault until you have reviewed the dry-run output.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLUGIN_DATA, VAULT_PATH } from './lib/constants.mjs';
import { DATA_FILES } from './lib/paths.mjs';
import { openEdgeDb, saveDb } from './lib/edges.mjs';

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function flagValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const dryRun = !hasFlag('--execute');
const dbPathOverride = flagValue('--db');
const vaultPathOverride = flagValue('--vault');

const dbPath = dbPathOverride
  ? resolve(dbPathOverride)
  : PLUGIN_DATA
    ? DATA_FILES.edgesDb(PLUGIN_DATA)
    : null;

const vaultPath = vaultPathOverride ? resolve(vaultPathOverride) : VAULT_PATH;

if (dryRun) {
  console.log('[nli-cleanup] DRY-RUN mode (pass --execute to apply changes)');
} else {
  console.log('[nli-cleanup] EXECUTE mode — changes will be written');
}

// ─── Step 1: Clean edges.db ──────────────────────────────────────────────────

let nliEdgesDeleted = 0;
let tablesDropped = [];

if (!dbPath) {
  console.log(
    '[nli-cleanup] edges.db: no PLUGIN_DATA resolved and no --db flag; skipping DB cleanup',
  );
} else if (!existsSync(dbPath)) {
  console.log(`[nli-cleanup] edges.db: not found at ${dbPath}; skipping DB cleanup`);
} else {
  const db = await openEdgeDb(dbPath);
  try {
    const countRes = db.exec("SELECT COUNT(*) FROM edges WHERE source_graph='nli'");
    const count = countRes[0] ? Number(countRes[0].values[0][0]) : 0;
    nliEdgesDeleted = count;

    if (count > 0) {
      if (dryRun) {
        console.log(
          `[nli-cleanup] edges.db: would delete ${count} NLI edge row(s) (source_graph='nli')`,
        );
      } else {
        db.run("DELETE FROM edges WHERE source_graph='nli'");
        console.log(`[nli-cleanup] edges.db: deleted ${count} NLI edge row(s)`);
      }
    } else {
      console.log('[nli-cleanup] edges.db: no NLI edge rows found (already clean)');
    }

    for (const tableName of ['viz_meta', 'nli_frontmatter_tags']) {
      const tableCheckRes = db.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`,
      );
      if (tableCheckRes[0] && tableCheckRes[0].values.length > 0) {
        tablesDropped.push(tableName);
        if (dryRun) {
          console.log(`[nli-cleanup] edges.db: would drop table ${tableName}`);
        } else {
          db.run(`DROP TABLE IF EXISTS ${tableName}`);
          console.log(`[nli-cleanup] edges.db: dropped table ${tableName}`);
        }
      }
    }

    if (!dryRun && (nliEdgesDeleted > 0 || tablesDropped.length > 0)) {
      saveDb(db, dbPath);
      console.log(`[nli-cleanup] edges.db: saved to ${dbPath}`);
    }
  } finally {
    db.close();
  }
}

// ─── Step 2: Clean vault frontmatter ─────────────────────────────────────────

const NLI_FRONTMATTER_KEYS = [
  'nli-contradicts',
  'has-contradiction',
  'nli_tension',
  'nli_tension_partners',
  'nli_qualified_by',
  'nli_resolved',
];

const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];

function walkVault(root, dirs) {
  const out = [];
  for (const dir of dirs) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(join(full, entry.name));
      }
    }
  }
  return out;
}

function stripNliFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---(\n?)/);
  if (!fmMatch) return { changed: false, content };

  const fmBody = fmMatch[1];
  const trailingNewline = fmMatch[2];
  const afterFm = content.slice(fmMatch[0].length);

  const lines = fmBody.split('\n');
  const filtered = lines.filter((line) => {
    const key = line.match(/^(\S+):\s*/)?.[1];
    if (!key) return true;
    return !NLI_FRONTMATTER_KEYS.includes(key);
  });

  if (filtered.length === lines.length) return { changed: false, content };

  const newFm = filtered.join('\n');
  const newContent = '---\n' + newFm + '\n---' + trailingNewline + afterFm;
  return { changed: true, content: newContent };
}

let notesScanned = 0;
let notesChanged = 0;

if (!vaultPath) {
  console.log(
    '[nli-cleanup] vault: no VAULT_PATH resolved and no --vault flag; skipping frontmatter cleanup',
  );
} else if (!existsSync(vaultPath)) {
  console.log(`[nli-cleanup] vault: not found at ${vaultPath}; skipping frontmatter cleanup`);
} else {
  const notes = walkVault(vaultPath, VAULT_DIRS);
  notesScanned = notes.length;

  for (const notePath of notes) {
    let raw;
    try {
      raw = readFileSync(notePath, 'utf-8');
    } catch {
      continue;
    }

    const { changed, content } = stripNliFrontmatter(raw);
    if (!changed) continue;

    notesChanged++;
    if (dryRun) {
      console.log(`[nli-cleanup] would strip NLI frontmatter from: ${notePath}`);
    } else {
      writeFileSync(notePath, content, 'utf-8');
      console.log(`[nli-cleanup] stripped NLI frontmatter from: ${notePath}`);
    }
  }

  console.log(
    `[nli-cleanup] vault: scanned ${notesScanned} note(s), ${notesChanged} would be / were changed`,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
console.log('[nli-cleanup] Summary:');
console.log(`  NLI edge rows:      ${nliEdgesDeleted} (${dryRun ? 'would delete' : 'deleted'})`);
console.log(
  `  Tables dropped:     ${tablesDropped.length > 0 ? tablesDropped.join(', ') : 'none'} (${dryRun ? 'would drop' : 'dropped'})`,
);
console.log(
  `  Notes with NLI fm:  ${notesChanged} / ${notesScanned} (${dryRun ? 'would strip' : 'stripped'})`,
);
if (dryRun) {
  console.log('');
  console.log('[nli-cleanup] Re-run with --execute to apply changes.');
}
