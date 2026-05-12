#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DATA } from './lib/constants.mjs';

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

async function main(argv) {
  const flags = parseFlags(argv);
  if (!PLUGIN_DATA) {
    console.error('plugin data dir not resolvable');
    process.exit(1);
  }
  const dbPath = join(PLUGIN_DATA, 'edges.db');
  const counts = {
    frontmatterUpdated: 0,
    frontmatterCleared: 0,
    heatmapRows: 0,
    cyclesFound: 0,
  };
  console.log(JSON.stringify({ ok: true, flags, dbPath, counts }, null, 2));
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.stack || err);
    process.exit(1);
  });
}
