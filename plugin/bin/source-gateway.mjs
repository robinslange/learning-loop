#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveSlot as defaultResolveSlot } from '../scripts/lib/sources/registry.mjs';

const VERBS = new Set(['search', 'fetch']); // 'research' added in Task 2.2

export function parseArgs(argv) {
  const out = { verb: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--q') out.q = argv[++i];
    else if (a === '--url') out.url = argv[++i];
  }
  return out;
}

class UsageError extends Error {}

export async function runGateway(argv, deps = {}) {
  const { resolveSlot = defaultResolveSlot } = deps;
  const args = parseArgs(argv);
  if (!VERBS.has(args.verb)) {
    throw new UsageError(`unknown verb "${args.verb ?? ''}" (expected: ${[...VERBS].join(', ')})`);
  }
  if (args.verb === 'search') {
    if (!args.q) throw new UsageError('search requires --q <query>');
    const source = resolveSlot('web_search');
    const hits = await source.query(args.q);
    return { hits, source_used: source.id };
  }
  // fetch
  if (!args.url) throw new UsageError('fetch requires --url <url>');
  const source = resolveSlot('fetch');
  const doc = await source.fetch(args.url);
  return { doc, source_used: source.id };
}

export { UsageError };

async function main() {
  const argv = process.argv.slice(2);
  try {
    const out = await runGateway(argv);
    process.stdout.write(JSON.stringify(out, null, 2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(
        `Usage: source-gateway.mjs <search|fetch> [--q <query>|--url <url>] [--json]\n${err.message}\n`,
      );
      process.exit(2);
    }
    process.stderr.write('source-gateway failed: ' + err.message + '\n');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
