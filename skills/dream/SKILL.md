---
name: dream
description: 'Consolidate auto-memory between sessions. Usage: /learning-loop:dream (no args). Four-phase cycle: Orient, Gather Signal, Consolidate, Prune Index. Seven operators: MERGE (conflict-aware), RESOLVE, ABSTRACT, COMPRESS, PRUNE (retrieval-based decay), LINK, DATE NORMALIZE. Rebuilds MEMORY.md.'
---

# Dream — Auto-Memory Consolidation

## Overview

Consolidates the current project's auto-memory files using seven operators: conflict-aware MERGE, RESOLVE (contradiction handling), ABSTRACT (higher-order pattern synthesis), COMPRESS, confidence-aware PRUNE (with retrieval-based decay), cross-type LINK, and DATE NORMALIZE. Rebuilds the MEMORY.md index. The auto-memory equivalent of what `/inbox` does for the vault.

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
Where ACTION is one of: `merge`, `resolve`, `prune`, `compress`, `normalize`, `link`, `abstract`.

**At session end, run provenance consolidation:**
```bash
node {{PLUGIN}}/scripts/provenance-consolidate.mjs
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"dream","skill":"dream","action":"session-end","merged":N,"resolved":N,"abstracted":N,"compressed":N,"pruned":N,"linked":N}'
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

5b. Check for retrieval tracking data:
    ```bash
    ls $PLUGIN_DATA/retrieval/access-*.jsonl 2>/dev/null | tail -3
    ```
    If files exist, count total sessions tracked. Report: "Retrieval data: N sessions tracked" or "Retrieval data: not yet available"

6. Report the orient summary:
   ```
   Dreaming: [project name]
   Memory files: N (N feedback, N project, N user, N reference)
   Index entries: N (N orphaned)
   Retrieval data: N sessions tracked (or "not yet available")
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

   **For each MERGE candidate pair, classify the relationship:**
   - **Redundant**: both say the same thing differently. Action: merge, keep the clearer version.
   - **Complementary**: both are about the same subject but add different information. Action: merge, preserve all information from both.
   - **Contradictory**: they assert opposite rules or facts about the same subject. Action: flag for RESOLVE in Phase 3. Do not merge.

   Report contradiction count separately in the signal summary.

2b. **Flag LINK candidates.**
    Compare memory descriptions across type groups (not just within). Flag pairs where:
    - A feedback memory references the same tool/concept as a project memory
    - A reference memory points to something directly relevant to a project memory
    - Two memories in different type groups share a keyword or concept but aren't duplicates

    This is a lightweight scan over descriptions only, not full file content. If the memory directory has 50+ files, limit comparison to the 30 most recently modified to keep Phase 2 fast.

    Unlike MERGE, LINK never combines files. It adds `related:` frontmatter pointing memories at each other.

2c. **Flag ABSTRACT candidates.**
    Identify clusters of 4+ memories within the same type group that describe variations of the same underlying pattern. Examples:
    - 5 feedback memories about code style preferences that could be abstracted into "Robin's code style philosophy"
    - 4 project memories about different services that share the same architectural pattern
    - 3 feedback memories about LLM failure modes that describe a general principle

    For each cluster, note:
    - The memories in the cluster (by filename)
    - The candidate abstraction (one sentence describing the higher-order pattern)
    - Which specific memories would be ARCHIVED after abstraction (only those fully subsumed by the abstraction)
    - Which specific memories would REMAIN (those with unique detail not captured by the abstraction)

    Conservative threshold: only flag clusters where the abstraction clearly captures a real pattern, not a coincidental grouping. If in doubt, don't abstract.

