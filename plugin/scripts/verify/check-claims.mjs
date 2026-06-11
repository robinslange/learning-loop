import { readFileSync } from 'fs';
import { extractSourcesFromNote } from '../lib/sources/note-extract.mjs';
import { extractNumbers, findNumberInAbstract } from '../lib/sources/claim-numbers.mjs';
import { isBlockedFetch, fetchPageText } from '../lib/sources/web-fetch.mjs';
import { pubmedFetch } from '../lib/sources/adapters/pubmed.mjs';
import { fetchJSON } from '../lib/sources/http.mjs';
import arxiv from '../lib/sources/adapters/arxiv.mjs';

export async function checkClaims(notePath) {
  const content = readFileSync(notePath, 'utf-8');
  const sources = extractSourcesFromNote(content);

  const bodyMatch = content.match(/^---[\s\S]*?---\s*\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;
  const allNumbers = extractNumbers(body);
  if (allNumbers.length === 0) return [];

  const results = [];

  for (const src of sources) {
    let metadata = null;
    let sourceKind = null;

    if (src.pmid) {
      metadata = await pubmedFetch(src.pmid);
      sourceKind = 'abstract';
    } else if (src.arxivId) {
      metadata = await arxiv.fetchById(src.arxivId);
      sourceKind = 'abstract';
    } else if (src.doi) {
      const url = 'https://api.crossref.org/works/' + encodeURIComponent(src.doi);
      const crData = await fetchJSON(url);
      if (crData?.message) {
        const abstract = (crData.message.abstract || '').replace(/<[^>]+>/g, '');
        metadata = { abstract, title: crData.message.title?.[0] };
        sourceKind = 'abstract';
      }
    } else if (src.url && !isBlockedFetch(src.url)) {
      const result = await fetchPageText(src.url);
      if (result.ok) {
        metadata = { abstract: result.text };
        sourceKind = 'page';
      }
    }

    if (!metadata?.abstract) continue;

    const srcLabel = src.claimedAuthor
      ? (src.claimedAuthor + ' ' + (src.claimedYear || '')).trim()
      : src.pmid || src.doi || src.url;

    for (const num of allNumbers) {
      const { found, excerpt } = findNumberInAbstract(num, metadata.abstract);
      results.push({
        source: srcLabel,
        pmid: src.pmid || null,
        doi: src.doi || null,
        url: src.url || null,
        source_kind: sourceKind,
        claim: num,
        in_abstract: found,
        abstract_excerpt: excerpt,
      });
    }
  }

  return results;
}
