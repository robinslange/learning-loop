# Preview Format

Format extracted insights for user review before writing to memory/vault.

## Input

A JSON array of insights from `extract-insights`, plus:
- `source_type`: "linear", "repo", or "context"
- `source_label`: Human-readable source description (e.g., "Linear — my assigned tickets", "Repo — ~/dev/kinso/monorepo")

## Process

Group insights by type and format for user review.

## Output Format

Return this exact structure as markdown (the skill orchestrator will display it):

```markdown
## Ingest Preview: {source_label}

### Auto-Memory Updates ({count})

| # | Title | Confidence |
|---|-------|------------|
| 1 | {title} | {confidence} |
| 2 | {title} | {confidence} |

### Vault Notes ({count})

| # | Title | Confidence |
|---|-------|------------|
| 1 | {title} | {confidence} |
| 2 | {title} | {confidence} |

**Actions:** Type numbers to exclude (e.g., "drop vault 2, 4"), or "all" to confirm everything.
```

## Rules

- Keep titles short in the table — full body is available if user asks.
- Sort by confidence descending within each group.
- If either group is empty, show "None" instead of an empty table.
