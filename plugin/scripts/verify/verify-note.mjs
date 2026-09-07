import { readFileSync } from 'fs';
import { basename } from 'path';
import { extractSourcesFromNote, extractNoteTopicKeywords } from '../lib/sources/note-extract.mjs';
import { findAdapter, resolveSource } from '../lib/sources/registry.mjs';
import { updateCitationIndex, loadCitationIndex } from '../lib/sources/citation-index.mjs';
import unpaywall from '../lib/sources/adapters/unpaywall.mjs';
import { citationAssertionIssues } from './citation-assertions.mjs';

// A source that failed to verify returns `{verified:false, error}` and no
// `issues` array, so every consumer that grades by `issues[].severity` — the
// promotion gate among them — counted zero problems and let the note through.
// A verification that could not run is not a verification that passed.
//
// The mirror failure lives in the bare author-year branch below: a search that
// always returns something made a resolution that could not be trusted read as
// one that had been checked. See citation-assertions.mjs.
//
// Graded by kind: an identifier or author+year that resolves to nothing is the
// fabrication case the check exists for, while a bare link carrying no citation
// claim is merely unverifiable and must not demote every note containing a URL.
const UNCHECKABLE = 'No identifiable source information';

function withFailureIssue(result) {
  if (result.verified !== false) return result;
  if (Array.isArray(result.issues) && result.issues.length > 0) return result;
  const uncheckable = result.error === UNCHECKABLE;
  return {
    ...result,
    issues: [
      {
        type: uncheckable ? 'unverifiable_source' : 'verification_failed',
        severity: uncheckable ? 'low' : 'high',
        reason: result.error || 'verification did not complete',
      },
    ],
  };
}

export async function verifyNote(notePath, config = {}) {
  const content = readFileSync(notePath, 'utf-8');
  const sources = extractSourcesFromNote(content);
  const noteFilename = basename(notePath);
  const topicKeywords = extractNoteTopicKeywords(content);
  const results = [];

  for (const src of sources) {
    let result;
    const adapter = findAdapter(src);

    if (adapter) {
      result = await adapter.verify(src);
    } else if (src.url) {
      // The note cited a specific document. No adapter means no identifier was
      // extractable from it, and searching for its author and year would verify
      // some other work that happens to share them — not the thing cited.
      result = { verified: false, error: UNCHECKABLE, metadata: null };
    } else if (src.claimedAuthor && src.claimedYear) {
      const query = topicKeywords
        ? `${src.claimedAuthor} ${src.claimedYear} ${topicKeywords}`
        : `${src.claimedAuthor} ${src.claimedYear}`;
      const resolved = await resolveSource(query);
      if (resolved.resolved) {
        const issues = citationAssertionIssues(src.claimedAuthor, src.claimedYear, resolved);
        result = { verified: issues.length === 0, issues, metadata: resolved };
      } else {
        result = { verified: false, error: 'Source not found in any database', metadata: null };
      }
    } else {
      result = { verified: false, error: 'No identifiable source information', metadata: null };
    }

    if (result.metadata?.doi) {
      const upw = await unpaywall.enrichDoi(result.metadata.doi, config);
      if (upw) {
        result.metadata.is_oa = upw.is_oa;
        result.metadata.oa_url = upw.oa_url;
      }
    }

    if (result.metadata?.pmid) {
      await updateCitationIndex(result.metadata.pmid, result.metadata, noteFilename);
    }

    results.push({ source: src, ...withFailureIssue(result) });
  }

  const index = loadCitationIndex();
  const crossVaultIssues = [];
  for (const r of results) {
    if (r.metadata?.pmid) {
      const entry = index[`pmid:${r.metadata.pmid}`];
      if (entry && entry.cited_in.length > 1) {
        crossVaultIssues.push({
          pmid: r.metadata.pmid,
          cited_in: entry.cited_in,
          authors: entry.authors,
        });
      }
    }
  }

  return { notePath, sources: results, crossVaultIssues };
}
