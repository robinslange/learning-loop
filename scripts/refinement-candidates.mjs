#!/usr/bin/env node
// refinement-candidates.mjs — Build the refinement candidate list for Track 1.
//
// Given a list of newly-written vault note paths (from /reflect or /ingest),
// query ll-search similar for each, convert the transformed score back to raw
// cosine, filter by the refinement band (0.78–0.92), apply pre-LLM filters
// (basename, folder, literature, new-new), cap per new note, and emit a flat
// JSON array of {id, new_note, candidate, cosine} ready for the
// refinement-proposer agent.
//
// Score conversion: ll-search similar returns `1 - cos²/2` (see
// native/src/search/cluster.rs:56). Lower returned score = higher cosine.
// Inverted formula: cos = sqrt(2 * (1 - score)).
//
// Usage:
//   refinement-candidates.mjs <new_note> [<new_note> ...]
//   refinement-candidates.mjs --stdin              # newline-separated paths
//   refinement-candidates.mjs --pairs-out <path>   # also write JSON to file
//
// Output: JSON array on stdout. Empty array if no candidates survive.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Refinement band: empirically tuned. Existing-vs-existing claim-touching pairs
// cluster around 0.80-0.92 (see spike 3). But fresh notes often land lower
// because new vocabulary (specific entities, sources) dilutes pure topical
// cosine. The proxy-timeouts test note vs websocket-has-no-built-in-reconnection
// is clearly a refinement and lands at 0.776. Lower threshold to 0.74 to catch
// fresh-note refinements; the agent's triage filters precision.
const COSINE_MIN = 0.74;
const COSINE_MAX = 0.92;
const TOP_K = 10;
const PER_NOTE_CAP = 5;
const EXCLUDE_FOLDERS = ['Excalidraw', '4-projects', '6-writing'];

function resolveVaultPath() {
  const cfgPath = resolve(__dirname, '..', 'config.json');
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg.vault_path) return resolve(cfg.vault_path.replace(/^~/, homedir()));
  } catch {}
  const pluginDataCfg = resolve(homedir(), '.claude/plugins/data/learning-loop-learning-loop-marketplace/config.json');
  try {
    const cfg = JSON.parse(readFileSync(pluginDataCfg, 'utf-8'));
    if (cfg.vault_path) return resolve(cfg.vault_path.replace(/^~/, homedir()));
  } catch {}
  return resolve(homedir(), 'brain/brain');
}

function resolveBinary() {
  const installed = resolve(homedir(), '.claude/plugins/data/learning-loop-learning-loop-marketplace/bin/ll-search');
  if (existsSync(installed)) return installed;
  const dev = resolve(__dirname, '..', 'native/target/release/ll-search');
  if (existsSync(dev)) return dev;
  throw new Error('ll-search binary not found');
}

function scoreToCosine(score) {
  // similar returns 1 - cos²/2; invert: cos = sqrt(2(1 - score))
  const inner = 2 * (1 - score);
  if (inner < 0) return 1;
  return Math.sqrt(inner);
}

function vaultRel(absPath, vaultRoot) {
  const prefix = vaultRoot + sep;
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  return absPath;
}

function topFolder(relPath) {
  return relPath.split('/')[0];
}

function readStdinPaths() {
  return readFileSync(0, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
}

function querySimilar(bin, dbPath, vaultRoot, noteRel) {
  const env = {
    ...process.env,
    ORT_DYLIB_PATH: dirname(bin),
    ORT_LIB_LOCATION: dirname(bin),
  };
  const result = spawnSync(bin, ['similar', '--top', String(TOP_K), dbPath, noteRel], {
    encoding: 'utf-8',
    env,
    timeout: 5000,
  });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}

function buildCandidates(newNotePaths, opts = {}) {
  const vaultRoot = opts.vaultRoot || resolveVaultPath();
  const dbPath = resolve(vaultRoot, '.vault-search/vault-index.db');
  const bin = resolveBinary();

  const newSet = new Set(newNotePaths.map(p => vaultRel(resolve(p), vaultRoot)));
  const allPairs = [];
  let nextId = 1;

  for (const inputPath of newNotePaths) {
    const newAbs = resolve(inputPath);
    if (!existsSync(newAbs)) continue;
    const newRel = vaultRel(newAbs, vaultRoot);
    if (!newRel.endsWith('.md')) continue;

    const newBase = basename(newRel, '.md');
    const newFolder = topFolder(newRel);

    const raw = querySimilar(bin, dbPath, vaultRoot, newRel);
    if (!raw.length) continue;

    const surviving = [];
    for (const r of raw) {
      const candRel = r.path;
      if (!candRel || !candRel.endsWith('.md')) continue;

      // Filter: same basename = promotion duplicate, route to merge not refinement
      if (basename(candRel, '.md') === newBase) continue;

      // Filter: candidate is also a newly-written note in this batch
      if (newSet.has(candRel)) continue;

      const candFolder = topFolder(candRel);

      // Filter: excluded candidate folders
      if (EXCLUDE_FOLDERS.includes(candFolder)) continue;

      // Filter: both in 2-literature/ (different sources, refinement collapses provenance)
      if (newFolder === '2-literature' && candFolder === '2-literature') continue;

      const cosine = scoreToCosine(r.score);
      if (cosine < COSINE_MIN || cosine > COSINE_MAX) continue;

      surviving.push({ candidate: candRel, cosine });
    }

    // Sort by cosine descending (most similar first), cap to PER_NOTE_CAP
    surviving.sort((a, b) => b.cosine - a.cosine);
    const capped = surviving.slice(0, PER_NOTE_CAP);

    for (const s of capped) {
      allPairs.push({
        id: nextId++,
        new_note: resolve(vaultRoot, newRel),
        candidate: resolve(vaultRoot, s.candidate),
        cosine: Number(s.cosine.toFixed(4)),
      });
    }
  }

  return allPairs;
}

function main() {
  const args = process.argv.slice(2);

  let pairsOutPath = null;
  const pairsOutIdx = args.indexOf('--pairs-out');
  if (pairsOutIdx >= 0) {
    pairsOutPath = args[pairsOutIdx + 1];
    args.splice(pairsOutIdx, 2);
  }

  let paths;
  if (args.includes('--stdin')) {
    paths = readStdinPaths();
  } else {
    paths = args;
  }

  if (!paths.length) {
    process.stdout.write('[]\n');
    return;
  }

  const pairs = buildCandidates(paths);
  const json = JSON.stringify(pairs, null, 2);
  process.stdout.write(json + '\n');
  if (pairsOutPath) writeFileSync(pairsOutPath, json);
}

main();
