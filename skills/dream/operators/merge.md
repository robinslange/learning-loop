# MERGE — Combine Related Memories

Combines memory pairs flagged in Phase 2 that describe the same thing.

## Execution

For each candidate pair:
1. Read both files fully
2. Generate a merged version that preserves all meaningful information. Use judgment: if one file says it better, keep that phrasing. If both add unique detail, keep both.
3. Keep the frontmatter of the more recently modified file
4. Update the description to cover the merged scope
5. Write the merged content to the newer file using Edit
6. Move the older file to `_archived/` (create with `mkdir -p` if needed)
7. Log the merge with reason

## What MERGE does NOT do

- Does not handle contradictions. If two memories assert opposite things about the same subject, skip the pair. Those are flagged separately for RESOLVE.
- Does not combine across type groups. Only pairs within the same type (feedback+feedback, project+project).

## Log format

```markdown
### MERGE
- `feedback_a.md` + `feedback_b.md` -> `feedback_a.md` (archived feedback_b.md)
  - Reason: both describe the same GraphQL import convention
```

Emit provenance after each operation: `{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"dream","action":"merge","target":"FILENAME"}'`
