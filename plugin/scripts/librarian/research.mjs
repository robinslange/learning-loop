// plugin/scripts/librarian/research.mjs : local research engine entrypoint.
//
// runResearch(question, opts) drives Search -> dedup -> Fetch -> Extract and
// returns a claims bundle. Collaborators (searchFn, fetchTextFn, extractFn) are
// injected with live defaults, so orchestration is testable without the network.
// The CLI wrapper parses argv and prints the bundle (a temp-file path, or the
// JSON itself with --json).
//
// Usage:
//   node research.mjs --question "<q>" [--angles '<json>'] [--model m] [--max-fetch n] [--json]
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { search as braveSearch } from './research/brave.mjs';
import { fetchText as defaultFetchText } from './research/fetch.mjs';
import { extractClaims } from './research/extract.mjs';
import { sourceIdFromUrl } from './research/source-id.mjs';
import { loadLibrarianConfig, researchModelOk } from './config.mjs';

const DEFAULT_MAX_FETCH = 15;

/**
 * Resolve which model the CLI should use: an explicit --model wins, else the
 * configured librarian.model. Returns { model, ok } where ok gates whether the
 * model is research-capable (12b+). The orchestrator stays model-agnostic; the
 * tier gate lives here at the CLI edge so research refuses on the e2b tier
 * instead of silently producing thin claims.
 * @param {string|undefined} argModel
 * @param {string} cfgModel
 */
export function resolveModel(argModel, cfgModel) {
  const model = argModel || cfgModel;
  return { model, ok: researchModelOk(model) };
}

/**
 * @param {string} question
 * @param {{
 *   angles?: {label:string, query:string}[],
 *   maxFetch?: number,
 *   model?: string,
 *   keepAlive?: string,
 *   searchFn?: (q:string)=>Promise<{url:string,title:string,snippet:string}[]>,
 *   fetchTextFn?: (url:string)=>Promise<{text:string,ok:boolean,reason:string}>,
 *   extractFn?: (text:string,q:string,opts:object)=>Promise<{sourceQuality:string,sourceId?:object,claims:object[]}>,
 * }} [opts]
 */
export async function runResearch(question, opts = {}) {
  const {
    angles = [{ label: 'general', query: question }],
    maxFetch = DEFAULT_MAX_FETCH,
    model,
    keepAlive,
    searchFn = (q) => braveSearch(q),
    fetchTextFn = (url) => defaultFetchText(url),
    extractFn = (text, q, o) => extractClaims(text, q, o),
  } = opts;

  const searchResults = await Promise.all(angles.map((a) => searchFn(a.query)));
  const seen = new Set();
  const urls = [];
  for (const list of searchResults) {
    for (const r of list) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        urls.push(r);
      }
    }
  }
  const picked = urls.slice(0, maxFetch);

  // Fetch is I/O-bound: fetch all picked URLs concurrently. Promise.all keeps the
  // result array index-aligned to `picked` regardless of completion order.
  const fetched = await Promise.all(picked.map((r) => fetchTextFn(r.url)));

  // Extraction is GPU-bound on one local model — Ollama serializes concurrent
  // requests, so parallel extracts only add overhead. Extract serially, but write
  // each picked URL's result into its OWN slot. The output is a projection of this
  // index-aligned array, so output order is the `picked` order by construction —
  // there is no completion-ordered accumulator that could diverge from it.
  const results = new Array(picked.length);
  for (let i = 0; i < picked.length; i++) {
    const r = picked[i];
    const f = fetched[i];
    if (!f.ok) {
      results[i] = { skipped: { url: r.url, reason: f.reason } };
      continue;
    }
    const {
      sourceQuality,
      sourceId,
      claims: cs,
    } = await extractFn(f.text, question, {
      model,
      keepAlive,
    });
    // The URL carries the identifier deterministically; the model is unreliable
    // at finding it in chrome-heavy page text (PubMed strips the PMID). Prefer the
    // URL-derived id, fall back to the model's, null if neither.
    const resolvedSourceId = sourceIdFromUrl(r.url) ?? sourceId ?? null;
    results[i] = {
      source: {
        url: r.url,
        title: r.title,
        sourceQuality,
        sourceId: resolvedSourceId,
        fetchOk: true,
      },
      claims: cs.map((c) => ({ ...c, url: r.url, sourceId: resolvedSourceId })),
    };
  }

  return {
    question,
    angles,
    sources: results.filter((x) => x.source).map((x) => x.source),
    claims: results.flatMap((x) => x.claims ?? []),
    skipped: results.filter((x) => x.skipped).map((x) => x.skipped),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--question') out.question = argv[++i];
    else if (a === '--angles') out.angles = JSON.parse(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--max-fetch') out.maxFetch = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    process.stderr.write(
      'Usage: research.mjs --question "<q>" [--angles json] [--model m] [--max-fetch n] [--json]\n',
    );
    process.exit(2);
  }
  const cfg = loadLibrarianConfig();
  const { model, ok } = resolveModel(args.model, cfg.model);
  if (!ok) {
    process.stderr.write(
      `research: model "${model}" is below the research tier (needs 12b+). ` +
        `Set librarian.model to gemma3:12b, or let /deep-research use its Claude-native path.\n`,
    );
    process.exit(3);
  }
  const bundle = await runResearch(args.question, {
    angles: args.angles,
    maxFetch: args.maxFetch,
    model,
    keepAlive: cfg.keepAlive,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(bundle, null, 2));
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'librarian-research-'));
    const file = join(dir, 'bundle.json');
    writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf-8');
    process.stdout.write(file);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write('research failed: ' + err.message + '\n');
    process.exit(1);
  });
}
