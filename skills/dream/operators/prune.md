# PRUNE — Remove Stale Memories

Archives memories that are outdated or orphaned.

## Execution

- Orphaned index entries: no file action needed (Phase 4 rebuilds index from scratch)
- Stale project memories (superseded versions, ended sprints, reversed decisions, "resolved" handoffs): move to `_archived/`
- Archived files older than 90 days: leave them (manual cleanup, not automated)

Always archive, never delete. The `_archived/` directory is the safety net.

## Log format

```markdown
### PRUNE
- Removed orphaned index entry: `deleted_file.md`
- Archived: `project_old_sprint.md` -> `_archived/` (stale)
```

Emit provenance after each operation: `PLUGIN/scripts/provenance-emit.js '{"agent":"dream","action":"prune","target":"FILENAME"}'`