3. **Flag PRUNE candidates.**
   - Orphaned index entries (from Phase 1)
   - Project memories where the described project state is clearly outdated (references a version that has shipped, a decision that has been reversed, a sprint that has ended)
   - **Version-superseded project memories**: when `project_X_v15.md`, `project_X_v16.md`, and `project_X_v17.md` all exist, the older versions are superseded. Archive all but the latest version. Check that the latest version's "How to apply" doesn't reference the older versions as current state.
   - Files in `_archived/` older than 90 days (second-order archive cleanup)
   - **Low-retrieval memories**: if retrieval tracking data exists at `$PLUGIN_DATA/retrieval/access-*.jsonl`, scan the last 10 sessions. Memory files that appear in zero session snapshots across those 10 sessions are low-retrieval candidates. Apply confidence-aware thresholds:
     - `confidence: weak` + zero retrievals in 10 sessions: flag for pruning
     - `confidence: medium` + zero retrievals in 15 sessions: flag for pruning
     - `confidence: strong`: never auto-prune based on retrieval alone (only prune if content is stale)
   - If no retrieval data exists yet, skip this criterion. It activates after enough sessions accumulate data.

4. **Flag COMPRESS candidates.**
   - Memory files with body content exceeding 15 lines (after frontmatter)

4b. **Flag SIZE LIMIT candidates.**
    - Feedback and user memories exceeding 500 characters (body only, after frontmatter)
    - Project and reference memories exceeding 1,000 characters (body only, after frontmatter)
    - These overlap with COMPRESS candidates but use a stricter threshold. A 14-line file at 600 chars would be caught by SIZE LIMIT but not COMPRESS (which triggers at 15 lines). Both are resolved by the same COMPRESS operation in Phase 3.

5. **Flag DATE NORMALIZE candidates.**
   - Memory files containing relative temporal references: "yesterday", "today", "last week", "next Monday", "Thursday", "this sprint", or similar
   - Use the file's modification date as the anchor for conversion

6. **Present the signal summary and ask for approval before proceeding:**
   ```
   Dream signal:
   - DATE NORMALIZE: N candidates
   - MERGE: N candidate pairs (N redundant, N complementary, N contradictory -> RESOLVE)
   - RESOLVE: N contradictions to attempt
   - ABSTRACT: N clusters (N source memories)
   - COMPRESS: N candidates (N also over size limit)
   - PRUNE: N candidates (N orphaned, N stale, N low-retrieval)
   - LINK: N candidate pairs

   Retrieval data: N sessions tracked (or "not yet available")

   Proceed with consolidation? [yes/no]
   Note: ABSTRACT has a separate per-cluster gate in Phase 3.
   ```

   Wait for user confirmation using AskUserQuestion. This is the human-in-the-loop gate.

### Phase 3: Consolidate

Process in strict order: DATE NORMALIZE, MERGE, RESOLVE, ABSTRACT, COMPRESS, PRUNE, LINK.

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
- `feedback_a.md` + `feedback_b.md` -> `feedback_a.md` [redundant] (archived feedback_b.md)
  - Reason: both describe the same GraphQL import convention

### RESOLVE
- `feedback_x.md` vs `feedback_y.md` [temporal] -> updated feedback_y.md, archived feedback_x.md
  - Conflict: "use SQLite" vs "use Postgres"
  - Resolution: migration happened 2026-03-15, kept newer

### ABSTRACT
- Cluster: feedback_a.md, feedback_b.md, feedback_c.md, feedback_d.md -> feedback_code_economy.md
  - Pattern: "Robin prefers minimal code with no speculative abstractions"
  - Archived: feedback_a.md, feedback_b.md (fully subsumed)
  - Kept: feedback_c.md, feedback_d.md (unique detail)

### COMPRESS
- `project_kinso.md`: 24 lines / 1,840 chars -> 12 lines / 920 chars

### PRUNE
- Removed orphaned index entry: `deleted_file.md`
- Archived: `project_old_sprint.md` -> `_archived/` (stale)
- Archived: `feedback_weak_pattern.md` -> `_archived/` (low retrieval, 0/10 sessions, confidence: weak)

