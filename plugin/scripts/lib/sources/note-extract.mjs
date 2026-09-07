import { extractAuthorYearCitations } from '../cite-extract.mjs';

const AUTHOR_YEAR =
  /([A-Z][a-zÀ-ɏ]+(?:-[A-Z][a-zÀ-ɏ]+)*(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-zÀ-ɏ]+))*)\s*[\(,]?\s*((?:19|20)\d{2})/g;

// The author-year belonging to an identifier is the LAST one before it, not the
// first in a fixed lookback: a window wide enough to hold two citations would
// otherwise bind every identifier to the earliest author on the line. Stop at a
// citation boundary (";" or a preceding identifier) so a window never reaches
// back into the citation before this one.
function nearestAuthorYear(content, index) {
  const start = Math.max(0, index - 240);
  let window = content.slice(start, index);

  const boundary = Math.max(
    window.lastIndexOf(';'),
    window.lastIndexOf('\n'),
    window.lastIndexOf('- "'),
  );
  if (boundary !== -1) window = window.slice(boundary + 1);

  // A previous identifier in the window means its author already claimed
  // everything to its left.
  const prevId = /(?:PMID|PubMed)\s+\d{7,8}|PMC\s?\d{5,8}|10\.\d{4,9}\/\S+/gi;
  let lastId = -1,
    idm;
  while ((idm = prevId.exec(window)) !== null) lastId = idm.index + idm[0].length;
  if (lastId !== -1) window = window.slice(lastId);

  AUTHOR_YEAR.lastIndex = 0;
  let match = null,
    m;
  while ((m = AUTHOR_YEAR.exec(window)) !== null) match = m;
  return match;
}

// Citation link text puts the year either straight after the author
// (`Smith 2020`) or on the far side of a title (`Rogers, "Caffeine and
// Alertness" (2014)`). Anchoring the year to the author matched only the first
// form, so every titled citation parsed as author:null — which in turn made the
// short-form dedup below unable to recognise a later bare mention of that same
// work, and the resolver went looking for it by search.
const AUTHOR_GROUP = /^([A-Z][a-zÀ-ɏ]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-zÀ-ɏ]+|[A-Z][a-zÀ-ɏ]+))*)/;

function parseAuthorYear(text) {
  const author = text.match(AUTHOR_GROUP);
  if (!author) return null;
  const rest = text.slice(author[1].length);
  // A parenthesised year is the citation's own; a bare one may belong to the
  // title (`"Trends since 1990"`), so it is only the fallback.
  const year = rest.match(/\((\d{4})\)/) || rest.match(/\b((?:19|20)\d{2})\b/);
  return year ? [text, author[1], year[1]] : null;
}

