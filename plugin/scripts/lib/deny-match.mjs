// scripts/lib/deny-match.mjs : the shared deny-term matcher for the portability gates.
// One definition so harvest-scrub (note body + filename) and seed-select (filename)
// can never diverge: a bare term matches case-insensitively on alphanumeric word
// boundaries, regex-escaped. So "acme" blocks "acme-registry"/"acme_registry"/"acme.co"
// (hyphen, underscore, dot are boundaries) but NOT "acmecorp" (embedded in a word),
// and "ai" does not match "maintainer"/"fail".

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a case-insensitive word-boundary regex for a single deny term. */
export function denyTermRegExp(term) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, 'i');
}

/** Does `term` occur in `haystack` on alphanumeric word boundaries? */
export function denyTermMatches(term, haystack) {
  if (typeof term !== 'string' || !term.trim()) return false;
  return denyTermRegExp(term).test(haystack);
}
