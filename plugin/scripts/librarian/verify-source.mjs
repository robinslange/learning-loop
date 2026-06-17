// plugin/scripts/librarian/verify-source.mjs : deterministic source verification for one claim.
//
// Positive-evidence-only: PASS on a clean resolved match, KILL on a resolved record
// with a high-severity author/year mismatch, DEFER on anything ambiguous (not-found,
// null data, transient API error - fetchJSON returns null on any non-2xx, so a 503
// is indistinguishable from a missing id). Deferred and thrown results both route to
// GLM. survives is true/false for pass/kill, null for defer.

import pubmed from '../lib/sources/adapters/pubmed.mjs';
import arxiv from '../lib/sources/adapters/arxiv.mjs';
import rfc from '../lib/sources/adapters/rfc.mjs';
import openlibrary from '../lib/sources/adapters/openlibrary.mjs';
import { verifyDoi } from '../lib/sources/adapters/crossref.mjs';
import { fileURLToPath } from 'node:url';

const HIGH = (issues) => (issues || []).some((i) => i.severity === 'high');

/**
 * @param {{claim:string, quote?:string, url?:string}} claim
 * @param {{kind:string,id:string,author?:string|null,year?:number|null}} sourceId
 * @param {{pubmedVerify:Function, verifyDoi:Function, fetchById:Function}} deps
 * @returns {Promise<{claim:string, verdict:'pass'|'kill'|'defer', survives:boolean|null, issues:object[], metadata:object, evidence:string, mode:'mechanical'}>}
 */
export async function verifyClaimSource(claim, sourceId, deps) {
  const { kind, id, author = null, year = null } = sourceId;
  let res;

  if (kind === 'pmid') {
    res = await deps.pubmedVerify({ pmid: id, claimedAuthor: author, claimedYear: year });
  } else if (kind === 'doi') {
    res = await deps.verifyDoi(id, author, year);
  } else if (kind === 'arxiv' || kind === 'rfc' || kind === 'isbn') {
    const meta = await deps.fetchById(kind, id);
    res = meta
      ? { verified: true, issues: [], metadata: meta }
      : { verified: false, error: `${kind} unresolved` };
  } else {
    res = { verified: false, error: `unknown sourceId kind: ${kind}` };
  }

  const issues = res.issues ? [...res.issues] : [];
  let verdict;
  let survives;

  if (res.error || (!res.verified && !HIGH(issues))) {
    verdict = 'defer';
    survives = null;
    if (res.error)
      issues.push({ type: 'unresolved_or_unavailable', severity: 'low', detail: res.error });
  } else if (HIGH(issues)) {
    verdict = 'kill';
    survives = false;
  } else {
    verdict = 'pass';
    survives = true;
    if (author == null && (kind === 'pmid' || kind === 'doi')) {
      issues.push({ type: 'author_not_checked', severity: 'low' });
    }
  }

  const evidence =
    verdict === 'defer'
      ? `mechanical: ${kind}:${id} could not be resolved (deferred to GLM)`
      : `mechanical: ${kind}:${id} resolved -> ${verdict}` +
        (issues.length ? `; issues: ${issues.map((i) => i.type).join(', ')}` : '; clean match');

  return {
    claim: claim.claim,
    verdict,
    survives,
    issues,
    metadata: res.metadata || {},
    evidence,
    mode: 'mechanical',
  };
}

const defaultDeps = {
  pubmedVerify: (a) => pubmed.verify(a),
  verifyDoi: (id, author, year) => verifyDoi(id, author, year),
  fetchById: (kind, id) =>
    (
      ({
        arxiv: () => arxiv.fetchById(id),
        rfc: () => rfc.fetchById(id),
        isbn: () => openlibrary.fetchByIsbn(id),
      })[kind] ?? (() => null)
    )(),
};

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  readStdin()
    .then(({ claim }) => verifyClaimSource(claim, claim.sourceId, defaultDeps))
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
