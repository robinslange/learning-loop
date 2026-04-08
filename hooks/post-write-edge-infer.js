#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { runHook, resolvePluginData, resolveVaultPath } from './lib/common.mjs';
import { openEdgeDb, addEdge, removeOutgoingEdges, saveDb } from '../scripts/lib/edges.mjs';
import { classifyNoteEdges, buildVaultIndex, makeResolver } from '../scripts/lib/edge-classifier.mjs';

const EDGE_TYPE_TO_FRONTMATTER_KEY = {
  evidence_for: 'evidence-for',
  supports: 'supports',
  derived_from: 'derived-from',
  challenges_undermining: 'undermines',
  challenges_undercutting: 'undercuts',
  challenges_rebuttal: 'rebuts',
};

const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];

function isVaultNote(filePath, vaultRoot) {
  const prefix = vaultRoot + sep;
  if (!filePath.startsWith(prefix)) return false;
  if (!filePath.endsWith('.md')) return false;
  const rel = filePath.slice(prefix.length);
  const firstSegment = rel.split(sep)[0];
  if (firstSegment.startsWith('_') || firstSegment.startsWith('.')) return false;
  return VAULT_DIRS.some(d => rel.startsWith(d + '/'));
}

function vaultRelPath(filePath, vaultRoot) {
  return filePath.slice(vaultRoot.length + 1);
}

function parseInlineArray(value) {
  const m = value.match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function formatInlineArray(items) {
  return '[' + items.map(s => `"${s}"`).join(', ') + ']';
}

function parseBlockArray(lines, startIdx) {
  const items = [];
  let i = startIdx + 1;
  while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
    const item = lines[i].replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '').trim();
    if (item) items.push(item);
    i++;
  }
  return { items, endIdx: i - 1 };
}

function syncFrontmatterEdges(filePath, highConfidenceEdges) {
  if (highConfidenceEdges.length === 0) return false;

  let content;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return false; }

  const grouped = {};
  for (const edge of highConfidenceEdges) {
    const key = EDGE_TYPE_TO_FRONTMATTER_KEY[edge.edgeType];
    if (!key) continue;
    if (!grouped[key]) grouped[key] = new Set();
    const bare = basename(edge.toPath, '.md');
    grouped[key].add(`[[${bare}]]`);
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---(\n?)/);

  if (!fmMatch) {
    const newKeys = Object.entries(grouped)
      .map(([k, links]) => `${k}: ${formatInlineArray([...links])}`)
      .join('\n');
    const newContent = `---\n${newKeys}\n---\n${content}`;
    writeFileSync(filePath, newContent);
    return true;
  }

  const fmBody = fmMatch[1];
  const trailingNewline = fmMatch[2];
  const afterFm = content.slice(fmMatch[0].length);

  let lines = fmBody.split('\n');
  let changed = false;

  for (const [key, links] of Object.entries(grouped)) {
    const lineIdx = lines.findIndex(l => new RegExp(`^${key}:\\s*`).test(l));
    if (lineIdx === -1) {
      lines.push(`${key}: ${formatInlineArray([...links])}`);
      changed = true;
      continue;
    }

    const valueAfterColon = lines[lineIdx].slice(key.length + 1).trim();

    if (valueAfterColon === '') {
      const block = parseBlockArray(lines, lineIdx);
      const merged = new Set(block.items);
      let added = false;
      for (const link of links) {
        if (!merged.has(link)) { merged.add(link); added = true; }
      }
      if (added) {
        lines.splice(lineIdx, block.endIdx - lineIdx + 1, `${key}: ${formatInlineArray([...merged])}`);
        changed = true;
      }
      continue;
    }

    const existingArray = parseInlineArray(valueAfterColon);
    if (existingArray === null) continue;
    const merged = new Set(existingArray);
    let added = false;
    for (const link of links) {
      if (!merged.has(link)) { merged.add(link); added = true; }
    }
    if (added) {
      lines[lineIdx] = `${key}: ${formatInlineArray([...merged])}`;
      changed = true;
    }
  }

  if (!changed) return false;

  const newContent = '---\n' + lines.join('\n') + '\n---' + trailingNewline + afterFm;
  writeFileSync(filePath, newContent);
  return true;
}

runHook(async ({ tool, input, response }) => {
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!response || (typeof response === 'object' && response.success === false)) return;

  const filePath = input.file_path;
  if (!filePath) return;

  const vaultRoot = resolveVaultPath();
  if (!vaultRoot || !isVaultNote(filePath, vaultRoot)) return;

  const pluginData = resolvePluginData();
  if (!pluginData) return;

  const dbPath = join(pluginData, 'edges.db');

  let content;
  if (tool === 'Write') {
    content = input.content || '';
  } else {
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
  }

  if (!content.includes('[[')) return;

  const sourceName = basename(filePath, '.md');
  const sourceRel = vaultRelPath(filePath, vaultRoot);
  const resolver = makeResolver(buildVaultIndex(vaultRoot));
  const classified = classifyNoteEdges(content, sourceName, resolver);
  if (classified.length === 0) return;

  const edges = classified.map(e => ({
    fromPath: e.flip ? e.toPath : sourceRel,
    toPath: e.flip ? sourceRel : e.toPath,
    edgeType: e.edgeType,
    confidence: e.confidence,
    flip: e.flip,
  }));

  const db = await openEdgeDb(dbPath);
  try {
    removeOutgoingEdges(db, sourceRel);
    for (const edge of edges) {
      const { fromPath, toPath, edgeType, confidence } = edge;
      addEdge(db, { fromPath, toPath, edgeType, confidence });
    }
    saveDb(db, dbPath);
  } finally {
    db.close();
  }

  const highConfidenceEdges = edges.filter(e => e.confidence === 'high' && !e.flip);
  syncFrontmatterEdges(filePath, highConfidenceEdges);
});
