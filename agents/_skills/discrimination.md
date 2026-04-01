# Discrimination — Confusable Note Detection

Shared rules for detecting and handling confusable note pairs. Used by vault-scout (automated) and /refresh (interactive).

## When Invoked

- By `discovery-vault-scout`: after retrieval, before returning results (automated mode)
- By `/refresh`: after main presentation, as optional practice (interactive mode)

## Definitions

**Confusable pair:** Two notes with cosine similarity > 0.85 that make different claims. High similarity + same conclusion = duplicate (handled by overlap-check skill). High similarity + different conclusion = confusable (handled here).

**Similarity source:** `node {{PLUGIN}}/scripts/vault-search.mjs discriminate` provides pairs with scores.

## Three Outcomes

For each confusable pair, assess and assign one outcome:

| Outcome | Criteria | Report format |
|---------|----------|---------------|
| **MERGE** | Notes make the same claim with different wording. No meaningful distinction survives close reading. | `MERGE: "note-a" into "note-b" — [reason]` |
| **SHARPEN** | Notes make different claims but titles don't make the distinction clear. A reader could confuse them from titles alone. | `SHARPEN: "note-a" vs "note-b" — [what the distinction actually is]` |
| **DISTINCT** | Notes make clearly different claims. Titles reflect the difference. But no explicit link connects them. | `DISTINCT: "note-a" vs "note-b" — [the contrast]. Add see-also link.` |

## How to Articulate Distinctions

For SHARPEN and DISTINCT outcomes, state the distinction in one sentence using this format:

> "A claims [X]. B claims [Y]. The difference is [Z]."

Read both notes fully before assessing. Do not judge from titles alone.

## Automated Mode (vault-scout)

After retrieving notes for a topic:

1. Pipe the retrieved note paths to `vault-search.mjs discriminate`
2. For each returned pair, read both notes
3. Assign an outcome (MERGE / SHARPEN / DISTINCT)
4. Append a discrimination report to the scout's output:

```
Discrimination check: N confusable pairs found
  SHARPEN: "note-a" vs "note-b" — A is about mechanism, B challenges the analogy
  MERGE: "note-c" vs "note-d" — same claim, d is a subset of c
  DISTINCT: "note-e" vs "note-f" — add [[see-also]] link
```

The calling skill decides what to do with the annotations.

## Interactive Mode (/refresh)

After the main refresh presentation, if confusable pairs were found in the topic area:

1. Offer discrimination rounds: "I found N confusable pairs. Want to test your distinctions?"
2. If user accepts, present one pair at a time (max 3 rounds)
3. Difficulty based on folder location:
   - Both notes in `3-permanent/` or `2-literature/` → **Mode A**: show titles only, ask "what's the difference?"
   - Either note in `0-inbox/` or `1-fleeting/` → **Mode B**: show both notes fully, ask "is this distinction clear?"
4. After user responds, reveal both notes (if Mode A) and state the actual distinction
5. "skip" is always available. No guilt. No scores at MVP.

## Rules

- Always read both notes fully before assessing. Title-only assessment produces false merges.
- MERGE is rare. Two notes that seem to say the same thing often have a subtle but important difference. When in doubt, SHARPEN rather than MERGE.
- Counter-argument notes are never MERGE candidates with the notes they challenge, even at high similarity. That similarity is by design.
- Cap interactive rounds at 3 per /refresh invocation.
