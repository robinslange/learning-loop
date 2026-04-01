---
name: dream
description: 'Consolidate auto-memory between sessions. Usage: /learning-loop:dream (no args). Four-phase cycle: Orient, Gather Signal, Consolidate, Prune Index. Seven operators: MERGE, RESOLVE, ABSTRACT, COMPRESS, PRUNE, LINK, DATE NORMALIZE. Rebuilds MEMORY.md.'
---

# Dream — Auto-Memory Consolidation

Seven operators, each defined in `operators/`. This file orchestrates the four-phase cycle. Read operator files only when executing Phase 3.

## When to Use

- Runs automatically via SessionStart hook when conditions are met (24hr + 5 sessions)
- Stop hook nudges after heavy sessions (3+ new memory files)
- Manual: `/dream` runs immediately, ignores gates

## Provenance

Emit events silently via Bash for each operator action.

```bash
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"dream","skill":"dream","action":"ACTION","target":"FILENAME"}'
```
Where ACTION is one of: `merge`, `resolve`, `abstract`, `compress`, `prune`, `link`, `normalize`.

At start: `{"action":"session-start"}`. At end: `{"action":"session-end","merged":N,"resolved":N,"abstracted":N,"compressed":N,"pruned":N,"linked":N,"normalized":N}` + run `node {{PLUGIN}}/scripts/provenance-consolidate.mjs`.

## Phase 1: Orient

1. Detect the project memory directory:
   - Use `$CLAUDE_PROJECT_DIR` if available, else derive from cwd: `$HOME/.claude/projects/$(echo "$PWD" | sed 's|/|-|g')/memory`
   - Verify the directory exists and contains MEMORY.md

2. Read all `.md` files (excluding MEMORY.md, _dream_log.md, _archived/).

3. Parse YAML frontmatter: `name`, `description`, `type`, `confidence`.

4. Build inventory: total count, count by type, sorted by modification date, line count per file.

5. Read MEMORY.md. Check links resolve to actual files. Flag orphaned pointers.

6. Check retrieval tracking data:
   ```bash
   ls ${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/learning-loop}/retrieval/access-*.jsonl 2>/dev/null | tail -3
   ```

7. Report:
   ```
   Dreaming: [project name]
   Memory files: N (N feedback, N project, N user, N reference)
   Index entries: N (N orphaned)
   Retrieval data: N sessions tracked (or "not yet available")
   ```

## Phase 2: Gather Signal

1. **Group by type, sort newest-last within each group.**
   Order: feedback, user, project, reference. Within each group, oldest first (exploits recency bias per Chattaraj & Raj 2026).

2. **Flag MERGE candidates.**
   Within each type group, flag pairs where both descriptions reference the same tool/concept, one is a subset of the other, or both contain the same rule. Skip pairs that contradict each other (those go to RESOLVE).

3. **Flag RESOLVE candidates.**
   Within each type group, flag pairs where two memories assert opposite rules or facts about the same subject.

4. **Flag ABSTRACT candidates.**
   Clusters of 4+ memories within the same type group describing variations of the same pattern. For each cluster, note: the memories, the candidate abstraction (one sentence), which would be archived (fully subsumed), which would remain (unique detail). Conservative: only flag clear patterns.

5. **Flag COMPRESS candidates.**
   Memory files exceeding 15 lines or exceeding size limits (feedback/user: 500 chars, project/reference: 1,000 chars body).

6. **Flag PRUNE candidates.**
   - Orphaned index entries
   - Outdated project memories (superseded versions, ended sprints, reversed decisions)
   - Low-retrieval memories (if tracking data exists): scan JSONL entries for sessions where a memory file appears in the `memories` array. Note: this tracks file presence in the memory directory at session start, not whether Claude actually read the file. Thresholds account for this: `weak` + absent from 10 consecutive session snapshots, `medium` + absent from 15. `strong` memories never auto-prune on retrieval alone.

7. **Flag LINK candidates.**
   Cross-type pairs sharing a keyword or concept. Descriptions only. Cap at 30 most recent files if 50+.

8. **Flag DATE NORMALIZE candidates.**
   Files containing relative temporal references ("yesterday", "last week", etc.).

9. **Present signal summary and ask for approval:**
   ```
   Dream signal:
   - DATE NORMALIZE: N candidates
   - MERGE: N candidate pairs
   - RESOLVE: N contradiction pairs
   - ABSTRACT: N clusters (N source memories)
   - COMPRESS: N candidates (N over size limit)
   - PRUNE: N candidates (N orphaned, N stale, N low-retrieval)
   - LINK: N candidate pairs
   Retrieval data: N sessions tracked

   Proceed with consolidation? [yes/no]
   Note: ABSTRACT has a separate per-cluster gate.
   ```

## Phase 3: Consolidate

Process in strict order: **DATE NORMALIZE, MERGE, RESOLVE, ABSTRACT, COMPRESS, PRUNE, LINK.**

Create lock file first: `echo $$ > /tmp/learning-loop-dream-lock`. Abort if lock exists.

For each operator, read its instruction file from `operators/` and execute:

| Operator | File | Input |
|---|---|---|
| DATE NORMALIZE | `operators/normalize.md` | Flagged files with relative dates |
| MERGE | `operators/merge.md` | Candidate pairs (excluding contradictions) |
| RESOLVE | `operators/resolve.md` | Contradiction pairs |
| ABSTRACT | `operators/abstract.md` | Flagged clusters (per-cluster user gate) |
| COMPRESS | `operators/compress.md` | Files over line/size thresholds |
| PRUNE | `operators/prune.md` | Orphaned, stale, low-retrieval candidates |
| LINK | `operators/link.md` | Cross-type pairs |

Log every operation to `_dream_log.md` (append, create if needed).

Remove lock file when done: `rm -f /tmp/learning-loop-dream-lock`

## Phase 4: Rebuild Index and Report

1. Rebuild MEMORY.md from scratch: scan all `.md` files (excluding MEMORY.md, _dream_log.md, _archived/), format as `- [filename.md](filename.md) — description`, group by topic, under 150 chars per line, drop unmodified-in-90-days if over 200 lines.

2. Write MEMORY.md (full overwrite). Write timestamp: `date +%s > /tmp/learning-loop-last-dream`.

3. Report:
   ```
   Dream complete.
   Merged: N | Resolved: N | Abstracted: N | Compressed: N | Pruned: N | Linked: N | Normalized: N
   Index: N lines (was N)
   Unresolved: N contradictions (need user input)
   ```

4. List any unresolved contradictions with the conflicting claims.

## Safety Constraints

- Never touch files outside the project memory directory
- Never touch `{{VAULT}}/` (vault has its own pipeline)
- Archive over delete (pruned files go to `_archived/`)
- Log every operation to `_dream_log.md`
- Lock file prevents concurrent dreams
- Human-in-the-loop gate before Phase 3, plus per-cluster gate for ABSTRACT
