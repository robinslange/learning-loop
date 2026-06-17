// plugin/scripts/librarian/research/source-id.mjs : derive a verifiable sourceId
// from a source URL.
//
// PubMed/PMC/arXiv/DOI URLs carry their identifier in the path, where it is
// deterministic. The model is unreliable at finding the same id in chrome-heavy
// fetched page text (PubMed strips the PMID from the rendered text), so the URL
// is the authoritative source for the id. author/year are left null here; the
// resolver fills canonical author/year from the resolved record, and the
// deterministic branch runs resolve-only when the claimed author is absent.

// Only kinds the resolver can verify in their OWN id space. PMC is deliberately
// absent: a PMC number is not a PMID, and the pubmed adapter looks ids up as
// `db=pubmed&id=<pmid>`, so feeding it a PMC number would resolve a different
// paper and manufacture a false verdict. A PMC-only URL yields null here and the
// claim routes to GLM, which is the safe default.
const PATTERNS = [
  { kind: 'pmid', re: /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i },
  { kind: 'arxiv', re: /arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$/i },
  { kind: 'doi', re: /(?:doi\.org\/|\/doi\/(?:full\/|abs\/)?)(10\.\d{4,}\/[^\s?#]+)/i },
];

// Publisher article URLs append a view qualifier as a trailing path segment
// (Wiley's /doi/<DOI>/full, /abstract, /pdf, /epdf, /references). The DOI itself
// never ends in one of these words, so trimming a trailing /<qualifier> recovers
// the resolvable id without touching a DOI whose own path contains slashes.
const DOI_PATH_SUFFIX = /\/(full|abstract|abs|pdf|epdf|references|metrics|citedby)\/?$/i;

/**
 * Parse a verifiable identifier out of a source URL. Returns a sourceId object
 * `{ kind, id, author: null, year: null }` or `null` when the URL carries no
 * recognizable identifier the resolver can check in its own id space.
 * @param {string} url
 * @returns {{kind:string,id:string,author:null,year:null}|null}
 */
export function sourceIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(url);
    if (m) {
      let id = m[1].replace(/\/$/, '');
      if (kind === 'doi') id = id.replace(DOI_PATH_SUFFIX, '');
      return { kind, id, author: null, year: null };
    }
  }
  return null;
}
