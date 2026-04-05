#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'node:os';
import { VAULT_PATH, DB_PATH, PLUGIN_DATA, DISCRIMINATE_THRESHOLD } from './lib/constants.mjs';
import { relativeToVault } from './lib/paths.mjs';
import { hasBinary, run } from './lib/binary.mjs';

const FEDERATION_CONFIG = join(PLUGIN_DATA, 'federation', 'config.json');

function federationArgs() {
  if (!existsSync(FEDERATION_CONFIG)) return [];
  return ['--config-dir', PLUGIN_DATA];
}

function ensureBinary() {
  if (!hasBinary()) {
    process.stderr.write('ll-search binary not found. Run /learning-loop:init to install.\n');
    process.exit(2);
  }
}

function tryFederationExport() {
  if (!existsSync(FEDERATION_CONFIG) || !hasBinary()) return;
  try {
    const result = run(['export', DB_PATH, join(tmpdir(), 'll-search-export.db'), VAULT_PATH, ...federationArgs()]);
    process.stderr.write(`Federation export: ${result.exported} notes\n`);
  } catch (err) {
    process.stderr.write(`Federation export failed: ${err.message}\n`);
  }
}

const args = process.argv.slice(2);
const cmd = args[0];

function parseFlag(flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx < 0) return defaultVal;
  return args[idx + 1] !== undefined ? args[idx + 1] : defaultVal;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function stripFlags(from, ...flags) {
  return args.slice(from).filter((a, i, arr) => {
    if (flags.includes(a)) return false;
    const prev = arr[i - 1];
    if (prev && flags.includes(prev) && !a.startsWith('-')) return false;
    return true;
  });
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function logRetrieval(command, query, results) {
  try {
    const dir = join(PLUGIN_DATA, 'retrieval');
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const file = join(dir, `queries-${now.toISOString().slice(0, 7)}.jsonl`);
    let sessionId = '';
    try { sessionId = readFileSync(join(tmpdir(), 'learning-loop-session-id'), 'utf-8').trim(); } catch {}
    const federated = existsSync(FEDERATION_CONFIG);
    const topPaths = Array.isArray(results)
      ? results.slice(0, 10).map(r => r.path || r.note_a || '')
      : [];
    const peerCount = topPaths.filter(p => p.startsWith('peer:')).length;
    const entry = {
      ts: now.toISOString(),
      session_id: sessionId,
      command,
      query,
      federated,
      result_count: Array.isArray(results) ? results.length : 0,
      peer_results: peerCount,
      top_paths: topPaths,
    };
    appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {}
}

function intentions(projectFilter) {
  const results = new Map();

  function walkDir(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (entry.name.endsWith('.md')) {
        let content;
        try { content = readFileSync(full, 'utf-8'); } catch { continue; }
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
          if (!results.has(ctx)) results.set(ctx, []);
          const relPath = relativeToVault(full, VAULT_PATH) || full;
          results.get(ctx).push({ path: relPath, cue });
        }
      }
    }
  }
  walkDir(VAULT_PATH);

  if (!projectFilter) {
    const summary = [...results.entries()]
      .map(([context, notes]) => ({ context, count: notes.length }))
      .sort((a, b) => b.count - a.count);
    return summary;
  }

  const filtered = new Map();
  for (const [ctx, notes] of results) {
    if (ctx.toLowerCase().includes(projectFilter.toLowerCase())) {
      filtered.set(ctx, notes);
    }
  }
  return Object.fromEntries(filtered);
}

const USAGE = `Usage:
  vault-search.mjs query "text" [--top N] [--rerank] [--candidates N]   Hybrid search (default top: 10)
  vault-search.mjs search <keywords> [--top N] [--rerank] [--candidates N]  Hybrid search (default top: 20)
  vault-search.mjs similar <note-path> [--top N]             Find similar notes (default: 10)
  vault-search.mjs cluster [--threshold 0.7]                 Cluster notes by similarity
  vault-search.mjs discriminate [--threshold ${DISCRIMINATE_THRESHOLD}] [paths...]  Find confusable pairs
  vault-search.mjs reflect-scan "q1" "q2" [--top N] [--candidates N]  Batch search+rerank+discriminate
  vault-search.mjs index [--force] [--watch] [--sync]        Build/update search index
  vault-search.mjs status                                    Index health check
  vault-search.mjs list [--top N]                            List indexed notes (default: all)
  vault-search.mjs intentions                                List intention contexts with counts (summary)
  vault-search.mjs intentions "<context>"                    Show notes + cues for matching context (detail)
  vault-search.mjs export-index                              Export federation index
  vault-search.mjs sync                                      Sync with federation hub`;

