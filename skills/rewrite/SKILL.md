---
name: rewrite
description: 'Cross-store correction for a retracted or updated belief. Usage: /learning-loop:rewrite "old pattern" "new pattern" [reason]. Searches vault, auto-memory, and episodic history; presents an impact map for triage; executes user-approved changes; records a supersession so future episodic searches get annotated.'
---

# Rewrite — Context Gene Editing

When a belief turns out to be wrong (or refined), the wrong version sits in three places: the vault as durable notes, the auto-memory as preferences/feedback, and the episodic history as past conversations the LLM may resurface. This skill edits all three coherently.

The Katsuno-Mendelzon split:
- **Vault and auto-memory** use *revision* semantics — actively rewritten or archived. The world model changes.
- **Episodic memory** is append-only history — *update* semantics. We do not edit past conversations; we annotate them via the supersessions table so future retrievals carry the correction inline.

## When to Use

- `/learning-loop:rewrite "old pattern" "new pattern"` — full form, with reason inferred
- `/learning-loop:rewrite "old pattern" "new pattern" "reason"` — explicit reason for the supersession record
- `/learning-loop:rewrite` — no args, infer the change from recent conversation context

## Process

### Phase 1: Frame the Change

If args are provided, parse `old_pattern`, `new_pattern`, optional `reason`.

If no args, read the conversation. The user just learned something that contradicts a prior belief. Identify:
- The OLD pattern (the belief being retracted/refined)
- The NEW pattern (the replacement)
- The REASON (what evidence forced the change)

If you cannot find a clear correction in the conversation, tell the user and stop. Ask them to provide `old` and `new` explicitly.

Confirm the framing in one line before proceeding:

```
Rewriting: "<old>" → "<new>" (reason: <reason>)
```

### Phase 2: Hit Map (parallel search across all stores)

Search every store for the OLD pattern. Run all four searches in parallel (single message, multiple Bash calls):

1. **Vault — semantic + keyword:**
   ```
   node PLUGIN/scripts/vault-search.mjs search "<old pattern>" --rerank
   ```

2. **Vault — wiki-link/title hits:**
   Use `Glob` for filename matches: `**/*<key-noun>*.md` in `{{VAULT}}/`

3. **Auto-memory:**
   `Grep` the project's `~/.claude/projects/*/memory/` directory for substrings of the old pattern. Read `MEMORY.md` and any matching files.

4. **Episodic memory:**
   Call `mcp__plugin_episodic-memory_episodic-memory__search` with the old pattern. The post-search-tracking hook will already annotate the result if a supersession exists — do not pre-create one yet.

### Phase 3: Edge Impact (correction-analyser)

For every vault note hit from Phase 2, identify the *primary* note that codifies the old belief (or notes — there may be more than one). For each primary note, dispatch the `learning-loop:correction-analyser` agent:

```
subagent_type: learning-loop:correction-analyser
prompt: |
  note_path: <vault-relative path>
  change_type: <retraction|update|weakening>
  new_claim: <new pattern, if change_type is update>

  Produce the impact map per your spec.
```

The agent traces the justification index for sole-justification dependents and classifies each by attack type. Run agents in parallel if there are multiple primary notes.

### Phase 4: Present the Triage Map

Show the user a single consolidated triage map:

```
# Rewrite Plan: <old> → <new>

## Vault notes (N hits)
- `path/to/primary.md` — primary belief codification
  - Suggested: REWRITE (replace old claim with new)
  - Downstream impact: 3 critical, 1 high, 0 medium (from correction-analyser)
- `path/to/related.md` — references the old belief
  - Suggested: AMEND (update the wiki-link surrounding text)

## Auto-memory (N hits)
- `feedback_<name>.md` — captures the old guidance
  - Suggested: REWRITE

## Episodic memory (N matches)
- N past conversations contain the pattern
- Suggested: SUPERSESSION RECORD (no edits — annotation only)

## Downstream cascade (from correction-analyser)
- `path/dependent-a.md` — CRITICAL (sole-dependent rebuttal)
- `path/dependent-b.md` — HIGH (sole-dependent undercutting)
- ...

Total proposed actions: <N>
```

