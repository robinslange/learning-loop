#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { syncNoteFrontmatter } from './regenerate-viz.mjs';

const EXCLUDED = new Set(['_system', '.obsidian', '.trash', 'node_modules', '.git']);

function walk(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      const top = r.split('/')[0];
      if (EXCLUDED.has(top)) continue;
      out.push(...walk(root, r));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(r);
    }
  }
  return out;
}

export async function clearAllNliFrontmatter(vaultRoot, db = null) {
  const counts = { cleared: 0 };
  for (const rel of walk(vaultRoot)) {
    const abs = join(vaultRoot, rel);
    let content;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    if (!/nli-contradicts:|has-contradiction:/.test(content.slice(0, 4096))) continue;
    const changed = syncNoteFrontmatter(abs, []);
    if (changed) counts.cleared++;
  }
  if (db) {
    const { replaceTaggedNotes } = await import('./lib/edges.mjs');
    replaceTaggedNotes(db, []);
  }
  return counts;
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  const { VAULT_PATH, PLUGIN_DATA } = await import('./lib/constants.mjs');
  if (!VAULT_PATH) {
    console.error('vault root not resolvable');
    process.exit(1);
  }
  let db = null;
  let dbPath = null;
  if (PLUGIN_DATA) {
    const { openEdgeDb } = await import('./lib/edges.mjs');
    dbPath = join(PLUGIN_DATA, 'edges.db');
    db = await openEdgeDb(dbPath);
  }
  const counts = await clearAllNliFrontmatter(VAULT_PATH, db);
  if (db) {
    const { saveDb } = await import('./lib/edges.mjs');
    try {
      saveDb(db, dbPath);
    } catch (err) {
      console.error('clear-nli: saveDb failed:', err.message);
    }
    db.close();
  }
  console.log(JSON.stringify(counts, null, 2));
}
