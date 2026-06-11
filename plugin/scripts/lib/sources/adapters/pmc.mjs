import { fetchJSON, sleep, RATE_LIMIT_MS } from '../http.mjs';
import { authorMatches, firstAuthorMatches } from '../author-match.mjs';

function matches(src) {
  return !!src.pmc;
}

async function verify(src) {
  const pmcId = src.pmc.replace(/^PMC/i, '');
  const convertUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pmc&id=${pmcId}&retmode=json`;
  await sleep(RATE_LIMIT_MS);
  let data = await fetchJSON(convertUrl);
  if (!data?.result?.[pmcId]) {
    await sleep(1000);
    data = await fetchJSON(convertUrl);
  }
  const pmcResult = data?.result?.[pmcId];
  if (!pmcResult) {
    return { verified: false, error: `Could not resolve ${src.pmc}`, metadata: null };
  }

  const pmcAuthors = (pmcResult.authors || []).map((a) => a.name || '');
  const pmcYear = parseInt(pmcResult.pubdate?.match(/\d{4}/)?.[0]) || null;
  const pmcTitle = pmcResult.title || null;
  const issues = [];

  if (src.claimedAuthor) {
    if (pmcAuthors.length === 0) {
      issues.push({
        type: 'unverifiable_author',
        severity: 'low',
        claimed: src.claimedAuthor,
        reason: 'no author metadata from PMC',
      });
    } else if (!firstAuthorMatches(src.claimedAuthor, pmcAuthors)) {
      if (!authorMatches(src.claimedAuthor, pmcAuthors)) {
        issues.push({
          type: 'wrong_author',
          severity: 'high',
          claimed: src.claimedAuthor,
          actual_first: pmcAuthors[0],
          actual_all: pmcAuthors,
        });
      } else {
        issues.push({
          type: 'author_not_first',
          severity: 'medium',
          claimed: src.claimedAuthor,
          actual_first: pmcAuthors[0],
        });
      }
    }
  }

  if (src.claimedYear && pmcYear && Math.abs(src.claimedYear - pmcYear) > 1) {
    issues.push({
      type: 'wrong_year',
      severity: 'high',
      claimed: src.claimedYear,
      actual: pmcYear,
    });
  }

  return {
    verified: issues.length === 0,
    issues,
    metadata: {
      source: 'pmc',
      pmc: src.pmc,
      title: pmcTitle,
      authors: pmcAuthors,
      firstAuthor: pmcAuthors[0] || null,
      year: pmcYear,
    },
  };
}

export default { id: 'pmc', matches, verify };