### LINK
- `feedback_graphite_workflow.md` <-> `project_kinso.md` (shared: Graphite CLI workflow)
```

**DATE NORMALIZE:**
- Read each flagged file
- Use Edit tool to replace relative dates with ISO-8601 dates
- Anchor: file modification date
- Example: file modified 2026-03-25, contains "last Thursday" -> replace with "2026-03-20"

**MERGE:**
- For each candidate pair, read both files fully
- Check the classification from Phase 2:
  - **Redundant pairs**: generate a merged version keeping the clearer phrasing. Drop the weaker version's text entirely.
  - **Complementary pairs**: generate a merged version that preserves ALL information from both (rules, reasons, examples).
  - **Contradictory pairs**: skip. These go to RESOLVE (below).
- Keep the frontmatter of the more recently modified file
- Update the description to cover the merged scope
- Write the merged content to the newer file using Edit
- Move the older file to `_archived/` subdirectory (create if needed with mkdir -p)
- Log the merge with reason and classification

**RESOLVE:**
Processes contradictory pairs flagged by MERGE. For each pair:

1. Read both files fully. Identify the specific claim that conflicts.

2. Classify the contradiction type:
   - **Temporal**: one was true before, the other is true now (e.g., "project uses SQLite" vs "project uses Postgres" after a migration). Resolution: update the newer memory to include the transition ("migrated from SQLite to Postgres on YYYY-MM-DD"), archive the older.
   - **Preference reversal**: user changed their mind (e.g., "prefer tabs" then later "prefer spaces"). Resolution: keep only the newer preference. Archive the older with a note in _dream_log.md.
   - **Genuine conflict**: both might still be true in different contexts (e.g., "use gt submit" for Kinso vs "use git push" for personal projects). Resolution: do NOT merge. Add a `context:` line to each memory clarifying when it applies. Log the disambiguation.
   - **Unresolvable**: can't determine which is correct without user input. Resolution: flag in report, do not modify either file.

3. For temporal and preference-reversal resolutions, lower the archived memory's effective confidence by one tier in the log (this doesn't modify the file since it's being archived, but documents the reasoning).

4. Log every resolution with the contradiction type and action taken.

**ABSTRACT:**
- For each flagged cluster, present the proposed abstraction to the human-in-the-loop gate:
  ```
  ABSTRACT proposal:
  Cluster: [list of N memory filenames]
  Abstraction: "[one-sentence pattern]"
  Archive: [files fully subsumed]
  Keep: [files with unique detail]
  Proceed? [yes/no/skip]
  ```
  Wait for user confirmation per cluster. This is a separate gate from the Phase 2 approval because abstraction is lossy and irreversible.

- If approved:
  - Write a new memory file named with the pattern (e.g., `feedback_code_style_philosophy.md`)
  - Frontmatter: `type` matches the cluster's type, `confidence: strong` (validated by user), `abstracted_from:` lists the source filenames
  - Body: the abstraction as a clear rule/principle, with Why and How to apply lines
  - Body must reference the specific source memories that were synthesized ("Synthesized from N memories about X, Y, Z")
  - Archive the fully-subsumed source files to `_archived/`
  - Leave the unique-detail files in place, add `related:` pointing to the new abstraction
  - Log with full cluster membership and which files were archived vs kept

**COMPRESS:**
- For each flagged file, read the full content
- Rewrite the body to preserve: the rule/fact, the Why line, the How to apply line
- Target: under 10 lines. Do not compress below 3 lines.
- Use Edit tool to update in place
- Log original and new line counts

**PRUNE:**
- For orphaned index entries: no file action needed (Phase 4 rebuilds index from scratch)
- For stale project memories: move to `_archived/` subdirectory
- For low-retrieval prunes: move to `_archived/` with a note in _dream_log.md:
  "Archived: low retrieval (0 accesses in N sessions, confidence: weak/medium)"
- For archived files older than 90 days: leave them (manual cleanup, not automated in v1)

**LINK:**
- For each flagged pair, add a `related:` field to both files' frontmatter listing the other file:
  ```yaml
  related:
    - feedback_graphite_workflow.md
  ```
- If a `related:` field already exists, append to it (don't duplicate existing entries)
- Use Edit tool to update frontmatter in place
- Log each link with the shared concept that justified it

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
   Resolved: N contradictions (N temporal, N preference, N disambiguated)
   Abstracted: N clusters (N sources -> N abstractions)
   Compressed: N files
   Pruned: N entries
   Linked: N pairs
   Dates normalized: N
   Index: N lines (was N)
   Unresolved: N contradictions (need user input)
   ```

5. If contradictions were flagged, list them:
   ```
   Contradictions needing user input:
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
