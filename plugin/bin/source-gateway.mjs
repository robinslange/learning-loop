#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveSlot as defaultResolveSlot } from '../scripts/lib/sources/registry.mjs';
import { orchestrateResearch as defaultOrchestrateResearch } from '../scripts/librarian/research.mjs';
import { getSessionId } from '../scripts/lib/session.mjs';
import { getPluginData } from '../scripts/lib/config.mjs';
import { readCount, bumpCount } from '../scripts/lib/fetch-budget.mjs';
import { checkFetchUrl } from '../scripts/lib/sources/url-guard.mjs';

const VERBS = new Set(['search', 'fetch', 'research']);

const DEFAULT_FETCH_BUDGET = Number(process.env.LL_GATEWAY_FETCH_BUDGET) || 10;

export function parseArgs(argv) {
  const out = { verb: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--q') out.q = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--angles') out.angles = JSON.parse(argv[++i]);
    else if (a === '--max-fetch') out.maxFetch = Number(argv[++i]);
  }
  return out;
}

class UsageError extends Error {}

export async function runGateway(argv, deps = {}) {
  const {
    resolveSlot = defaultResolveSlot,
    orchestrateResearch = defaultOrchestrateResearch,
    fetchBudget,
    budgetStore,
    sessionId,
    pluginData,
  } = deps;
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
    const { bundle, exitCode, model } = await orchestrateResearch(args.q, {
      angles: args.angles,
      maxFetch: args.maxFetch,
    });
    if (exitCode === 3) {
      const e = new Error(`model "${model}" is below the research tier (needs 12b+)`);
      e.exitCode = 3;
      throw e;
    }
    return bundle;
  }
  // fetch
  if (!args.url) throw new UsageError('fetch requires --url <url>');
  // SSRF gate. web-guard.js denies WebFetch/WebSearch and points the model here,
  // so this is the ONLY egress path — an unvalidated --url turns the gateway into
  // a proxy for loopback/link-local services (Ollama, cloud IMDS). Checked before
  // the budget bump: a rejected URL must not consume the session's fetch budget.
  const urlCheck = checkFetchUrl(args.url);
  if (!urlCheck.ok) {
    return {
      doc: { ok: false, reason: `blocked_url:${urlCheck.reason}` },
      source_used: 'url-guard',
    };
  }
  const budget = fetchBudget ?? DEFAULT_FETCH_BUDGET;
  const source = resolveSlot('fetch');
  // Budget enforcement via injected store (tests) or file-backed per-session counter (production).
  // Graceful degrade: when sessionId is empty or pluginData is null, store is absent and no
  // enforcement happens — fetch never throws from a missing data dir.
  const store = budgetStore ?? buildFileStore(sessionId, pluginData);
  if (store) {
    if (store.n >= budget) {
      return { doc: { ok: false, reason: 'fetch_budget_exceeded' }, source_used: source.id };
    }
    store.bump();
  }
  const doc = await source.fetch(args.url);
  return { doc, source_used: source.id };
}

function buildFileStore(sid, pd) {
  // Resolve production session/pluginData when not injected by tests.
  const resolvedSid = sid !== undefined ? sid : getSessionId();
  const resolvedPd = pd !== undefined ? pd : getPluginData();
  if (!resolvedPd || !resolvedSid || resolvedSid === 'unknown') return null;
  return {
    get n() {
      return readCount(resolvedSid, resolvedPd);
    },
    bump() {
      bumpCount(resolvedSid, resolvedPd);
    },
  };
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
    if (err.exitCode) {
      process.stderr.write('source-gateway: ' + err.message + '\n');
      process.exit(err.exitCode);
    }
    process.stderr.write('source-gateway failed: ' + err.message + '\n');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
