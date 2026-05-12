#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export function parseFlags(argv) {
  const flags = {
    dryRun: false,
    skipFrontmatter: false,
    skipHeatmap: false,
    skipCycles: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--no-frontmatter':
        flags.skipFrontmatter = true;
        break;
      case '--no-heatmap':
        flags.skipHeatmap = true;
        break;
      case '--no-cycles':
        flags.skipCycles = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

const EXCLUDED_DIRS = new Set(['_system', '.obsidian', '.trash', 'node_modules', '.git']);

const NLI_KEYS = new Set(['nli-contradicts', 'has-contradiction']);

function formatInlineArray(items) {
  return '[' + items.map((s) => `"${s}"`).join(', ') + ']';
}

export function syncNoteFrontmatter(filePath, wikilinks) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---(\n?)/);
  const hasFm = !!fmMatch;
  const fmBody = hasFm ? fmMatch[1] : '';
  const trailingNewline = hasFm ? fmMatch[2] : '\n';
  const afterFm = hasFm ? content.slice(fmMatch[0].length) : content;

  let lines = hasFm ? fmBody.split('\n') : [];

  const filtered = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-zA-Z_-]+):/);
    if (m && NLI_KEYS.has(m[1])) {
      const valueAfterColon = lines[i].slice(m[1].length + 1).trim();
      if (valueAfterColon === '') {
        let j = i + 1;
        while (j < lines.length && /^\s*-\s+/.test(lines[j])) j++;
        i = j - 1;
      }
      continue;
    }
    filtered.push(lines[i]);
  }
  lines = filtered;

  if (wikilinks.length > 0) {
    lines.push(`nli-contradicts: ${formatInlineArray(wikilinks)}`);
    lines.push('has-contradiction: true');
  }

  if (lines.length === 0 && !hasFm && wikilinks.length === 0) {
    return false;
  }

  const newFm =
    lines.length > 0
      ? '---\n' + lines.join('\n') + '\n---' + (trailingNewline || '\n')
      : '';
  const newContent = newFm + afterFm;
  if (newContent === content) return false;
  writeFileSync(filePath, newContent);
  return true;
}

function walkVaultNotes(root, relative = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, relative), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const top = rel.split('/')[0];
      if (EXCLUDED_DIRS.has(top)) continue;
      out.push(...walkVaultNotes(root, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

function basenameSlug(p) {
  return basename(p, '.md');
}

export async function runFrontmatterPhase(db, vaultRoot, { threshold = 0.95, dryRun = false } = {}) {
  const { getNliEdgesForFrontmatter } = await import('./lib/edges.mjs');
  const rows = getNliEdgesForFrontmatter(db, threshold);

  const desired = new Map();
  for (const r of rows) {
    if (!desired.has(r.fromPath)) desired.set(r.fromPath, []);
    desired.get(r.fromPath).push(`[[${basenameSlug(r.toPath)}]]`);
  }

  const allNotes = walkVaultNotes(vaultRoot);
  const currentlyTagged = new Set();
  for (const rel of allNotes) {
    let content;
    try {
      content = readFileSync(join(vaultRoot, rel), 'utf-8');
    } catch {
      continue;
    }
    if (/^---\n[\s\S]*?nli-contradicts:/m.test(content.slice(0, 4096))) {
      currentlyTagged.add(rel);
    }
  }

  const counts = { updated: 0, cleared: 0 };

  for (const [fromPath, wikilinks] of desired.entries()) {
    const top = fromPath.split('/')[0];
    if (EXCLUDED_DIRS.has(top)) continue;
    const abs = join(vaultRoot, fromPath);
    if (dryRun) {
      counts.updated++;
      continue;
    }
    const changed = syncNoteFrontmatter(abs, wikilinks);
    if (changed) counts.updated++;
  }

  for (const rel of currentlyTagged) {
    if (desired.has(rel)) continue;
    const top = rel.split('/')[0];
    if (EXCLUDED_DIRS.has(top)) continue;
    const abs = join(vaultRoot, rel);
    if (dryRun) {
      counts.cleared++;
      continue;
    }
    const changed = syncNoteFrontmatter(abs, []);
    if (changed) counts.cleared++;
  }

  return counts;
}

async function main(argv) {
  const flags = parseFlags(argv);
  const { PLUGIN_DATA, VAULT_PATH } = await import('./lib/constants.mjs');
  if (!PLUGIN_DATA) {
    console.error('plugin data dir not resolvable');
    process.exit(1);
  }
  if (!VAULT_PATH) {
    console.error('vault root not resolvable');
    process.exit(1);
  }
  const dbPath = join(PLUGIN_DATA, 'edges.db');
  const counts = {
    frontmatterUpdated: 0,
    frontmatterCleared: 0,
    heatmapRows: 0,
    cyclesFound: 0,
  };

  const { openEdgeDb } = await import('./lib/edges.mjs');
  const db = await openEdgeDb(dbPath);

  try {
    if (!flags.skipFrontmatter) {
      const r = await runFrontmatterPhase(db, VAULT_PATH, {
        threshold: 0.95,
        dryRun: flags.dryRun,
      });
      counts.frontmatterUpdated = r.updated;
      counts.frontmatterCleared = r.cleared;
    }
  } finally {
    db.close();
  }

  console.log(JSON.stringify({ ok: true, flags, counts }, null, 2));
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.stack || err);
    process.exit(1);
  });
}
