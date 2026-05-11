#!/usr/bin/env node

// Source resolver for the learning-loop pipeline.
// Resolves citations to verified metadata via PubMed, Europe PMC, arXiv, Semantic Scholar,
// CrossRef, OpenAlex, DBLP, Unpaywall, RFC Editor, Open Library, and ChEMBL APIs.
// Maintains a citation index for cross-vault consistency checks.
//
// Usage:
//   source-resolver.mjs resolve "Author Year Topic"        Resolve a citation to verified metadata
//   source-resolver.mjs verify-pmid <pmid> "Author" <year> Verify a specific PMID against claimed author/year
//   source-resolver.mjs verify-doi <doi> "Author" <year>   Verify a specific DOI against claimed author/year
//   source-resolver.mjs verify-note <path>                  Verify all sources in a vault note
//   source-resolver.mjs verify-arxiv <arxiv-id>             Verify an arXiv paper by ID
//   source-resolver.mjs verify-rfc <rfc-number>             Verify an RFC by number
//   source-resolver.mjs verify-isbn <isbn>                  Verify a book by ISBN
//   source-resolver.mjs lookup-compound <name>              Look up a compound in ChEMBL
//   source-resolver.mjs search-pubmed "query" [--mesh]      Structured PubMed search with optional MeSH terms

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { getPluginData } from './lib/config.mjs';

const PLUGIN_DATA = getPluginData();
const PLUGIN_DIR = resolve(import.meta.dirname, '..');
const DATA_DIR = PLUGIN_DATA ? join(PLUGIN_DATA, 'data') : join(PLUGIN_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_PATH = join(DATA_DIR, 'resolver-config.json');

function loadResolverConfig() {
  const { value, error } = safeLoad(CONFIG_PATH, { fallback: {} });
  if (error) logError('source-resolver.loadResolverConfig', error);
  return value ?? {};
}

import pubmed from './lib/sources/adapters/pubmed.mjs';
import arxiv from './lib/sources/adapters/arxiv.mjs';
import rfc from './lib/sources/adapters/rfc.mjs';
import openlibrary from './lib/sources/adapters/openlibrary.mjs';
import chembl from './lib/sources/adapters/chembl.mjs';
import { verifyDoi } from './lib/sources/adapters/crossref.mjs';
import { resolveSource } from './lib/sources/registry.mjs';
import { verifyNote } from './verify/verify-note.mjs';
import { structuredPubmedSearch } from './verify/structured-pubmed.mjs';
import { checkClaims } from './verify/check-claims.mjs';
import { isBlockedFetch, fetchPageText, WEB_FETCH_BLOCKLIST } from './lib/sources/web-fetch.mjs';
import { safeLoad } from './lib/safe-load.mjs';
import { logError } from './lib/log.mjs';

// --- CLI ---

async function main() {
  const [, , command, ...args] = process.argv;

  const HELP_TEXT = `source-resolver.mjs <command> [args...]

Commands:
  resolve "<author year topic>"          Resolve a citation against PubMed/Crossref/etc
  verify-pmid <pmid> "<author>" [year]   Confirm a PMID matches author/year
  verify-doi <doi> "<author>" [year]     Confirm a DOI matches author/year
  verify-arxiv <arxiv-id>                Fetch arXiv metadata
  verify-rfc <rfc-number>                Fetch RFC metadata
  verify-isbn <isbn>                     Fetch ISBN metadata from Open Library
  lookup-compound "<name>"               Look up a compound in ChEMBL
  verify-note <path>                     Verify all sources/claims in a note
  search-pubmed "<query>" [--mesh]       Structured PubMed search
  check-claims <path>                    Verify claims against fetched URLs

Output: JSON. Exit 0 on success, 1 on unknown command or error.
`;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const config = loadResolverConfig();
  let result;

  switch (command) {
    case 'resolve':
      result = await resolveSource(args.join(' '));
      break;
    case 'verify-pmid':
      result = await pubmed.verify({
        pmid: args[0],
        claimedAuthor: args[1],
        claimedYear: args[2] ? parseInt(args[2]) : null,
      });
      break;
    case 'verify-doi':
      result = await verifyDoi(args[0], args[1], args[2] ? parseInt(args[2]) : null);
      break;
    case 'verify-arxiv':
      result = await arxiv.fetchById(args[0]);
      if (!result) result = { error: `arXiv ID ${args[0]} not found` };
      break;
    case 'verify-rfc':
      result = await rfc.fetchById(args[0]);
      if (!result) result = { error: `RFC ${args[0]} not found` };
      break;
    case 'verify-isbn':
      result = await openlibrary.fetchByIsbn(args[0]);
      if (!result) result = { error: `ISBN ${args[0]} not found in Open Library` };
      break;
    case 'lookup-compound':
      result = await chembl.lookup(args.join(' '));
      if (!result) result = { error: `Compound "${args.join(' ')}" not found in ChEMBL` };
      break;
    case 'verify-note':
      result = await verifyNote(resolve(args[0]), config);
      break;
    case 'search-pubmed':
      result = await structuredPubmedSearch(
        args.filter((a) => a !== '--mesh').join(' '),
        args.includes('--mesh'),
      );
      break;
    case 'check-claims':
      result = await checkClaims(resolve(args[0]));
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP_TEXT}`);
      process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

export const __test__ = { checkClaims, fetchPageText, isBlockedFetch, WEB_FETCH_BLOCKLIST };
