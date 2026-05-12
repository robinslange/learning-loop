#!/usr/bin/env node
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
