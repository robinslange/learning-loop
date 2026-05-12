// hooks/modules/edge-infer.mjs : Wikilink → edge classification.
// Extracted from hooks/post-write-edge-infer.js. Snapshot-backed vault index
// (no per-call recursive readdir).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolvePluginData, isVaultNote, findBinary } from '../lib/common.mjs';
import { buildVaultIndexFromSnapshot } from '../lib/snapshot.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import {
  openEdgeDb,
  addEdge,
  removeOutgoingEdges,
  removeOutgoingNliEdges,
  saveDb,
  acquireLock,
  releaseLock,
} from '../../scripts/lib/edges.mjs';
import { classifyNoteEdges, makeResolver } from '../../scripts/lib/edge-classifier.mjs';
import { spawnEnv } from '../../scripts/lib/env.mjs';

const EDGE_TYPE_TO_FRONTMATTER_KEY = {
  evidence_for: 'evidence-for',
  supports: 'supports',
  derived_from: 'derived-from',
  challenges_undermining: 'undermines',
  challenges_undercutting: 'undercuts',
  challenges_rebuttal: 'rebuts',
};

const NLI_THRESHOLD = parseFloat(process.env.LL_NLI_THRESHOLD || '0.90');

function vaultRelPath(filePath, vaultRoot) {
  return filePath.slice(vaultRoot.length + 1);
}

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

  const newContent = '---\n' + lines.join('\n') + '\n---' + trailingNewline + afterFm;
  writeFileSync(filePath, newContent);
  return true;
}

function runNliBatch(sourceText, neighbours) {
  if (!neighbours || neighbours.length === 0) return [];
  const binary = findBinary();
  if (!binary) return [];

  let tempDir;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'nli-'));
    const hypsPath = join(tempDir, 'hyps.txt');
    const hypotheses = neighbours.map((n) => {
      const slug = basename(n.path, '.md').replace(/-/g, ' ');
      return slug;
    });
    writeFileSync(hypsPath, hypotheses.join('\n'));

    const out = execFileSync(binary.bin, ['nli-batch', sourceText, hypsPath], {
      encoding: 'utf-8',
      timeout: 1500,
      env: spawnEnv({ ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir }),
    });
    return JSON.parse(out);
  } catch (err) {
    logError('edge-infer.runNliBatch', err);
    return [];
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
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

  const dbPath = join(pluginData, 'edges.db');

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

  const nliCandidates = ctx.autolinkCandidates || [];

  // Skip work only if BOTH regex and NLI have nothing to do.
  if (edges.length === 0 && nliCandidates.length === 0) return;

  // Extract NLI premise: first non-empty line of body, single-line, max 300 chars.
  let sourceText = sourceName.replace(/-/g, ' ');
  if (nliCandidates.length > 0) {
    const fmStripped = noteContent.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const firstLine = fmStripped
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstLine) sourceText = firstLine.slice(0, 300);
  }

  if (!acquireLock(dbPath)) {
    logError(
      'edge-infer.acquireLock',
      new Error(`failed to acquire ${dbPath} after retries; edge work for ${sourceRel} skipped`),
    );
    return;
  }
  const db = await openEdgeDb(dbPath);
  try {
    if (edges.length > 0) {
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
    } else if (nliCandidates.length > 0) {
      // NLI-only path: don't wipe regex-classified edges (preserves frontmatter
      // consistency when wikilinks were removed). Clear only prior NLI edges
      // so the new NLI loop re-derives cleanly.
      removeOutgoingNliEdges(db, sourceRel);
    }

    if (nliCandidates.length > 0) {
      const nliResults = runNliBatch(sourceText, nliCandidates);
      for (let i = 0; i < nliResults.length; i++) {
        const r = nliResults[i];
        if (!r || typeof r.contradiction !== 'number') continue;
        if (r.contradiction <= NLI_THRESHOLD) continue;
        const neighbourRel = nliCandidates[i].path;
        // Skip NLI if regex already emitted a challenges_* edge to this target. A
        // regex 'supports' / 'evidence_for' edge does NOT block — a note can both
        // support and rebut the same target (epistemic tension worth surfacing).
        if (edges.some((e) => e.toPath === neighbourRel && e.edgeType.startsWith('challenges_'))) {
          continue;
        }
        try {
          addEdge(db, {
            fromPath: sourceRel,
            toPath: neighbourRel,
            edgeType: 'challenges_rebuttal',
            confidence: 'low',
            sourceGraph: 'nli',
            directionFlipped: 0,
            confidenceScore: r.contradiction,
          });
        } catch (err) {
          logError('edge-infer.nliAddEdge', err);
        }
      }
    }

    saveDb(db, dbPath);
  } finally {
    db.close();
    releaseLock(dbPath);
  }

  const highConfidenceEdges = edges.filter((e) => e.confidence === 'high' && !e.flip);
  syncFrontmatterEdges(filePath, highConfidenceEdges);
}
