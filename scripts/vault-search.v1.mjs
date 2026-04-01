#!/usr/bin/env node

// Vault semantic search using Smart Connections' stored embeddings.
// No ML model needed — uses pre-computed vectors for note-to-note similarity.
//
// Usage:
//   vault-search.mjs similar <note-path> [--top N]    Find notes similar to a given note
//   vault-search.mjs cluster [--threshold 0.7]         Cluster all notes by similarity
//   vault-search.mjs search <keywords>                 Keyword search across note content
//   vault-search.mjs list                              List all indexed notes with metadata
//   vault-search.mjs intentions [project]              Find notes with intention metadata
//   vault-search.mjs discriminate [--threshold 0.85]   Find confusable note pairs

import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const home = process.env.HOME || process.env.USERPROFILE || homedir();
const VAULT_PATH = resolve(process.env.VAULT_PATH || join(home, 'brain', 'brain'));
const SMART_ENV = join(VAULT_PATH, '.smart-env', 'multi');
const EMBED_KEY = 'TaylorAI/bge-micro-v2';

function loadEmbeddings() {
  const files = readdirSync(SMART_ENV).filter(f => f.endsWith('.ajson'));
  const sources = new Map();

  for (const file of files) {
    const content = readFileSync(join(SMART_ENV, file), 'utf-8');
    // AJSON: each line is a key-value pair as JSON
    // Format: "key": {data}
    // Multiple entries per line separated by commas, but actually it's one big line
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        // Parse each entry — format is "key": {...}, "key2": {...}
        // Wrap in braces to make valid JSON
        const obj = JSON.parse(`{${line.replace(/,\s*$/, '')}}`);
        for (const [key, val] of Object.entries(obj)) {
          if (!key.startsWith('smart_sources:')) continue;
          const path = val.path;
          if (!path) continue;
          const vec = val.embeddings?.[EMBED_KEY]?.vec;
          if (!vec) continue;
          sources.set(path, {
            path,
            vec,
            tags: val.metadata?.tags || [],
            outlinks: (val.outlinks || []).map(l => l.target),
            blocks: Object.keys(val.blocks || {}),
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
  }
  return sources;
}

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function similar(sources, notePath, topN = 10) {
  // Find the note — try exact match, then fuzzy
  let source = sources.get(notePath);
  if (!source) {
    for (const [key, val] of sources) {
      if (key.includes(notePath)) { source = val; break; }
    }
  }
  if (!source) {
    console.error(`Note not found: ${notePath}`);
    process.exit(1);
  }

  const results = [];
  for (const [key, val] of sources) {
    if (key === source.path) continue;
    results.push({ path: key, score: cosine(source.vec, val.vec), tags: val.tags });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topN);
}

function cluster(sources, threshold = 0.7) {
  const paths = [...sources.keys()];
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < paths.length; i++) {
    if (assigned.has(paths[i])) continue;
    const cluster = [paths[i]];
    assigned.add(paths[i]);
    const vecA = sources.get(paths[i]).vec;

    for (let j = i + 1; j < paths.length; j++) {
      if (assigned.has(paths[j])) continue;
      const score = cosine(vecA, sources.get(paths[j]).vec);
      if (score >= threshold) {
        cluster.push(paths[j]);
        assigned.add(paths[j]);
      }
    }
    clusters.push(cluster);
  }

  // Sort clusters by size descending, filter out singletons
  return clusters
    .filter(c => c.length > 1)
    .sort((a, b) => b.length - a.length);
}

function search(keywords) {
  const term = keywords.toLowerCase();
  const results = [];

  function walkDir(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (entry.name.endsWith('.md')) {
        const content = readFileSync(full, 'utf-8').toLowerCase();
        if (content.includes(term)) {
          const relPath = full.startsWith(VAULT_PATH) ? full.slice(VAULT_PATH.length).replace(/^[/\\]/, '') : full;
          // Count occurrences
          const count = content.split(term).length - 1;
          results.push({ path: relPath, matches: count });
        }
      }
    }
  }
  walkDir(VAULT_PATH);
  results.sort((a, b) => b.matches - a.matches);
  return results;
}

function intentions(projectFilter) {
  const results = new Map();

  function walkDir(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (entry.name.endsWith('.md')) {
        const content = readFileSync(full, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const intentMatch = fmMatch[1].match(/intentions:\n((?:\s+-[\s\S]*?)(?=\n\w|\n---|$))/);
        if (!intentMatch) continue;

        const intentBlock = intentMatch[1];
        const flatItems = [...intentBlock.matchAll(/- "([^"]+)"/g)];

        for (const item of flatItems) {
          const parts = item[1].split(' \u2014 ');
          const ctx = parts[0].trim();
          const cue = parts.length > 1 ? parts.slice(1).join(' \u2014 ').trim() : '';
          if (projectFilter && !ctx.toLowerCase().includes(projectFilter.toLowerCase())) continue;
          if (!results.has(ctx)) results.set(ctx, []);
          const relPath = full.startsWith(VAULT_PATH) ? full.slice(VAULT_PATH.length).replace(/^[/\\]/, '') : full;
          results.get(ctx).push({ path: relPath, cue });
        }
      }
    }
  }
  walkDir(VAULT_PATH);
  return Object.fromEntries(results);
}

function discriminate(notePaths, threshold = 0.85) {
  const sources = loadEmbeddings();
  const pairs = [];

  const resolvedPaths = notePaths.length > 0
    ? notePaths.map(p => {
        for (const [key] of sources) {
          if (key.includes(p)) return key;
        }
        return null;
      }).filter(Boolean)
    : [...sources.keys()];

  for (let i = 0; i < resolvedPaths.length; i++) {
    const vecA = sources.get(resolvedPaths[i])?.vec;
    if (!vecA) continue;
    for (let j = i + 1; j < resolvedPaths.length; j++) {
      const vecB = sources.get(resolvedPaths[j])?.vec;
      if (!vecB) continue;
      const score = cosine(vecA, vecB);
      if (score >= threshold) {
        pairs.push({
          noteA: resolvedPaths[i],
          noteB: resolvedPaths[j],
          similarity: Math.round(score * 1000) / 1000,
        });
      }
    }
  }

  pairs.sort((a, b) => b.similarity - a.similarity);
  return pairs;
}

// CLI
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'similar') {
  const notePath = args[1];
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1]) : 10;
  const sources = loadEmbeddings();
  const results = similar(sources, notePath, topN);
  console.log(JSON.stringify(results, null, 2));

} else if (cmd === 'cluster') {
  const threshIdx = args.indexOf('--threshold');
  const threshold = threshIdx >= 0 ? parseFloat(args[threshIdx + 1]) : 0.7;
  const sources = loadEmbeddings();
  const clusters = cluster(sources, threshold);
  console.log(JSON.stringify(clusters, null, 2));

} else if (cmd === 'search') {
  const keywords = args.slice(1).join(' ');
  const results = search(keywords);
  console.log(JSON.stringify(results, null, 2));

} else if (cmd === 'list') {
  const sources = loadEmbeddings();
  for (const [path, data] of sources) {
    console.log(`${path}  tags:${data.tags.join(',')}  links:${data.outlinks.length}  blocks:${data.blocks.length}`);
  }

} else if (cmd === 'intentions') {
  const project = args[1] || null;
  const results = intentions(project);
  console.log(JSON.stringify(results, null, 2));

} else if (cmd === 'discriminate') {
  const threshIdx = args.indexOf('--threshold');
  const threshold = threshIdx >= 0 ? parseFloat(args[threshIdx + 1]) : 0.85;
  const notePaths = args.slice(1).filter(a => a !== '--threshold' && (threshIdx < 0 || args.indexOf(a) !== threshIdx + 1));
  const pairs = discriminate(notePaths, threshold);
  console.log(JSON.stringify(pairs, null, 2));

} else {
  console.log(`Usage:
  vault-search.mjs similar <note-path> [--top N]
  vault-search.mjs cluster [--threshold 0.7]
  vault-search.mjs search <keywords>
  vault-search.mjs list
  vault-search.mjs intentions [project]
  vault-search.mjs discriminate [--threshold 0.85]`);
}
