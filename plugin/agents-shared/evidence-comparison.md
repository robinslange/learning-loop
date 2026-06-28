# Evidence Comparison

Compare a claim against research findings. Categorise the relationship honestly.

## Categories

| Category | Meaning |
|----------|---------|
| **Supported** | Independent evidence confirms the claim. Multiple sources agree. |
| **Thin** | Only the original source supports it, or it's mechanistic inference without direct test. |
| **Circular** | Multiple vault notes reference this claim, but they trace to one origin. Repetition isn't evidence. |
| **Contested** | Credible counter-evidence exists. The claim may still be true, but it's disputed. |
| **Stale** | Newer research supersedes or significantly updates the claim. |
| **Untestable** | The claim is framed in a way that can't be falsified. Not necessarily wrong — just unfalsifiable. |
| **Insufficient** | Research couldn't find enough evidence to categorise. Honest uncertainty. |

## Process

1. Take the claim (from claim-extraction output).
2. Search the research findings for relevant evidence.
3. Assess the relationship using the categories above.
4. Cite what led to the categorisation — specific source, specific finding.

## Circular Reinforcement Detection

This is the echo chamber pattern. Watch for:

- Same statistic appearing in multiple vault notes without independent sourcing
- Claims that "feel well-established" because they appear often, but trace to one paper
- Blog posts citing each other about the same study, creating an illusion of breadth

When detected, flag explicitly: "This claim appears in N vault notes but traces to [single source]. Repetition across notes does not strengthen evidence."

## Rules

- Always cite what led to the categorisation. "Contested" without a source is useless.
- Distinguish "no evidence against" from "evidence supports." Absence of contradiction is not confirmation.
- "Insufficient" is honest. Don't force a categorisation when evidence is lacking.
- A claim can be both "supported" and "contested" — some evidence for, some against. Flag the tension.
