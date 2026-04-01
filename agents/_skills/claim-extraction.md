# Claim Extraction

Pull testable claims from note content. Skip metadata, links, tags — focus on assertions.

## Process

1. Read the note body.
2. Identify every factual claim — statements that could be true or false.
3. Classify each claim.
4. Skip: opinions stated as opinions, framing, metadata, link text.

## Claim Types

| Type | Description | Example |
|------|-------------|---------|
| **Empirical** | Based on observation or measurement | "Theanine bioavailability is 65-75%" |
| **Mechanistic** | Inferred from how something works | "LAT1 saturation limits brain uptake" |
| **Causal** | Claims X causes Y | "Exercise diverts kynurenine to muscle" |
| **Comparative** | Claims X > Y or X differs from Y | "Grid trading fails at micro capital" |
| **Absence** | Claims something doesn't exist or hasn't been done | "No app bridges cognitive testing and supplement tracking" |

## Output Per Claim

- **Statement**: The claim in the note's words
- **Type**: From the table above
- **Source cited**: Yes (with URL) / Yes (no URL) / No
- **Testable**: Can this be verified against external evidence?

## When a Note Has No Claims

Some notes are purely observational or reflective. If a note contains no testable claims, return:

```
No testable claims found. Note is [observational/reflective/procedural].
```

This is not a quality issue — not every note needs claims.
