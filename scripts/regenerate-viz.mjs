#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
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

function fmtConfidence(n) {
  return n == null ? '—' : n.toFixed(2);
}

function fmtDate(s) {
  if (!s) return '—';
  return s.split(' ')[0] || s.slice(0, 10);
}

export async function runHeatmapPhase(db, vaultRoot, { syncThreshold = 0.95, dryRun = false } = {}) {
  const { getAllNliEdgesForHeatmap } = await import('./lib/edges.mjs');
  const rows = getAllNliEdgesForHeatmap(db);
  const totalAtSync = rows.filter((r) => r.confidenceScore != null && r.confidenceScore >= syncThreshold).length;

  const lines = [];
  lines.push('---');
  lines.push('tags: [system, nli, generated]');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push('# NLI conflicts');
  lines.push('');
  lines.push('Generated by `/learning-loop:viz`. Do not edit by hand — overwritten on every regen.');
  lines.push('');
  lines.push(`Total contradictions: ${rows.length} (synced to frontmatter at p>=${syncThreshold}: ${totalAtSync})`);
  lines.push('');
  lines.push('| Source | Target | p(contradict) | Created |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    const fromSlug = r.fromPath.replace(/\.md$/, '').split('/').pop();
    const toSlug = r.toPath.replace(/\.md$/, '').split('/').pop();
    const belowMark = r.confidenceScore != null && r.confidenceScore < syncThreshold ? ' (below sync threshold)' : '';
    const peerMark = r.sourceGraph && r.sourceGraph !== 'nli' ? ` [peer: ${r.sourceGraph}]` : '';
    lines.push(`| [[${fromSlug}]]${peerMark}${belowMark} | [[${toSlug}]] | ${fmtConfidence(r.confidenceScore)} | ${fmtDate(r.createdAt)} |`);
  }
  lines.push('');

  const heatmapPath = join(vaultRoot, '_system', 'nli-conflicts.md');
  if (!dryRun) {
    mkdirSync(join(vaultRoot, '_system'), { recursive: true });
    const newContent = lines.join('\n');
    const stripTimestamp = (s) => s.replace(/^generated:.*$/m, 'generated:');
    let existingStripped = null;
    try {
      existingStripped = stripTimestamp(readFileSync(heatmapPath, 'utf-8'));
    } catch {
      /* file missing — treat as changed */
    }
    if (existingStripped === null || existingStripped !== stripTimestamp(newContent)) {
      writeFileSync(heatmapPath, newContent);
    }
  }
  return { rows: rows.length };
}

function isContradictionEdgeShape(e) {
  return e.sourceGraph === 'nli' || (typeof e.edgeType === 'string' && e.edgeType.startsWith('challenges_'));
}

function makeCanvasNode(id, x, y, file) {
  return { id, type: 'file', file, x, y, width: 280, height: 60 };
}

function makeCanvasTextNode(id, x, y, text) {
  return { id, type: 'text', text, x, y, width: 400, height: 100 };
}

function makeCanvasEdge(id, from, to, color) {
  const obj = { id, fromNode: from, toNode: to, fromSide: 'right', toSide: 'left' };
  if (color) obj.color = color;
  return obj;
}

function layoutCycle(cycleIdx, cycle) {
  const col = cycleIdx % 3;
  const row = Math.floor(cycleIdx / 3);
  const baseX = col * 480;
  const baseY = row * 360;
  const radius = 130;
  const n = cycle.nodes.length;
  const positions = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    positions.push({
      x: Math.round(baseX + radius * Math.cos(angle)),
      y: Math.round(baseY + radius * Math.sin(angle)),
    });
  }
  return positions;
}

export async function runCyclesPhase(db, vaultRoot, { maxDepth = 4, dryRun = false } = {}) {
  const { findContradictionCycles } = await import('./lib/cycle-detect.mjs');
  const { getEdgesForCycleDetection } = await import('./lib/edges.mjs');
  const edges = getEdgesForCycleDetection(db);
  const cycles = findContradictionCycles(edges, { maxDepth });

  const canvas = { nodes: [], edges: [] };
  let nodeIdCounter = 0;
  let edgeIdCounter = 0;

  if (cycles.length === 0) {
    canvas.nodes.push(
      makeCanvasTextNode(
        `node-${nodeIdCounter++}`,
        0,
        0,
        'No contradiction cycles detected yet.\n\nCycles surface when transitive contradiction chains form across your notes. Regenerated by /learning-loop:viz.',
      ),
    );
  } else {
    for (let cIdx = 0; cIdx < cycles.length; cIdx++) {
      const cycle = cycles[cIdx];
      const positions = layoutCycle(cIdx, cycle);
      const nodeIdByPath = new Map();
      for (let i = 0; i < cycle.nodes.length; i++) {
        const path = cycle.nodes[i];
        const id = `node-${nodeIdCounter++}`;
        nodeIdByPath.set(path, id);
        canvas.nodes.push(makeCanvasNode(id, positions[i].x, positions[i].y, path));
      }
      for (const e of cycle.edges) {
        const id = `edge-${edgeIdCounter++}`;
        const from = nodeIdByPath.get(e.fromPath);
        const to = nodeIdByPath.get(e.toPath);
        const color = isContradictionEdgeShape(e) ? '1' : undefined;
        canvas.edges.push(makeCanvasEdge(id, from, to, color));
      }
    }
  }

  const canvasPath = join(vaultRoot, '_system', 'viz', 'cycles.canvas');
  if (!dryRun) {
    mkdirSync(join(vaultRoot, '_system', 'viz'), { recursive: true });
    writeFileSync(canvasPath, JSON.stringify(canvas, null, 2));
  }
  return { cycles: cycles.length };
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
    if (!flags.skipHeatmap) {
      const r = await runHeatmapPhase(db, VAULT_PATH, {
        syncThreshold: 0.95,
        dryRun: flags.dryRun,
      });
      counts.heatmapRows = r.rows;
    }
    if (!flags.skipCycles) {
      const r = await runCyclesPhase(db, VAULT_PATH, {
        maxDepth: 4,
        dryRun: flags.dryRun,
      });
      counts.cyclesFound = r.cycles;
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
