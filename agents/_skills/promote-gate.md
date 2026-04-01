# Promote Gate

Quality gate that routes notes to the correct vault folder at write time. Any agent creating or triaging notes reads this skill to determine destination and whether a rewrite is needed.

## When to Use

- **Note-writer:** After generating a note, before writing to disk. Override the requested destination if quality warrants it.
- **Inbox triage:** During batch processing, to quickly assess notes without a full note-scorer pass.
- **Reflect/deepen:** When capturing learnings that may already be deep enough to skip inbox.
- **Batch scoring (via note-scorer agent):** When reporting quality across many notes — verify, health, or any command that needs numeric breakdowns.

## Pre-Gate: Source Routing Fork

Before running the criteria assessment, classify the note by source status:

| Source status | Route |
|---------------|-------|
| Has external source citation (URL, DOI, PMID) | Standard gate below |
| No source, but note is synthesis/author inference (cross-note connection, personal pattern recognition, design decision) | Tag `[synthesis]` in frontmatter, exempt from Sourcing criterion |
| No source, but note makes a factual claim that should be verifiable | Block: do not score. Return `→ source-attach workflow` and stop |

Detection heuristic for synthesis vs factual:
- **Synthesis signals:** "connects to," "pattern across," "the reason we chose," wikilinks as primary evidence, no specific numbers or named studies
- **Factual signals:** specific percentages, named mechanisms, study references without URLs, "research shows," effect sizes

When in doubt, treat as factual (safer to require a source than to let an unsourced factual claim through).

## Assessment

Evaluate the note against six criteria. Each is pass/fail — no scoring needed.

| Criterion | Pass | Fail |
|-----------|------|------|
| **Depth** | 5+ lines of substantive body (not padding) | < 5 lines or vague generalities |
| **Sourcing** | Claims attributed with clickable URLs. Exempted for `[synthesis]`-tagged notes. | Bare author+year or no sources |
| **Linking** | At least one genuine `[[wikilink]]` to a related note | No links or forced/irrelevant links |
| **Voice** | Active voice, present tense, no filler, insight-as-title | Topic-as-title, passive voice, hedging |
| **Atomicity** | One idea per note | Covers 2+ distinct ideas |
| **Source Integrity** | All sources verified via source-resolver; no `[needs verification]` or `[citation needed]` tags remaining; no animal-only evidence presented as human. Exempted for `[synthesis]`-tagged notes. | Contains unverified sources, `[needs verification]` tags, or unqualified species claims |

## Routing

| Passes | Destination | Rewrite? |
|--------|-------------|----------|
| All 6 | `3-permanent/` | No — write as-is |
| 5 of 6 (voice fails) | `3-permanent/` | Yes — rewrite in persona voice |
| 5 of 6 (source integrity fails) | `1-fleeting/` | No — **cannot promote with unverified sources** |
| 4-5 of 6 | `1-fleeting/` | No |
| ≤ 3 of 6 | `0-inbox/` | No |

**Hard block:** Source Integrity failure always blocks promotion to `3-permanent/`, regardless of other criteria. A beautifully written, well-linked, deep note with a fabricated citation is worse than a shallow inbox note — it looks authoritative while being wrong.

## Scoring Mode

When an agent needs numeric quality scores (for reporting, not routing), assess two orthogonal dimensions per claim in the note:

### Dimension 1: Claim Specificity

| Score | Meaning | Examples |
|-------|---------|---------|
| **0 — Vague** | No falsifiable assertion | "Sleep is important for cognition" |
| **1 — Bounded** | Directional claim with some constraint | "Chronic sleep restriction below 6h degrades working memory" |
| **2 — Falsifiable** | Precise enough to be wrong — named mechanism, number, or bounded condition | "Each hour below 6h adds ~0.5 SD to PVT lapses (Van Dongen 2003)" |

### Dimension 2: Source Groundedness

| Score | Meaning |
|-------|---------|
| **0 — None** | No source, no vault link to a grounded note |
| **1 — Vault-linked** | Supported by wikilink to another vault note that itself has sources |
| **2 — Externally cited** | Attributed to a verified external source (URL, DOI, PMID) |

### Note-Level Score

For each claim, compute `(specificity + groundedness) / 4`. Note-level score = mean across claims. Range: 0.0-1.0.

### Maturity Tiers (derived from note-level score)

| Tier | Score range |
|------|------------|
| **Shallow** | < 0.4 |
| **Medium** | 0.4 - 0.7 |
| **Deep** | > 0.7 |

### Frontmatter Output

When scoring, write the per-note dimension scores to frontmatter:

```yaml
claim_specificity: 2
source_grounded: 2
```

Use the highest applicable score across claims for each dimension. These fields are advisory metadata for batch analysis — the pass/fail routing table above remains the authority for folder decisions.

## Override Rules

- If the caller specifies `2-literature/`, do not override. Literature notes have different criteria.
- If the caller specifies `3-permanent/` and the note only passes 2 criteria, demote to `0-inbox/` with a warning. Don't let bad notes into permanent.
- If the caller specifies `0-inbox/` and the note passes all 6, promote to `3-permanent/`. Don't bury ready notes.

## Skip-Rewrite Detection

A note does **not** need rewriting if:
1. It passes voice (active, present tense, no filler, insight-as-title)
2. Frontmatter has tags and date
3. Sources have clickable URLs
4. Links use correct kebab-case `[[note-name]]` format

When skip-rewrite is true, the triage/promotion step can simply `mv` the file instead of spawning a note-writer agent. This is the primary throughput improvement for batch processing.

## Source Integrity Check (before promotion to 3-permanent/)

Before any note reaches `3-permanent/`, run:

```bash
node {{PLUGIN}}/scripts/source-resolver.mjs verify-note <note-path>
```

This mechanically checks:
- Every PMID/PMC/DOI resolves to the claimed author and year
- No `[needs verification]` or `[citation needed]` tags remain in the note
- No cross-vault conflicts in the citation index (same PMID cited with different authors in another note)
- No animal-only evidence presented without species qualification

If `verify-note` returns any `high` severity issues, Source Integrity **fails**. The note stays in `1-fleeting/` until the issues are resolved (typically via `/deepen`).

If `verify-note` returns only `low` or `medium` issues (e.g., year off by one, author is co-author not first author), Source Integrity **passes with warnings** — the note can promote but the warnings should be included in the promotion report.

## Integration

Agents using this skill should:
1. Generate or read the note content
2. Run the 6-criterion assessment
3. If all other criteria pass and destination would be `3-permanent/`, run `source-resolver.mjs verify-note`
4. Determine final destination from the routing table
5. Check skip-rewrite conditions
6. Write to the determined destination (or `mv` if skip-rewrite)

Report the routing decision in output: `→ 3-permanent/ (all criteria met, no rewrite needed)` or `→ 0-inbox/ (missing: sourcing, depth)`