export function extractSourcesFromNote(content) {
  const sources = [];

  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    const text = m[1];
    const url = m[2];

    const pmidMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
    const pmcMatch = url.match(
      /(?:pmc\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(PMC\d+)/,
    );
    // Publishers serve the same DOI under their own host (`/doi/full/10.x/y`),
    // so anchor on the DOI's own shape rather than on doi.org. Stop at `?` and
    // `#` — tracking parameters are not part of the identifier.
    const doiMatch = url.match(/(10\.\d{4,9}\/[^\s?#]+)/);
    const arxivUrlMatch = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
    const rfcUrlMatch = url.match(/rfc-editor\.org\/rfc\/rfc(\d{3,5})/);

    const authorYearMatch = parseAuthorYear(text);

    sources.push({
      text,
      url,
      pmid: pmidMatch?.[1] || null,
      pmc: pmcMatch?.[1] || null,
      doi: doiMatch?.[1] || null,
      arxivId: arxivUrlMatch?.[1]?.replace(/v\d+$/, '') || null,
      rfcNumber: rfcUrlMatch?.[1] || null,
      claimedAuthor: authorYearMatch?.[1] || null,
      claimedYear: authorYearMatch?.[2] ? parseInt(authorYearMatch[2]) : null,
    });
  }

  // `PMID: 12345678` is at least as common as the bare-space form, and the
  // trailing guard matters more: without it a 12-digit run was truncated to its
  // first 8 digits and verified against a DIFFERENT, real article — a fabricated
  // identifier resolving to a genuine paper is worse than one that 404s.
  const pmidInlineRe = /(?:PMIDs?|PubMed)\s*:?\s*(\d{7,8})(?!\d)/gi;
  while ((m = pmidInlineRe.exec(content)) !== null) {
    const pmid = m[1];
    if (!sources.some((s) => s.pmid === pmid)) {
      const authorYearMatch = nearestAuthorYear(content, m.index);
      sources.push({
        text: `PMID ${pmid}`,
        url: null,
        pmid,
        pmc: null,
        doi: null,
        claimedAuthor: authorYearMatch?.[1] || null,
        claimedYear: authorYearMatch?.[2] ? parseInt(authorYearMatch[2]) : null,
      });
    }
  }

  const pmcInlineRe = /PMC\s?(\d{5,8})/g;
  while ((m = pmcInlineRe.exec(content)) !== null) {
    const pmc = `PMC${m[1]}`;
    if (!sources.some((s) => s.pmc === pmc)) {
      const authorYearMatch = nearestAuthorYear(content, m.index);
      sources.push({
        text: `${pmc}`,
        url: null,
        pmid: null,
        pmc,
        doi: null,
        claimedAuthor: authorYearMatch?.[1] || null,
        claimedYear: authorYearMatch?.[2] ? parseInt(authorYearMatch[2]) : null,
      });
    }
  }

  const posMatches = extractAuthorYearCitations(content);
  for (const { author, year } of posMatches) {
    if (
      !sources.some((s) => s.claimedAuthor === author && s.claimedYear === year) &&
      !sources.some((s) => s.claimedAuthor?.includes(author) && s.claimedYear === year)
    ) {
      sources.push({
        text: `${author} ${year}`,
        url: null,
        pmid: null,
        pmc: null,
        doi: null,
        claimedAuthor: author,
        claimedYear: year,
      });
    }
  }

  const arxivInlineRe = /(?:arXiv:\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
  while ((m = arxivInlineRe.exec(content)) !== null) {
    const arxivId = m[1].replace(/v\d+$/, '');
    if (!sources.some((s) => s.arxivId === arxivId)) {
      sources.push({
        text: `arXiv:${arxivId}`,
        url: `https://arxiv.org/abs/${arxivId}`,
        pmid: null,
        pmc: null,
        doi: null,
        arxivId,
        claimedAuthor: null,
        claimedYear: null,
      });
    }
  }

  const rfcInlineRe = /(?:RFC\s*(\d{3,5})|rfc-editor\.org\/rfc\/rfc(\d{3,5}))/gi;
  while ((m = rfcInlineRe.exec(content)) !== null) {
    const rfcNum = m[1] || m[2];
    if (!sources.some((s) => s.rfcNumber === rfcNum)) {
      sources.push({
        text: `RFC ${rfcNum}`,
        url: `https://www.rfc-editor.org/rfc/rfc${rfcNum}`,
        pmid: null,
        pmc: null,
        doi: null,
        rfcNumber: rfcNum,
        claimedAuthor: null,
        claimedYear: null,
      });
    }
  }

  const isbnInlineRe = /ISBN[:\s]*([\d][\d\s-]{8,16}[\dX])/gi;
  while ((m = isbnInlineRe.exec(content)) !== null) {
    const isbn = m[1].replace(/[-\s]/g, '');
    if (!sources.some((s) => s.isbn === isbn)) {
      sources.push({
        text: `ISBN ${isbn}`,
        url: null,
        pmid: null,
        pmc: null,
        doi: null,
        isbn,
        claimedAuthor: null,
        claimedYear: null,
      });
    }
  }

  return sources;
}

export function extractNoteTopicKeywords(content) {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (!titleMatch) return '';
  return titleMatch[1]
    .replace(/[-_]/g, ' ')
    .replace(
      /\b(is|are|the|a|an|and|or|but|not|for|in|on|of|to|with|by|from|as|at|vs|has|have|had|was|were|be|been)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join(' ');
}
