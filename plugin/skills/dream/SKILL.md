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
ll-run provenance-emit.js '{"agent":"dream","skill":"dream","action":"ACTION","target":"FILENAME"}'
```
Where ACTION is one of: `merge`, `resolve`, `abstract`, `compress`, `prune`, `link`, `normalize`.

At start: `{"action":"session-start"}`. At end, alongside the operator counters, include the common outcome shape: `items_in` (memory files considered), `items_out` (sum of the operator counters), `items_flagged` (0, dream has no flagging concept), `duration_ms`: `{"action":"session-end","merged":N,"resolved":N,"abstracted":N,"compressed":N,"pruned":N,"linked":N,"normalized":N,"items_in":N,"items_out":N,"items_flagged":0,"duration_ms":N}` + run `ll-run provenance-consolidate.mjs`.

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

   *Steps 3–9 below mirror the Phase 3 execution order so flagging and consolidation walk the operators in the same sequence.*

2. **Fetch the read signal.** Run `ll-run retrieval-report.mjs --memory-reads --json` (Bash, silently). The result maps each memory file to how often a session actually read it in the last 90 days. This is the difference between a memory that works and one that merely exists; the flagging steps below use it, mtimes alone cannot (a consolidation pass touches every file it rewrites).

3. **Flag DATE NORMALIZE candidates.**
   Files containing a relative reference that resolves to a single day ("yesterday", "tomorrow", "two days ago", "last Thursday"). Do not inspect or pre-filter them: the script in Phase 3 decides, and it refuses tense-words and bare week spans, so flagging those only sends it to files where nothing will happen.

4. **Flag MERGE candidates.**
   Within each type group, flag pairs where both descriptions reference the same tool/concept, one is a subset of the other, or both contain the same rule. Skip pairs that contradict each other (those go to RESOLVE). When a pair merges, the read signal picks the survivor: keep the file sessions actually read, fold the unread one into it.

5. **Flag RESOLVE candidates.**
   Within each type group, flag pairs where two memories assert opposite rules or facts about the same subject.

6. **Flag ABSTRACT candidates.**
   Clusters of 4+ memories within the same type group describing variations of the same pattern. For each cluster, note: the memories, the candidate abstraction (one sentence), which would be archived (fully subsumed), which would remain (unique detail). Conservative: only flag clear patterns.

7. **Flag COMPRESS candidates.**
   Memory files exceeding 15 lines or exceeding size limits (feedback/user: 500 chars, project/reference: 1,000 chars body). A heavily-read file that is over budget still gets compressed, carefully: its content is demonstrably load-bearing, so cut filler, never claims.

8. **Flag PRUNE candidates.**
   - Orphaned index entries
   - Outdated project memories (superseded versions, ended sprints, reversed decisions, "resolved" handoffs)
   - Never-read memories: zero reads in the 90-day window AND older than 90 days (by frontmatter date or file birth). The read signal nominates; content decides. A feedback rule can be silently load-bearing without a Read event (it may act through the index line alone), so a never-read flag is a candidate for review, not a verdict.

9. **Flag LINK candidates.**
   Cross-type pairs sharing a keyword or concept. Descriptions only. Cap at 30 most recent files if 50+.

10. **Present signal summary and ask for approval:**
   ```
   Dream signal (operators in execution order):
   - DATE NORMALIZE: N candidates
   - MERGE: N candidate pairs
   - RESOLVE: N contradiction pairs
   - ABSTRACT: N clusters (N source memories)
   - COMPRESS: N candidates (N over size limit)
   - PRUNE: N candidates (N orphaned, N stale, N never-read)
   - LINK: N candidate pairs

   Proceed with consolidation? [yes/no]
   Note: ABSTRACT has a separate per-cluster gate.
   ```

## Phase 3: Consolidate

Process in strict order: **DATE NORMALIZE, MERGE, RESOLVE, ABSTRACT, COMPRESS, PRUNE, LINK.**

Acquire the dream lock first using Bash: `ll-run marker.mjs lock-acquire dream`. Exit 0 = lock acquired, proceed. Exit 1 = another /dream is running (or one crashed less than an hour ago and its lock has not gone stale yet) — STOP, tell the user, and take no further /dream action this invocation. Exit 2 = usage/installation error — report the stderr message to the user and abort; do not treat it as 'already running' and do not proceed without a lock.

For each operator, read its instruction file from `operators/` and execute:

| Operator | File | Input |
|---|---|---|
| DATE NORMALIZE | `operators/normalize.md` | Flagged files; the script decides what converts |
| MERGE | `operators/merge.md` | Candidate pairs (excluding contradictions) |
| RESOLVE | `operators/resolve.md` | Contradiction pairs |
| ABSTRACT | `operators/abstract.md` | Flagged clusters (per-cluster user gate) |
| COMPRESS | `operators/compress.md` | Files over line/size thresholds |
| PRUNE | `operators/prune.md` | Orphaned and stale candidates |
| LINK | `operators/link.md` | Cross-type pairs |

Log every operation to `_dream_log.md` (append, create if needed).

Remove the lock when done using Bash: `ll-run marker.mjs lock-release dream`

## Phase 4: Rebuild Index and Report

1. Rebuild the index from scratch: scan all `.md` files (excluding MEMORY.md, the `_index_*.md` files, _dream_log.md, _archived/), format each as `- [filename.md](filename.md): description`, one line, under 150 chars.

   **MEMORY.md has a hard byte budget, and it is far smaller than it looks.** The index is read into context whole at session start, where `hooks/session-start/context-assembly.mjs` caps it at `HookConfig.MEMORY_INDEX_MAX_BYTES`. Read the live value instead of trusting a number written here -- this file claimed 16KB against a shipped 3072 B for several releases, a 5.3x error that silently truncated the index on every session:

   ```bash
   grep -o 'MEMORY_INDEX_MAX_BYTES: [0-9_]*' "$(ll-paths PLUGIN)/scripts/lib/hook-config.mjs"
   ```

   Over budget the reader does not discard the index: it keeps whole lines up to the cap and appends `… N more entries -- read <path>`. So the head still surfaces and the pointer names the file, but every entry past the cut stops reaching the session.

   At the shipped cap a monolithic index is the EXCEPTION, not the default -- a few dozen entries exhaust it. Assume the per-type split unless the whole index measurably fits:
   - Write the full per-type entry lists to `_index_feedback.md`, `_index_project.md`, and `_index_reference.md` (one line per memory, no frontmatter — these hold the bulk).
   - Keep MEMORY.md slim: the User-type entries inline (the small, always-relevant set), plus exactly one pointer line per split type (e.g. `- [_index_feedback.md](_index_feedback.md) — all feedback entries, grep when a task might match past feedback`), and a one-line note that the split was made to stay under budget.
   Keep a single monolithic MEMORY.md only when the whole index measurably fits under the cap -- verify with `wc -c`, never by eye or by line count. Never regenerate a monolithic index above budget.

2. Write MEMORY.md (full overwrite; write the `_index_*.md` files too when split). Write the dream timestamp using Bash: `ll-run marker.mjs stamp last-dream` (this is what the SessionStart dream gate and the Stop-hook cooldown read, and it also clears any cached session-start dream nudge — do not write the timestamp by hand; this command is the single writer).

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
