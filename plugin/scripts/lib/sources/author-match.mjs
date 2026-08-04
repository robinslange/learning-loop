export function normalizeAuthorName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

// Tokens that appear in author lists but carry no identifying power. Matching
// on one of these is matching on nothing: every Dutch surname shares `van`, and
// every RFC author list shares `ed`.
const STOPWORDS = new Set([
  'et',
  'al',
  'ed',
  'eds',
  'jr',
  'sr',
  'van',
  'von',
  'der',
  'den',
  'del',
  'des',
  'dos',
  'la',
  'le',
]);

export function extractSurnames(name) {
  // Normalise BEFORE filtering: `R.` is two characters raw but one once
  // punctuation is stripped, and a one-letter initial matches almost any
  // surname under a substring test.
  //
  // The cut is at ONE character, not two. Two-letter surnames are common —
  // Wu, Li, Ng, Xu, Ho, Yu — and dropping them leaves nothing to match on, so
  // every citation by such an author gets reported as a wrong author. A
  // two-letter initial pair (`Smith JA` -> `ja`) survives this filter, but
  // whole-token equality means it can only match another literal `ja`.
  return name
    .split(/[\s,&-]+/)
    .map(normalizeAuthorName)
    .filter((s) => s.length > 1 && !STOPWORDS.has(s));
}

// Surnames match when a whole token matches, never on containment. Substring
// containment made `Roberts` match `R. Fielding` (via the `r` initial) and
// `Smith et al.` match `Smithers`, so a fabricated author passed verification
// whenever the real list happened to contain a substring of it.
function shareSurname(claimed, actual) {
  const claimedSurnames = extractSurnames(claimed);
  if (claimedSurnames.length === 0) return false;
  const actualParts = new Set(extractSurnames(actual));
  return claimedSurnames.some((cs) => actualParts.has(cs));
}

export function authorMatches(claimed, actual) {
  if (!actual || actual.length === 0) return false;
  return actual.some((a) => shareSurname(claimed, a));
}

export function firstAuthorMatches(claimed, actualAuthors) {
  if (!actualAuthors || actualAuthors.length === 0) return false;
  return shareSurname(claimed, actualAuthors[0]);
}

export function bestAuthorMatch(candidates, claimedAuthor) {
  if (!claimedAuthor || candidates.length === 0) return candidates[0] || null;
  for (const c of candidates) {
    const authors = c.authors || [];
    if (authors.length > 0 && authorMatches(claimedAuthor, authors)) return c;
  }
  return null;
}
