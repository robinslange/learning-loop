---
name: dream
description: 'Consolidate auto-memory between sessions. Usage: /learning-loop:dream (no args). Four-phase cycle: Orient, Gather Signal, Consolidate, Prune Index. Merges duplicates, prunes stale entries, compresses verbose memories, normalizes dates, rebuilds MEMORY.md.'
---

# Dream — Auto-Memory Consolidation

## Overview

Consolidates the current project's auto-memory files. Merges near-duplicates, prunes stale entries, compresses verbose memories, normalizes relative dates to absolute, and rebuilds the MEMORY.md index. The auto-memory equivalent of what `/inbox` does for the vault.

## When to Use

- Runs automatically via SessionStart hook when conditions are met (24hr + 5 sessions)
- Stop hook nudges after heavy sessions (3+ new memory files)
- Manual: `/dream` runs immediately, ignores gates

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At start:**
```bash
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"dream","skill":"dream","action":"session-start"}'
```

**Per merge/prune/compress action:**
```bash
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"dream","skill":"dream","action":"ACTION","target":"MEMORY_FILENAME"}'
```
Where ACTION is one of: `merge`, `prune`, `compress`, `normalize`.

**At session end, run provenance consolidation:**
```bash
node {{PLUGIN}}/scripts/provenance-consolidate.mjs
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"dream","skill":"dream","action":"session-end","merged":N,"pruned":N,"compressed":N}'
```

Note: Dream operates on auto-memory files, not vault notes. The PostToolUse hook does not capture these, so per-target events are retained.

## Process

### Phase 1: Orient

1. Detect the project memory directory. Use the standard Claude Code path encoding:
   - If `$CLAUDE_PROJECT_DIR` is available in the environment, use it
   - Otherwise derive from current working directory: `$HOME/.claude/projects/$(echo "$PWD" | sed 's|/|-|g')/memory`
   - Verify the directory exists and contains MEMORY.md

2. Read all `.md` files in the memory directory (excluding MEMORY.md, _dream_log.md, and anything in _archived/).

3. For each file, parse YAML frontmatter to extract: `name`, `description`, `type` (user/feedback/project/reference).

4. Build an inventory:
   - Total file count
   - Count by type
   - Files sorted by modification date
   - Line count per file

