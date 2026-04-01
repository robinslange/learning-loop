# PRUNE — Remove Stale Memories

Archives memories that are outdated, orphaned, or unused.

## Execution

- Orphaned index entries: no file action needed (Phase 4 rebuilds index from scratch)
- Stale project memories: move to `_archived/`
- Low-retrieval memories: move to `_archived/` with a log note:
  "Archived: low retrieval (0 accesses in N sessions, confidence: weak/medium)"
- Archived files older than 90 days: leave them (manual cleanup, not automated)

Always archive, never delete. The `_archived/` directory is the safety net.

## Log format

```markdown
### PRUNE
- Removed orphaned index entry: `deleted_file.md`
- Archived: `project_old_sprint.md` -> `_archived/` (stale)
- Archived: `feedback_weak_pattern.md` -> `_archived/` (low retrieval, 0/10 sessions, confidence: weak)
```
