// hooks/modules/edge-infer.mjs : Wikilink → edge classification.
// Extracted from the pre-coalescing standalone edge-infer hook. Snapshot-backed
// vault index (no per-call recursive readdir).

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolvePluginData, isVaultNote, vaultRelPath } from '../lib/common.mjs';
import { buildVaultIndexFromSnapshot } from '../lib/snapshot.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { splitRawFrontmatter } from '../../scripts/lib/markdown-parse.mjs';
import {
  openEdgeDb,
  addEdge,
  removeOutgoingEdges,
  saveDb,
  acquireLock,
  releaseLock,
} from '../../scripts/lib/edges.mjs';
import { classifyNoteEdges, makeResolver } from '../../scripts/lib/edge-classifier.mjs';
import { DATA_FILES } from '../../scripts/lib/paths.mjs';

const EDGE_TYPE_TO_FRONTMATTER_KEY = {
  evidence_for: 'evidence-for',
  supports: 'supports',
  derived_from: 'derived-from',
  challenges_undermining: 'undermines',
  challenges_undercutting: 'undercuts',
  challenges_rebuttal: 'rebuts',
};

function parseInlineArray(value) {
  const m = value.match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function formatInlineArray(items) {
  return '[' + items.map((s) => `"${s}"`).join(', ') + ']';
}

function parseBlockArray(lines, startIdx) {
  const items = [];
  let i = startIdx + 1;
  while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
    const item = lines[i]
      .replace(/^\s*-\s+/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (item) items.push(item);
    i++;
  }
  return { items, endIdx: i - 1 };
}

function syncFrontmatterEdges(filePath, highConfidenceEdges) {
  if (highConfidenceEdges.length === 0) return false;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  const grouped = {};
  for (const edge of highConfidenceEdges) {
    const key = EDGE_TYPE_TO_FRONTMATTER_KEY[edge.edgeType];
    if (!key) continue;
    if (!grouped[key]) grouped[key] = new Set();
    const bare = basename(edge.toPath, '.md');
    grouped[key].add(`[[${bare}]]`);
  }

  // Round-trip splice: raw frontmatter text is preserved verbatim and written
  // back, so this cannot go through markdown-parse's lossy parse; it uses the
  // lib's lossless splitRawFrontmatter instead.
  const parts = splitRawFrontmatter(content);

  if (!parts) {
    const newKeys = Object.entries(grouped)
      .map(([k, links]) => `${k}: ${formatInlineArray([...links])}`)
      .join('\n');
    const newContent = `---\n${newKeys}\n---\n${content}`;
    writeFileSync(filePath, newContent);
    return true;
  }

  let lines = parts.fm.split(/\r?\n/);
  let changed = false;

  for (const [key, links] of Object.entries(grouped)) {
    const lineIdx = lines.findIndex((l) => new RegExp(`^${key}:\\s*`).test(l));
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
        if (!merged.has(link)) {
          merged.add(link);
          added = true;
        }
      }
      if (added) {
        lines.splice(
          lineIdx,
          block.endIdx - lineIdx + 1,
          `${key}: ${formatInlineArray([...merged])}`,
        );
        changed = true;
      }
      continue;
    }

    const existingArray = parseInlineArray(valueAfterColon);
    if (existingArray === null) continue;
    const merged = new Set(existingArray);
    let added = false;
    for (const link of links) {
      if (!merged.has(link)) {
        merged.add(link);
        added = true;
      }
    }
    if (added) {
      lines[lineIdx] = `${key}: ${formatInlineArray([...merged])}`;
      changed = true;
    }
  }

  if (!changed) return false;

  const newContent =
    '---' + parts.nl + lines.join(parts.nl) + parts.nl + '---' + parts.trailing + parts.body;
  writeFileSync(filePath, newContent);
  return true;
}

export async function runEdgeInfer(ctx) {
  const { tool, input, response, vaultRoot, snapshot } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!response || (typeof response === 'object' && response.success === false)) return;
  if (!vaultRoot) return;

  const filePath = input.file_path;
  if (!filePath) return;
  if (!isVaultNote(filePath, vaultRoot)) return;
  if (!snapshot) return;

  const pluginData = resolvePluginData();
  if (!pluginData) return;

  const dbPath = DATA_FILES.edgesDb(pluginData);

  let noteContent;
  if (tool === 'Write') {
    noteContent = input.content || '';
  } else {
    try {
      noteContent = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logError('edge-infer.readContent', err);
      return;
    }
  }

  const sourceName = basename(filePath, '.md');
  const sourceRel = vaultRelPath(filePath, vaultRoot);

  // Regex classifier: only meaningful if note has wikilinks
  let classified = [];
  if (noteContent.includes('[[')) {
    const resolver = makeResolver(buildVaultIndexFromSnapshot(snapshot));
    classified = classifyNoteEdges(noteContent, sourceName, resolver);
  }

  const edges = classified.map((e) => ({
    fromPath: sourceRel,
    toPath: e.toPath,
    edgeType: e.edgeType,
    confidence: e.confidence,
    flip: e.flip,
  }));

  if (edges.length === 0) return;

  if (!acquireLock(dbPath)) {
    logError(
      'edge-infer.acquireLock',
      new Error(`failed to acquire ${dbPath} after retries; edge work for ${sourceRel} skipped`),
    );
    return;
  }
  let db = null;
  try {
    db = await openEdgeDb(dbPath);
    removeOutgoingEdges(db, sourceRel);
    for (const edge of edges) {
      addEdge(db, {
        fromPath: edge.fromPath,
        toPath: edge.toPath,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        directionFlipped: edge.flip ? 1 : 0,
      });
    }

    saveDb(db, dbPath);
  } finally {
    db?.close();
    releaseLock(dbPath);
  }

  const highConfidenceEdges = edges.filter((e) => e.confidence === 'high' && !e.flip);
  syncFrontmatterEdges(filePath, highConfidenceEdges);
}
