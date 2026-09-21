#!/usr/bin/env node
// scripts/otel/enumerate-keys.mjs : enumerate every key in every telemetry
// stream, with occurrence counts.
//
// The export allowlist (schema.mjs, docs/plans/otel-consolidation.md phase 0)
// is an INCLUSION list: a key absent from it must fail closed. Two earlier
// drafts of that plan hand-wrote an exclusion list and both were incomplete,
// leaking transcript_path, tags, description, args, topic, intent,
// finding_detail, note, prompt and session_label. Run this before editing the
// allowlist and diff the output against the committed table.
//
// Node, not bash: jq may not exist everywhere this plugin runs, and the repo
// has zero runtime npm dependencies either way.
//
// Usage: node enumerate-keys.mjs [plugin-data-dir]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from '../lib/config.mjs';
import { DATA_PATHS } from '../lib/paths.mjs';

function jsonlFiles(dir, predicate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(predicate)
    .map((name) => join(dir, name));
}

// Every file this plugin appends telemetry to. Must no-op cleanly when a
// stream never ran (the librarian is optional, dream-eval only exists once
// the librarian's dream mode has fired).
function telemetryFiles(pluginData) {
  return [
    ...jsonlFiles(
      DATA_PATHS.provenance(pluginData),
      (f) => f.startsWith('events-') && f.endsWith('.jsonl'),
    ),
    ...jsonlFiles(DATA_PATHS.retrieval(pluginData), (f) => f.endsWith('.jsonl')),
    ...jsonlFiles(pluginData, (f) => f.startsWith('hook-errors-') && f.endsWith('.jsonl')),
    ...jsonlFiles(DATA_PATHS.logs(pluginData), (f) => f.startsWith('log-') && f.endsWith('.jsonl')),
    ...(existsSync(DATA_PATHS.dreamEvalProbes(pluginData))
      ? [DATA_PATHS.dreamEvalProbes(pluginData)]
      : []),
    ...(existsSync(DATA_PATHS.librarianQueue(pluginData))
      ? [DATA_PATHS.librarianQueue(pluginData)]
      : []),
  ];
}

// Count every key seen in every JSONL record in `file`, added onto `counts`.
function countKeys(file, counts) {
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    for (const key of Object.keys(record)) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
}

// Enumerate every key across every telemetry stream under `pluginData`, with
// occurrence counts. Returns {} when the plugin-data dir, or every stream
// under it, is absent: an unconfigured or fresh install is not an error.
export function enumerateTelemetryKeys(pluginData) {
  const counts = {};
  if (!existsSync(pluginData)) return counts;
  for (const file of telemetryFiles(pluginData)) {
    countKeys(file, counts);
  }
  return counts;
}

function main() {
  const pluginData = process.argv[2] || getPluginData();
  const counts = enumerateTelemetryKeys(pluginData);
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [key, count] of rows) {
    console.log(`${String(count).padStart(6)}  ${key}`);
  }
  console.log(`\n${rows.length} distinct keys`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
