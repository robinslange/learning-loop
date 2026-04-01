# DATE NORMALIZE — Fix Relative Dates

Converts relative temporal references to absolute ISO-8601 dates.

## Execution

For each flagged file:
1. Read the file
2. Use Edit tool to replace relative dates with ISO-8601 dates
3. Anchor: file modification date
4. Example: file modified 2026-03-25, contains "last Thursday" -> replace with "2026-03-20"

## Log format

```markdown
### DATE NORMALIZE
- `filename.md`: "last Thursday" -> "2026-03-20"
```
