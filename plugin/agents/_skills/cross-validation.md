# Cross-Validation

After gathering findings, compare them against what the vault already holds. Flag conflicts, redundancy, circular reinforcement, and genuine extensions.

## When to Use

- After web research returns findings (discovery-researcher, note-deepener)
- After extracting claims from a source (literature-capturer)
- After gathering PK values or domain data (compound research, etc.)
- Before writing or rewriting any note

## Process

1. **Gather vault context.** Pull related notes from overlap-check results or vault search. Read their claims.
2. **Compare each new finding** against existing vault claims.
3. **Classify** the relationship.
4. **Flag** conflicts and circular reinforcement explicitly.
5. **Return** classified findings with vault cross-references.

## Classification

For each new finding, assign one:

| Classification | Meaning | Action |
|---|---|---|
| **Novel** | No existing coverage | Include in output, mark as new knowledge |
| **Extension** | Adds to or refines an existing note's claim | Include — cite the existing note it extends |
| **Redundant** | Restates what's already captured | Exclude from output — note which vault entry covers it |
| **Conflict** | Contradicts an existing note | Include both sides — cite both sources, frame as tension |
| **Circular** | Same claim appears in multiple notes tracing to one source | Flag — repetition is not evidence |

## Conflict Handling

When a new finding conflicts with an existing vault claim:

- State both positions with their sources
- Frame as tension, not verdict: "Note X claims A (source). New finding claims B (source). These are in tension."
- Do not resolve. Surface for the human.
- If the conflict is between a primary source and a secondary one, note the source quality difference.

## Circular Reinforcement Detection

The most dangerous pattern. Check for:

- Multiple vault notes making the same claim
- All tracing back to the same original source (or no source at all)
- New research that merely repeats the same source

If found: "N notes claim X. All trace to [single source]. This is reinforcement, not independent confirmation."

## Outlier Detection

When new findings have characteristics wildly different from related entries:

- A half-life 10x longer than every similar compound
- A claim that contradicts the entire existing cluster
- A statistic far outside the expected range

Don't discard — verify. Outliers are either errors or important discoveries. Search for corroboration before including.

## Output

```
Cross-validation: [topic]

Novel (N):
- [finding] — no existing coverage

Extensions (N):
- [finding] — extends [[existing-note]]

Conflicts (N):
- [finding] vs [[existing-note]] — [tension description]

Circular reinforcement (N):
- [claim] — appears in [[note-1]], [[note-2]], all from [single source]

Redundant (N):
- [finding] — already in [[existing-note]]
```

## Rules

- Every conflict needs both sources cited. No orphan tensions.
- Circular reinforcement is always worth flagging, even if the claim seems true.
- Redundancy is useful information — it confirms the vault is already covering the topic.
- Outliers get verified, not discarded.
- Never resolve conflicts. Surface them.