5. Read MEMORY.md. Extract all `[filename](filename)` links. Check each link resolves to an actual file. Flag orphaned pointers (link exists, file doesn't).

6. Report the orient summary:
   ```
   Dreaming: [project name]
   Memory files: N (N feedback, N project, N user, N reference)
   Index entries: N (N orphaned)
   ```

### Phase 2: Gather Signal

1. **Group by type, sort newest-last within each group.**
   Order the groups: feedback, user, project, reference. Within each group, sort by file modification date ascending (oldest first, newest last). This ordering is research-backed:
   - Primacy bias (Chattaraj & Raj 2026, d=1.73): newest-last exploits recency bias
   - Content type prior (A-MAC, Zhang et al. 2026): grouping by type improves consolidation decisions
   - Schema-consistent fast-tracking (CLS theory, Kumaran et al. 2016): grouping approximates schema-consistency

2. **Flag MERGE candidates.**
   Within each type group, compare every pair of memory descriptions. Flag pairs where:
   - Both descriptions reference the same tool, library, pattern, or concept
   - One description is a subset or restatement of the other
   - Both contain the same specific rule or preference
   When in doubt, don't merge. Conservative merging prevents information loss.

3. **Flag PRUNE candidates.**
   - Orphaned index entries (from Phase 1)
   - Project memories where the described project state is clearly outdated (references a version that has shipped, a decision that has been reversed, a sprint that has ended)
   - **Version-superseded project memories**: when `project_X_v15.md`, `project_X_v16.md`, and `project_X_v17.md` all exist, the older versions are superseded. Archive all but the latest version. Check that the latest version's "How to apply" doesn't reference the older versions as current state.
   - Files in `_archived/` older than 90 days (second-order archive cleanup)

4. **Flag COMPRESS candidates.**
   - Memory files with body content exceeding 15 lines (after frontmatter)

5. **Flag DATE NORMALIZE candidates.**
   - Memory files containing relative temporal references: "yesterday", "today", "last week", "next Monday", "Thursday", "this sprint", or similar
   - Use the file's modification date as the anchor for conversion

6. **Flag CONTRADICTION candidates.**
   - Two memories within the same type group that assert opposite rules or facts about the same subject
   - Do NOT plan to resolve these. Just flag them for the report.

7. **Present the signal summary and ask for approval before proceeding:**
   ```
   Dream signal:
   - MERGE: N candidate pairs
   - PRUNE: N candidates (N orphaned, N stale)
   - COMPRESS: N candidates
   - DATE NORMALIZE: N candidates
   - CONTRADICTIONS: N flagged (will not auto-resolve)

   Proceed with consolidation? [yes/no]
   ```

   Wait for user confirmation using AskUserQuestion. This is the human-in-the-loop gate.

### Phase 3: Consolidate

Process in strict order: DATE NORMALIZE, MERGE, COMPRESS, PRUNE.

**Safety: Create lock file first.**
```bash
echo $$ > /tmp/learning-loop-dream-lock
```
If lock file already exists, abort with message: "Another dream is in progress. Aborting."

**For each operation, log to `_dream_log.md`** in the memory directory. Append to the file (create if it doesn't exist). Format:

```markdown
## Dream — [ISO-8601 timestamp]

### DATE NORMALIZE
- `filename.md`: "last Thursday" -> "2026-03-20"

### MERGE
- `feedback_a.md` + `feedback_b.md` -> `feedback_a.md` (archived feedback_b.md)
  - Reason: both describe the same GraphQL import convention

### COMPRESS
- `project_kinso.md`: 24 lines -> 12 lines

### PRUNE
- Removed orphaned index entry: `deleted_file.md`
- Archived: `project_old_sprint.md` -> `_archived/project_old_sprint.md`
```

**DATE NORMALIZE:**
- Read each flagged file
- Use Edit tool to replace relative dates with ISO-8601 dates
- Anchor: file modification date
- Example: file modified 2026-03-25, contains "last Thursday" -> replace with "2026-03-20"

**MERGE:**
- For each candidate pair, read both files fully
- Generate a merged version that preserves ALL information from both (rules, reasons, examples)
- Keep the frontmatter of the more recently modified file
- Update the description to cover both files' scope
- Write the merged content to the newer file using Edit
- Move the older file to `_archived/` subdirectory (create if needed with mkdir -p)
- Log the merge with reason

**COMPRESS:**
- For each flagged file, read the full content
- Rewrite the body to preserve: the rule/fact, the Why line, the How to apply line
- Target: under 10 lines. Do not compress below 3 lines.
- Use Edit tool to update in place
- Log original and new line counts

**PRUNE:**
- For orphaned index entries: no file action needed (Phase 4 rebuilds index from scratch)
- For stale project memories: move to `_archived/` subdirectory
- For archived files older than 90 days: leave them (manual cleanup, not automated in v1)

**Remove lock file when done:**
```bash
rm -f /tmp/learning-loop-dream-lock
```

### Phase 4: Prune Index and Report

1. **Rebuild MEMORY.md from scratch.**
   - Scan all `.md` files in the memory directory (excluding MEMORY.md, _dream_log.md, and _archived/)
   - For each file, read its frontmatter description
   - Format as: `- [filename.md](filename.md) — one-line description`
   - Group entries semantically by topic (cluster related memories together)
   - Each line under 150 characters
   - If total exceeds 200 lines, drop entries for files not modified in the last 90 days (keep the file, just remove from index)

2. **Write MEMORY.md** using the Write tool (full overwrite).

3. **Write dream timestamp:**
   ```bash
   date +%s > /tmp/learning-loop-last-dream
   ```

4. **Report:**
   ```
   Dream complete.
   Scanned: N memory files (N feedback, N project, N user, N reference)
   Merged: N pairs
   Compressed: N files
   Pruned: N entries
   Dates normalized: N
   Index: N lines (was N)
   Flagged for review: N contradictions
   ```

5. If contradictions were flagged, list them:
   ```
   Contradictions to review:
   - feedback_x.md says "use gt submit" vs feedback_y.md says "use git push" — which is current?
   ```

## Safety Constraints

- Never touch files outside the project memory directory
- Never touch `{{VAULT}}/` (vault has its own pipeline)
- Never touch other projects' memory directories
- Archive over delete (pruned files go to `_archived/`)
- Log every operation to `_dream_log.md`
- Lock file `/tmp/learning-loop-dream-lock` prevents concurrent dreams
- Always ask for confirmation before Phase 3 (human-in-the-loop gate)