Then ask the user, exactly once, in plain English:

> Approve the plan? You can say `yes`, `no`, or list specific items to skip (e.g. "skip auto-memory, skip dependent-b").

Wait for confirmation. Do not proceed until the user has answered. If they say no, stop and report nothing changed.

### Phase 5: Execute (only after approval)

Run the approved actions. Use the right tool per store.

**Vault rewrites/amends:**
- Use `Edit` for surgical changes (preferred — preserves frontmatter, links)
- **Always `Read` the file immediately before each `Edit`**, even if you read it during Phase 2. The triage map can grow stale between rendering and execution if other tools touched the file in the meantime. The fresh read also lets you verify the surrounding text still matches what you'll pass to `Edit`.
- For an ARCHIVE action, move the note to `_archive/` (create the dir if missing) and leave a stub at the original path with a single line: `Superseded — see [[<replacement>]]`. **Caveat**: archiving currently orphans the note's outgoing edges in the index because the stub Write triggers `removeOutgoingEdges`. Until edge preservation for archived notes lands, prefer REWRITE over ARCHIVE when the downstream graph is non-trivial.

**Vault transition note (mandatory if any vault notes were touched):**
Write a new note to `0-inbox/` capturing the correction itself:
- Title: `<new pattern phrased as a claim>`
- Body: explains what the old belief was, what the new one is, what evidence forced the change, and which notes were affected
- Tag with `[rewrite-transition]`
- Wiki-link to all affected primary notes

**Auto-memory rewrites:**
- Use `Edit` on the relevant `feedback_*.md` or `project_*.md` file
- Keep the same filename to preserve the index pointer
- Update `MEMORY.md` only if the description line changed

**Supersession record (mandatory):**
Always write the supersession, regardless of which other actions ran:

```bash
node PLUGIN/scripts/edges-cli.mjs super-add "<old pattern>" \
  --replacement "<vault path of transition note or primary rewritten note>" \
  --reason "<reason>"
```

This is what makes future episodic searches surface the correction inline.

### Phase 6: Report

Show one final block:

```
# Rewrite Complete

- Vault: <N rewrites>, <N amends>, <N archives>
- Auto-memory: <N rewrites>
- Transition note: <path>
- Supersession recorded: id <N>, pattern "<old>"

Future episodic searches matching "<old>" will be annotated automatically.
```

## Constraints

- **Never edit episodic memory directly.** Episodic is append-only history. The supersession record is the only correction mechanism.
- **Always ask before executing.** This skill is destructive; the triage step is non-negotiable.
- **One supersession per rewrite.** Even if no notes were edited, record the supersession so future retrievals carry the annotation.
- **Transition note is mandatory if vault was touched.** This is the "context gene editing" footprint — future you needs to find why a note changed.
- **Do not delete edges from the SQLite index for archived notes.** The edges still describe the historical justification graph; future queries on `downstream` should still surface the archived note as part of the chain.
- **Be terse in reporting.** One framing line, one triage map, one approval prompt, one completion block. No filler.

## Failure Modes to Avoid

- **Mass edits without triage** — always show the user the plan first
- **Skipping the supersession record** — if you skip it, future episodic searches will still surface the wrong belief unannotated
- **Editing past conversations** — episodic is read-only; the post-search hook does the annotation work
- **Touching unrelated notes** — only edit notes that the hit map identified, never explore-and-edit
- **Auto-archive without confirmation** — archive is destructive even though reversible; confirm explicitly

## Related Skills

- `/learning-loop:deepen` — strengthens a single note in place (no cross-store coordination)
- `/learning-loop:reflect` — end-of-session consolidation (different intent: capture, not retract)
- `learning-loop:correction-analyser` (agent, not skill) — the edge-traversal subroutine this skill calls
