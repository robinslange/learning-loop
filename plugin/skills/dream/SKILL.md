---
name: dream
description: 'Consolidate auto-memory between sessions. Usage: /learning-loop:dream (no args). Four-phase cycle: Orient, Gather Signal, Consolidate, Prune Index. Seven operators: MERGE, RESOLVE, ABSTRACT, COMPRESS, PRUNE, LINK, DATE NORMALIZE. Rebuilds MEMORY.md.'
---

# Dream: Auto-Memory Consolidation

Seven operators, each defined in `operators/`. This file orchestrates the four-phase cycle. Read operator files only when executing Phase 3.

## When to Use

- SessionStart hook nudges via `hooks/lib/dream-gate.js` when 24+ hours have passed since the last dream AND 5+ memory files have been modified since then. Nudge only — never auto-runs.
- Stop hook nudges after heavy sessions (3+ new memory files in current session).
- Manual: `/dream` runs immediately, ignores gates.

## Provenance

Emit events silently via Bash for each operator action.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"dream","skill":"dream","action":"ACTION","target":"FILENAME"}'
```
Where ACTION is one of: `merge`, `resolve`, `abstract`, `compress`, `prune`, `link`, `normalize`.

At start: `{"action":"session-start"}`. At end: `{"action":"session-end","merged":N,"resolved":N,"abstracted":N,"compressed":N,"pruned":N,"linked":N,"normalized":N}` + run `node ${CLAUDE_PLUGIN_ROOT}/scripts/provenance-consolidate.mjs`.

## Phase 1: Orient

1. Detect the project memory directory:
   - Use `$CLAUDE_PROJECT_DIR` if available, else use the auto-memory directory for the current project
   - Verify the directory exists and contains MEMORY.md

2. Read all `.md` files (excluding MEMORY.md, _dream_log.md, _archived/).

3. Parse YAML frontmatter: `name`, `description`, `type`, `confidence`.

4. Build inventory: total count, count by type, sorted by modification date, line count per file.

5. Read MEMORY.md. Check links resolve to actual files. Flag orphaned pointers.

6. Report:
   ```
   Dreaming: [project name]
   Memory files: N (N feedback, N project, N user, N reference)
   Index entries: N (N orphaned)
   ```

## Phase 2: Gather Signal

1. **Group by type, sort newest-last within each group.**
   Order: feedback, user, project, reference. Within each group, oldest first: transformer attention favors recent tokens, so placing the memories you want the consolidator to weight most heavily last in each group keeps them in the recency-favored position.

   *Steps 2–8 below mirror the Phase 3 execution order so flagging and consolidation walk the operators in the same sequence.*

2. **Flag DATE NORMALIZE candidates.**
   Files containing relative temporal references ("yesterday", "last week", etc.).

3. **Flag MERGE candidates.**
   Within each type group, flag pairs where both descriptions reference the same tool/concept, one is a subset of the other, or both contain the same rule. Skip pairs that contradict each other (those go to RESOLVE).

4. **Flag RESOLVE candidates.**
   Within each type group, flag pairs where two memories assert opposite rules or facts about the same subject.

5. **Flag ABSTRACT candidates.**
   Clusters of 4+ memories within the same type group describing variations of the same pattern. For each cluster, note: the memories, the candidate abstraction (one sentence), which would be archived (fully subsumed), which would remain (unique detail). Conservative: only flag clear patterns.

6. **Flag COMPRESS candidates.**
   Memory files exceeding 15 lines or exceeding size limits (feedback/user: 500 chars, project/reference: 1,000 chars body).

7. **Flag PRUNE candidates.**
   - Orphaned index entries
   - Outdated project memories (superseded versions, ended sprints, reversed decisions, "resolved" handoffs)

8. **Flag LINK candidates.**
   Cross-type pairs sharing a keyword or concept. Descriptions only. Cap at 30 most recent files if 50+.

9. **Present signal summary and ask for approval:**
   ```
   Dream signal (operators in execution order):
   - DATE NORMALIZE: N candidates
   - MERGE: N candidate pairs
   - RESOLVE: N contradiction pairs
   - ABSTRACT: N clusters (N source memories)
   - COMPRESS: N candidates (N over size limit)
   - PRUNE: N candidates (N orphaned, N stale)
   - LINK: N candidate pairs

   Proceed with consolidation? [yes/no]
   Note: ABSTRACT has a separate per-cluster gate.
   ```

## Phase 3: Consolidate

Process in strict order: **DATE NORMALIZE, MERGE, RESOLVE, ABSTRACT, COMPRESS, PRUNE, LINK.**

Acquire the dream lock first using Bash: `node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" lock-acquire dream`. Exit 0 = lock acquired, proceed. Exit 1 = another /dream is running (or one crashed less than an hour ago and its lock has not gone stale yet) — STOP, tell the user, and take no further /dream action this invocation. Exit 2 = usage/installation error — report the stderr message to the user and abort; do not treat it as 'already running' and do not proceed without a lock.

For each operator, read its instruction file from `operators/` and execute:

| Operator | File | Input |
|---|---|---|
| DATE NORMALIZE | `operators/normalize.md` | Flagged files with relative dates |
| MERGE | `operators/merge.md` | Candidate pairs (excluding contradictions) |
| RESOLVE | `operators/resolve.md` | Contradiction pairs |
| ABSTRACT | `operators/abstract.md` | Flagged clusters (per-cluster user gate) |
| COMPRESS | `operators/compress.md` | Files over line/size thresholds |
| PRUNE | `operators/prune.md` | Orphaned and stale candidates |
| LINK | `operators/link.md` | Cross-type pairs |

Log every operation to `_dream_log.md` (append, create if needed).

Remove the lock when done using Bash: `node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" lock-release dream`

## Phase 4: Rebuild Index and Report

1. Rebuild the index from scratch: scan all `.md` files (excluding MEMORY.md, the `_index_*.md` files, _dream_log.md, _archived/), format each as `- [filename.md](filename.md): description`, one line, under 150 chars.

   **MEMORY.md has a hard 16KB budget.** It is read into context whole at session start; an over-budget index is silently truncated there, and every rule past the cut stops surfacing — the failure this budget prevents. When a single monolithic MEMORY.md would exceed 16KB, do NOT emit one and do NOT rely on line-count heuristics. Use the per-type split structure instead:
   - Write the full per-type entry lists to `_index_feedback.md`, `_index_project.md`, and `_index_reference.md` (one line per memory, no frontmatter — these hold the bulk).
   - Keep MEMORY.md slim: the User-type entries inline (the small, always-relevant set), plus exactly one pointer line per split type (e.g. `- [_index_feedback.md](_index_feedback.md) — all feedback entries, grep when a task might match past feedback`), and a one-line note that the split was made to stay under budget.
   Only keep a single monolithic MEMORY.md when the whole index fits under 16KB. Never regenerate a monolithic index above budget.

2. Write MEMORY.md (full overwrite; write the `_index_*.md` files too when split). Write the dream timestamp using Bash: `node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" stamp last-dream` (this is what the SessionStart dream gate and the Stop-hook cooldown read, and it also clears any cached session-start dream nudge — do not write the timestamp by hand; this command is the single writer).

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
- Lock leaks from a /dream interrupted mid-Phase 3 are expected: the 1-hour staleness window is the recovery mechanism. No manual cleanup needed.
