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

const DEFAULT_MAX_FETCH = 15;

/**
 * @param {string} question
 * @param {{
 *   angles?: {label:string, query:string}[],
 *   maxFetch?: number,
 *   model?: string,
 *   searchFn?: (q:string)=>Promise<{url:string,title:string,snippet:string}[]>,
 *   fetchTextFn?: (url:string)=>Promise<{text:string,ok:boolean,reason:string}>,
 *   extractFn?: (text:string,q:string,opts:object)=>Promise<{sourceQuality:string,claims:object[]}>,
 * }} [opts]
 */
export async function runResearch(question, opts = {}) {
  const {
    angles = [{ label: 'general', query: question }],
    maxFetch = DEFAULT_MAX_FETCH,
    model,
    searchFn = (q) => braveSearch(q),
    fetchTextFn = (url) => defaultFetchText(url),
    extractFn = (text, q) => extractClaims(text, q, { model }),
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

  const sources = [];
  const claims = [];
  const skipped = [];
  for (const r of picked) {
    const fetched = await fetchTextFn(r.url);
    if (!fetched.ok) {
      skipped.push({ url: r.url, reason: fetched.reason });
      continue;
    }
    const { sourceQuality, claims: cs } = await extractFn(fetched.text, question, { model });
    sources.push({ url: r.url, title: r.title, sourceQuality, fetchOk: true });
    for (const c of cs) claims.push({ ...c, url: r.url });
  }

  return { question, angles, sources, claims, skipped };
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
  const bundle = await runResearch(args.question, {
    angles: args.angles,
    maxFetch: args.maxFetch,
    model: args.model,
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
