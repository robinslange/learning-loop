import { extractSurnames, firstAuthorMatches } from '../lib/sources/author-match.mjs';

// A bare author-year mention carries no identifier, so the resolver reaches it
// by search and gets back whatever ranks first. The search cannot fail: given
// `Haskell 2005 caffeine` it returns a paper by some Haskell about something.
// Accepting that as verification recorded that the resolver ANSWERED, not that
// it was right, and every consumer grading by issue severity saw a clean pass.
//
// So grade the resolution against what the citation form actually asserts, and
// against nothing else. Each form claims a different amount:
//
//   "X et al."  X is the FIRST author
//   "X & Y"     X and Y are BOTH authors, in no particular position
//   "X"         X is an author, in no particular position
//   <year>      the work was published that year
//
// Anything the form does not assert is not evidence of a wrong paper. A senior
// author cited alone sits last by convention, and a short form that names
// authors two and three is a style choice, not a fabrication.

const ET_AL = /\bet\s+al\b/i;

// "James & Rogers" and "James and Rogers" name two authors; "Haskell et al."
// names one and defers the rest. Splitting on the conjunction keeps each
// claimed name addressable so an absent one can be reported by name.
function splitClaimedAuthors(claimedAuthor) {
  return claimedAuthor
    .split(/\s*(?:&|\band\b|,)\s*/i)
    .map((part) =>
      part
        .replace(ET_AL, '')
        .replace(/[.\s]+$/, '')
        .trim(),
    )
    .filter((part) => extractSurnames(part).length > 0);
}

function surnamesOf(authors) {
  return new Set(authors.flatMap((a) => extractSurnames(a)));
}

export function citationAssertionIssues(claimedAuthor, claimedYear, resolved) {
  const issues = [];
  const authors = resolved?.authors || [];

  if (Number.isInteger(claimedYear) && Number.isInteger(resolved?.year)) {
    const gap = Math.abs(claimedYear - resolved.year);
    // Online-first and print years differ by one routinely. Beyond that the
    // year is contradicting the claim rather than lagging it.
    if (gap === 1) {
      issues.push({
        type: 'year_off_by_one',
        severity: 'low',
        claimed: claimedYear,
        actual: resolved.year,
        reason: 'one-year gap is consistent with online-first publication',
      });
    } else if (gap > 1) {
      issues.push({
        type: 'wrong_year',
        severity: 'high',
        claimed: claimedYear,
        actual: resolved.year,
        reason: `citation claims ${claimedYear}, resolved work published ${resolved.year}`,
      });
    }
  }

  if (authors.length === 0) {
    issues.push({
      type: 'unverifiable_author',
      severity: 'low',
      claimed: claimedAuthor,
      reason: 'no author metadata from resolver',
    });
    return issues;
  }

  const claimedParts = splitClaimedAuthors(claimedAuthor || '');
  const resolvedSurnames = surnamesOf(authors);
  const absent = claimedParts.filter(
    (part) => !extractSurnames(part).some((s) => resolvedSurnames.has(s)),
  );

  if (absent.length > 0) {
    // One claimed name is a plain "wrong paper"; several make it worth naming
    // which of them the resolved work is missing.
    const single = claimedParts.length === 1;
    for (const part of absent) {
      issues.push({
        type: single ? 'wrong_author' : 'missing_claimed_author',
        severity: 'high',
        claimed: part,
        actual_first: authors[0],
        reason: `claimed author "${part}" is not on the resolved work`,
      });
    }
  }

  if (ET_AL.test(claimedAuthor || '') && !firstAuthorMatches(claimedAuthor, authors)) {
    issues.push({
      type: 'wrong_first_author',
      severity: 'high',
      claimed: claimedParts[0] ?? claimedAuthor,
      actual_first: authors[0],
      reason: '"et al." names the first author; the resolved work lists someone else',
    });
  }

  return issues;
}
