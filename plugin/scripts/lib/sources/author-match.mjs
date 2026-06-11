export function normalizeAuthorName(name) {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

export function extractSurnames(name) {
  return name
    .toLowerCase()
    .split(/[\s,&]+/)
    .filter((s) => s.length > 1 && s !== 'et' && s !== 'al' && s !== 'al.')
    .map((s) => normalizeAuthorName(s));
}

export function authorMatches(claimed, actual) {
  if (!actual || actual.length === 0) return false;
  const claimedSurnames = extractSurnames(claimed);
  return actual.some((a) => {
    const actualParts = extractSurnames(a);
    return claimedSurnames.some((cs) =>
      actualParts.some((ap) => cs === ap || cs.includes(ap) || ap.includes(cs)),
    );
  });
}

export function firstAuthorMatches(claimed, actualAuthors) {
  if (!actualAuthors || actualAuthors.length === 0) return false;
  const actualFirst = actualAuthors[0];
  const claimedSurnames = extractSurnames(claimed);
  const actualParts = extractSurnames(actualFirst);
  return claimedSurnames.some((cs) =>
    actualParts.some((ap) => cs === ap || cs.includes(ap) || ap.includes(cs)),
  );
}

export function bestAuthorMatch(candidates, claimedAuthor) {
  if (!claimedAuthor || candidates.length === 0) return candidates[0] || null;
  for (const c of candidates) {
    const authors = c.authors || [];
    if (authors.length > 0 && authorMatches(claimedAuthor, authors)) return c;
  }
  return null;
}
