#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveSlot as defaultResolveSlot } from '../scripts/lib/sources/registry.mjs';
import { runResearch as defaultRunResearch } from '../scripts/librarian/research.mjs';

const VERBS = new Set(['search', 'fetch', 'research']);

const DEFAULT_FETCH_BUDGET = Number(process.env.LL_GATEWAY_FETCH_BUDGET) || 10;
let fetchCount = 0;

export function __resetFetchCount() {
  fetchCount = 0;
}

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
  const { resolveSlot = defaultResolveSlot, runResearch = defaultRunResearch, fetchBudget } = deps;
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
  if (args.verb === 'research') {
    if (!args.q) throw new UsageError('research requires --q <question>');
    const bundle = await runResearch(args.q);
    return { claims: bundle.claims, sources: bundle.sources, source_used: bundle.source_used };
  }
  // fetch
  if (!args.url) throw new UsageError('fetch requires --url <url>');
  const budget = fetchBudget ?? DEFAULT_FETCH_BUDGET;
  const source = resolveSlot('fetch');
  if (fetchCount >= budget) {
    return { doc: { ok: false, reason: 'fetch_budget_exceeded' }, source_used: source.id };
  }
  fetchCount += 1;
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
        `Usage: source-gateway.mjs <search|fetch|research> [--q <query>|--url <url>] [--json]\n${err.message}\n`,
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
