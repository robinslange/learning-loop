# PRUNE — Remove Stale Memories

Archives memories that are outdated or orphaned.

## Execution

- Orphaned index entries: no file action needed (Phase 4 rebuilds index from scratch)
- Stale project memories (superseded versions, ended sprints, reversed decisions, "resolved" handoffs): move to `_archived/`
- Never-read memories (zero reads in the 90-day window, older than the window, flagged in Phase 2): move to `_archived/` only when the content also reads as expired. The read signal nominates; a timeless rule with no Read event stays.
- Archived files older than 90 days: leave them (manual cleanup, not automated)

Always archive, never delete. The `_archived/` directory is the safety net.

## Log format

```markdown
### PRUNE
- Removed orphaned index entry: `deleted_file.md`
- Archived: `project_old_sprint.md` -> `_archived/` (stale)
```

Emit provenance after each operation: `ll-run provenance-emit.js '{"agent":"dream","skill":"dream","action":"prune","target":"FILENAME"}'`
