# Extract Insights

Classify raw data into atomic insights for the ingest pipeline.

## Input

You receive raw data from a source agent (Linear tickets, repo scan, pasted text) as structured or unstructured text.

## Process

For each distinct piece of knowledge in the input:

1. **Identify** — is this a single atomic insight? If it covers two ideas, split it.
2. **Classify** — assign exactly one type:
   - `project-state` — ephemeral working context. Ticket counts, current focus areas, team assignments, deadlines, active blockers. This updates auto-memory, not the vault.
   - `durable-insight` — decisions, patterns, architecture, constraints, trade-offs worth preserving beyond this session. This becomes a vault note.
3. **Title** — states the insight, not the topic. "Kinso attachment tickets block AI feature work" not "Kinso tickets."
4. **Body** — 1-3 sentences of context. For `project-state`, include dates and numbers. For `durable-insight`, include the reasoning or evidence.
5. **Confidence** — `high` (directly stated in source), `medium` (inferred from source), `low` (speculative connection).

## Output Format

Return a JSON array:

```json
[
  {
    "type": "project-state",
    "title": "Insight title here",
    "body": "Context sentence. Another if needed.",
    "confidence": "high",
    "source_ids": ["KIN-931", "KIN-930"]
  },
  {
    "type": "durable-insight",
    "title": "Insight title here",
    "body": "Context and reasoning.",
    "confidence": "medium",
    "source_ids": []
  }
]
```

## Rules

- One idea per insight. Split aggressively.
- `project-state` items with relative dates must be converted to absolute dates.
- Don't extract insights that are routine or obvious from the source alone (e.g., "ticket KIN-931 exists" is not an insight).
- Look for patterns across items — "4 of 7 in-progress tickets are attachment-related" is an insight. Individual ticket existence is not.
- Look for tensions — misalignment between stated priorities and actual work distribution is an insight.
