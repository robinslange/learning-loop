import { readFileSync } from 'fs';
import { basename } from 'path';
import { extractSourcesFromNote, extractNoteTopicKeywords } from '../lib/sources/note-extract.mjs';
import { findAdapter, resolveSource } from '../lib/sources/registry.mjs';
import { updateCitationIndex, loadCitationIndex } from '../lib/sources/citation-index.mjs';
import unpaywall from '../lib/sources/adapters/unpaywall.mjs';
import { authorMatches, firstAuthorMatches } from '../lib/sources/author-match.mjs';

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
    } else if (src.claimedAuthor && src.claimedYear) {
      const query = topicKeywords
        ? `${src.claimedAuthor} ${src.claimedYear} ${topicKeywords}`
        : `${src.claimedAuthor} ${src.claimedYear}`;
      const resolved = await resolveSource(query);
      if (resolved.resolved) {
        const issues = [];
        const resolvedAuthors = resolved.authors || [];
        if (resolvedAuthors.length === 0) {
          issues.push({
            type: 'unverifiable_author',
            severity: 'low',
            claimed: src.claimedAuthor,
            reason: 'no author metadata from resolver',
          });
        } else if (!firstAuthorMatches(src.claimedAuthor, resolvedAuthors)) {
          if (!authorMatches(src.claimedAuthor, resolvedAuthors)) {
            issues.push({
              type: 'wrong_author',
              severity: 'high',
              claimed: src.claimedAuthor,
              actual_first: resolved.firstAuthor,
            });
          }
        }
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
      updateCitationIndex(result.metadata.pmid, result.metadata, noteFilename);
    }

    results.push({ source: src, ...result });
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
