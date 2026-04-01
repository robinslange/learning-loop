# COMPRESS — Reduce Verbose Memories

Shrinks memories that exceed line or character thresholds.

## Execution

For each flagged file:
1. Read the full content
2. Rewrite the body to preserve: the rule/fact, the Why line, the How to apply line
3. Target: under 10 lines. Do not compress below 3 lines.
4. Use Edit tool to update in place
5. Log original and new line counts

## Log format

```markdown
### COMPRESS
- `project_kinso.md`: 24 lines / 1,840 chars -> 12 lines / 920 chars
```
