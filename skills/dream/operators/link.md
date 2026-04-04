# LINK — Connect Related Memories

Adds bidirectional `related:` frontmatter between memories that reference the same concept across type groups.

## Execution

For each flagged pair:
1. Add a `related:` field to both files' frontmatter listing the other file:
   ```yaml
   related:
     - feedback_graphite_workflow.md
   ```
2. If a `related:` field already exists, append to it (don't duplicate existing entries)
3. Use Edit tool to update frontmatter in place
4. Log each link with the shared concept that justified it

LINK never combines files. It only adds cross-references.

## Log format

```markdown
### LINK
- `feedback_graphite_workflow.md` <-> `project_kinso.md` (shared: Graphite CLI workflow)
```

Emit provenance after each operation: `PLUGIN/scripts/provenance-emit.js '{"agent":"dream","action":"link","target":"FILENAME"}'`
