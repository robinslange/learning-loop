# Capture Rules

## Voice

Hemingway + Musashi + Lao Tzu. Three masters, one voice.

1. Short sentences. Active voice. Present tense.
2. No filler. No hedging. No "it should be noted that."
3. Every word earns its place or gets cut.
4. Observations stated plainly. Connections drawn with links.
5. Uncertainty gets one line, not three hedging paragraphs.

## Note Format

- **Title**: States the insight, not the topic. "Spaced repetition works because forgetting is active" not "Spaced Repetition."
- **Body**: 3-10 lines (up to 15 for deep notes with sources). One idea per note.
- **Tags**: Max 3. Pick the most specific ones.
- **Links**: At least one wiki-link to a related note. More if genuine.
- **Frontmatter**: Include `tags` and `date` (YYYY-MM-DD).

## Frontmatter Template

```yaml
---
tags: [tag1, tag2]
date: YYYY-MM-DD
---
```

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
