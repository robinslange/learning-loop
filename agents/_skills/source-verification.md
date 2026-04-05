# Source Verification

## Source Provenance Principle

A source URL is a verified artifact or it is a hallucination risk. There is no middle ground.

**Verified:** The URL was fetched during this session (by the researcher, writer, or verifier) and the page content matched the note's topic. These flow through the pipeline as artifacts, never reconstructed.

**Unverified:** The URL was generated from parametric memory without a fetch. Measured fabrication rates: PubMed IDs ~43%, DOIs ~26%, Wikipedia/RFC ~0%. The opacity of the identifier predicts the fabrication rate.

**The contract between agents:** When a researcher passes sources to a writer, verified URLs arrive in a `Verified Sources` table. The writer copies them verbatim. If a source wasn't fetched, it's marked `unfetched` and the writer uses `source: unverified` in frontmatter. No agent should reconstruct what a prior agent already resolved.

## Verify Source URLs

For each URL in a note or research brief:

1. Fetch the URL using web fetch tools.
2. Check: does the page exist? Does the title/author match what's cited?
3. If dead or mismatched, flag it.

For sources cited by name without a URL:

1. Search the web for the source.
2. If found, provide the correct URL.
3. If not found, flag as unverifiable.

## Author-Title-URL Consistency Check (MANDATORY)

This is the most important check. LLMs routinely attach real PMIDs/URLs to wrong author names — the URL works, the paper is real, but the attribution is fabricated.

For every source with a URL:

1. **Fetch the URL** and extract the actual author list and title from the page content.
2. **Compare the first author** in the note against the first author on the actual page. They must match. Common failure: citing the last/senior author as first author, or citing a well-known researcher who is not an author at all.
3. **Compare the year.** A 2013 paper cannot be from a journal that launched in 2015 (e.g., Science Advances started in 2015).
4. **Compare the journal/venue name** if cited. Flag impossible combinations.
5. **Flag any mismatch** — even if the URL is valid and the paper is real. A real paper with wrong authors is worse than a dead link, because it looks legitimate.

For sources cited by name without a URL:

1. Search PubMed/web for the exact "Author Year" combination.
2. If the paper exists under different authors, flag the misattribution and provide the correct authors.
3. If the PMID/PMC ID is given, fetch it and verify the authors match.

### LLM Hallucination Patterns to Catch

These are the specific failure modes observed in vault audits:

| Pattern | Example | How to Catch |
|---------|---------|-------------|
| Real PMID + wrong author | "Schwarcz & Bhatt 2014 (PMC3915289)" — actual authors are Campbell et al. | Fetch PMC page, extract author list |
| First/last author swap | "Enshell-Seijffers et al. 2020" — Enshell-Seijffers is the senior author; first author is Harshuk-Shabso | Check author order on the page |
| Wrong year, right authors | "Cortese & Phan 2020" — the paper is from 2005 | Check publication date on the page |
| Impossible journal | "Cho et al. 2013 (Science Advances)" — Science Advances launched in 2015 | Check journal founding date |
| Qualitative review cited for quantitative results | "effect size g=0.12 (Battleday & Brem 2015)" — paper is a qualitative review with no pooled effect sizes | Read abstract; confirm the paper type supports the claim type |
| Study population mismatch | "sleep-deprived effect sizes (Kløve & Petersen 2025)" — study only examined rested subjects | Check inclusion criteria in abstract |

## Check Claims Against Sources

For each sourced claim:

1. Does the source actually support this claim?
2. Is the claim a fair representation, or distorted/oversimplified?
3. Does the claim type match the source type? (e.g., specific effect sizes require a meta-analysis, not a narrative review)
4. Does the study population match the claim population? (e.g., mouse data cited as human data)
5. Flag any claim the source doesn't support or that misrepresents the source.

## Fabrication Signals

Red flags:

- Suspiciously specific statistics with no findable source
- Author names that don't appear in search results for the claimed work
- Journal or publication names that don't exist or didn't exist at the claimed date
- URLs that 404 or lead to unrelated content
- Same PMID cited with different author names across different notes in the vault
- Statistics attributed to a qualitative review or a study that excluded the relevant population

## Mechanical API Verification

When called from note-writer or other agents that need deterministic verification against public APIs:

### Verify sources

1. Write the note content to a temp file using the Write tool: `<tmpdir>/ll-note-verify-TIMESTAMP.md` (epoch ms for TIMESTAMP, where tmpdir is the OS temp directory)
2. Run: `node PLUGIN/scripts/source-resolver.mjs verify-note <tmpdir>/ll-note-verify-TIMESTAMP.md`
3. Parse the JSON output. For each source:
   - `verified: true` -- no action needed
   - `wrong_author` -- replace with the resolver's `metadata.firstAuthor` surname + "et al."
   - `wrong_year` -- replace with the resolver's `metadata.year`
   - `author_not_first` -- replace with the correct first author
   - `error: "No identifiable source information"` -- skip (non-academic source)
   - `error: "Source not found in any database"` -- add `[unresolved]` marker inline
4. If fixes were made, rewrite the temp file using the Write tool and re-run verify-note once. Max 2 calls total.
5. If issues remain after retry, mark with `[unverified]` inline.

### Check quantitative claims

1. Run: `node PLUGIN/scripts/source-resolver.mjs check-claims <tmpdir>/ll-note-verify-TIMESTAMP.md`
2. For each claim:
   - `in_abstract: true` -- confirmed
   - `in_abstract: false` -- read the abstract independently; if the number appears nowhere, add `[not in abstract]` after the claim. Do NOT remove the claim.
3. Runs once (informational, not corrective).
4. Clean up the temp file using Bash: `node -e "try { require('fs').unlinkSync('<tmpdir>/ll-note-verify-TIMESTAMP.md') } catch(e) {}"`

## Output

Report findings. Don't rewrite. Be specific — "source doesn't support claim" is useless. Say what the source actually says.