try {
  switch (cmd) {
    case 'query': {
      ensureBinary();
      const text = stripFlags(1, '--top', '--rerank', '--candidates').join(' ');
      const topN = parseFlag('--top', '10');
      if (hasFlag('--rerank')) {
        const candidates = parseFlag('--candidates', '20');
        const results = run(['rerank', DB_PATH, text, '--top', topN, '--candidates', candidates, ...federationArgs()]);
        logRetrieval('rerank', text, results);
        out(results);
      } else {
        const results = run(['query', DB_PATH, text, '--top', topN, ...federationArgs()]);
        logRetrieval('query', text, results);
        out(results);
      }
      break;
    }

    case 'search': {
      ensureBinary();
      const keywords = stripFlags(1, '--top', '--rerank', '--candidates').join(' ');
      const topN = parseFlag('--top', '20');
      if (hasFlag('--rerank')) {
        const candidates = parseFlag('--candidates', '40');
        const results = run(['rerank', DB_PATH, keywords, '--top', topN, '--candidates', candidates, ...federationArgs()]);
        logRetrieval('rerank', keywords, results);
        out(results);
      } else {
        const results = run(['query', DB_PATH, keywords, '--top', topN, ...federationArgs()]);
        logRetrieval('query', keywords, results);
        out(results);
      }
      break;
    }

    case 'similar': {
      ensureBinary();
      const topN = parseFlag('--top', '10');
      const results = run(['similar', DB_PATH, args[1], '--top', topN]);
      logRetrieval('similar', args[1], results);
      out(results);
      break;
    }

    case 'cluster': {
      ensureBinary();
      const threshold = parseFlag('--threshold', '0.7');
      out(run(['cluster', DB_PATH, '--threshold', threshold]));
      break;
    }

    case 'discriminate': {
      ensureBinary();
      const threshold = parseFlag('--threshold', String(DISCRIMINATE_THRESHOLD));
      const notePaths = stripFlags(1, '--threshold', '--top');
      out(run(['discriminate', DB_PATH, '--threshold', threshold, ...notePaths]));
      break;
    }

    case 'index': {
      ensureBinary();
      const force = hasFlag('--force');
      const watching = hasFlag('--watch');
      const syncing = hasFlag('--sync');

      const runArgs = ['index', VAULT_PATH, DB_PATH];
      if (force) runArgs.push('--force');
      out(run(runArgs));
      await tryFederationExport();

      if (syncing) {
        try {
          run(['sync', DB_PATH, VAULT_PATH, ...federationArgs()]);
        } catch (err) {
          process.stderr.write(`Sync error: ${err.message}\n`);
        }
      }

      if (watching) {
        const { execFileSync } = await import('child_process');
        const { binaryPath: bp } = await import('./lib/binary.mjs');
        const bin = bp();
        if (!bin) {
          process.stderr.write('ll-search binary not found for watch mode\n');
          break;
        }
        const watchArgs = ['watch', VAULT_PATH, DB_PATH];
        if (syncing) watchArgs.push('--sync-interval', '300');
        try {
          execFileSync(bin, watchArgs, { stdio: 'inherit' });
        } catch (err) {
          if (err.status !== null) process.exit(err.status);
        }
      }
      break;
    }

    case 'status': {
      ensureBinary();
      out(run(['status', DB_PATH, VAULT_PATH]));
      break;
    }

    case 'list': {
      const { openReadonly } = await import('./lib/sqljs.mjs');
      const db = await openReadonly(DB_PATH);
      const topN = parseInt(parseFlag('--top', '0'));
      const query = topN > 0
        ? `SELECT path, tags FROM notes ORDER BY path LIMIT ${topN}`
        : 'SELECT path, tags FROM notes ORDER BY path';
      const result = db.exec(query);
      if (result[0]) {
        for (const row of result[0].values) {
          console.log(`${row[0]}  tags:${row[1] || ''}`);
        }
      }
      db.close();
      break;
    }

    case 'intentions': {
      out(intentions(args[1] || null));
      break;
    }

    case 'export-index': {
      ensureBinary();
      out(run(['export', DB_PATH, join(tmpdir(), 'll-search-export.db'), VAULT_PATH]));
      break;
    }

    case 'sync': {
      ensureBinary();
      out(run(['sync', DB_PATH, VAULT_PATH, ...federationArgs()]));
      break;
    }

    case 'reflect-scan': {
      ensureBinary();
      const topN = parseFlag('--top', '5');
      const candidates = parseFlag('--candidates', '20');
      const threshold = parseFlag('--threshold', String(DISCRIMINATE_THRESHOLD));
      const queries = stripFlags(1, '--top', '--candidates', '--threshold');
      if (queries.length === 0) {
        console.error('Usage: vault-search.mjs reflect-scan "query1" "query2" ... [--top N] [--candidates N]');
        process.exit(1);
      }
      const results = run(['reflect-scan', DB_PATH, ...queries, '--top', topN, '--candidates', candidates, '--threshold', threshold, ...federationArgs()]);
      for (const q of (results.queries || [])) {
        logRetrieval('reflect-scan', q.query, q.results);
      }
      out(results);
      break;
    }

    default:
      console.log(USAGE);
  }
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}
