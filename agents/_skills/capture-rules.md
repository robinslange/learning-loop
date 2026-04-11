# Capture Rules

## Voice

Hemingway + Musashi + Lao Tzu. Three masters, one voice.

1. Short sentences. Active voice. Present tense.
2. No filler. No weasel-hedging. (Accuracy-hedging that bounds scope is fine -- e.g., "in most implementations" when evidence is partial.) No "it should be noted that."
3. Every word earns its place or gets cut.
4. Observations stated plainly. Connections drawn with links.
5. Uncertainty gets one line, not three hedging paragraphs.

## Note Format

- **Title**: States the insight, not the topic. "Spaced repetition works because forgetting is active" not "Spaced Repetition."
- **Body**: 3-10 lines (up to 15 for deep notes with sources). Notes under 5 lines should be substantive enough to stand alone. One idea per note.
- **Tags**: Max 3. Pick the most specific ones.
- **Links**: At least one wiki-link to a related note. More if genuine.
- **Frontmatter**: Include `tags`, `date` (YYYY-MM-DD), and `source` (the URL or citation).

## Frontmatter Template

```yaml
---
tags: [tag1, tag2]
date: YYYY-MM-DD
source: "[Author, \"Title\" (Year)](URL)"
claim_specificity: 0-2
source_grounded: 0-2
---
```

For multiple sources, use a YAML list:

```yaml
source:
  - "[Author1, \"Title1\"](URL1)"
  - "[Author2, \"Title2\"](URL2)"
```

For synthesis notes, use `source: synthesis`. For unverifiable citations, use `source: unverified`.

`claim_specificity` and `source_grounded` are set by the promote-gate scoring pass. Values: 0 (vague/none), 1 (bounded/vault-linked), 2 (falsifiable/externally-cited). Omit both fields if the note has not been scored yet.

## Reserved Fields

Two fields have strict semantics — do not overload them:

- **`source:`** — URL or citation only. The single source of truth for provenance. Readers, retrieval, and federation all index this field. Never duplicate it as a `**Source:**` line in the body.
- **`status:`** — intention tracking only. Legal values: `intentioned | resolved | limbo`. Managed by inbox-organiser. Never write `status: inbox`, `status: permanent`, or `status: fleeting` — the folder location IS the maturity status. A note in `3-permanent/` is permanent by virtue of being there.

## Tag Hygiene

When writing or rewriting frontmatter tags, de-duplicate the list before writing. If the counter-argument-linking skill adds topic tags from the target note, merge them with existing tags and remove duplicates. Final tag list must contain no repeated entries.

## Sources

Include source URLs at write-time, not as a deferred step. Every non-synthesis note that cites a source should set the `source:` frontmatter field with a clickable markdown link:

```yaml
source: "[Author, \"Title\" (Year)](URL)"
```

The `source:` field lives in frontmatter only. Do NOT write a `**Source:**` or `Source:` line in the body — the frontmatter field is what retrieval, verification, and federation read. A body-level Source line is invisible to tooling.

If no URL exists, write `source: "[no URL found]"` rather than omitting the field. This surfaces gaps at write-time where they can be fixed, instead of at verification-time where the browsing context is gone.

## What to Capture

- Decisions made — what was chosen, what was rejected
- Problems solved — the problem, the fix, why it worked
- Patterns discovered or reused across projects
- Connections between projects — shared patterns, shared problems

## What Not to Capture

- Dead ends that taught nothing
- Routine code changes
- Anything explicitly discarded
- Unvalidated opinions
- Duplicate knowledge — link or update, don't repeat

## Splitting

If a note covers two ideas, split it. Return two separate notes and flag the split.

## Verification Markers

These inline markers are set by the note-writer's API verification step. All agents should understand them:

- `[unresolved]` -- source could not be found in PubMed, Semantic Scholar, or CrossRef. The citation may still be correct (non-academic source, preprint, or unusual identifier). `/deepen` should attempt to resolve it.
- `[unverified]` -- source was found but author/year mismatch could not be auto-corrected after 2 attempts. Manual review needed.
- `[not in abstract]` -- a specific number in the note does not appear in the source's abstract. The number may be in the full text. `/verify` should check the full text when possible.

These markers are informational, not errors. They signal where human or deeper automated review should focus.
