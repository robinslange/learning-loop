---
name: verify
description: 'Assess note quality and verify claims against cited sources. Usage: /learning-loop:verify "note-name" | inbox | permanent | "topic" (defaults to inbox). Scores quality, checks source integrity, detects duplicates: produces fix plan.'
---

# Verify: Note Quality and Source Integrity

## Overview

Assesses vault notes on two dimensions: structural quality (depth, sourcing, linking, voice, atomicity) and source truthfulness (are URLs real, do claims match citations). Produces a combined report and fix plan that feeds into `/deepen`.

## When to Use

- `/verify "note-name"`: single note
- `/verify inbox`: everything in `0-inbox/`
- `/verify fleeting`: everything in `1-fleeting/` (the gate-demoted notes — catches stuck verification markers and `source: unverified` notes that have no other resurfacing path)
- `/verify permanent`: everything in `3-permanent/`
- `/verify "topic"`: all notes matching a topic
- `/verify`: defaults to `0-inbox/`
- After a burst of captures to check what landed well
- Before promoting notes from inbox to permanent
- When deciding where to invest `/deepen` effort
- When you suspect fabricated or stale references

## Provenance

This skill emits provenance events for pipeline observability.

**At session start (after scope identified):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"verify","skill":"verify","action":"session-start","intent":"SCOPE","config":{"note_count":N}}'
```

**After scoring and verification, emit each finding via provenance-emit.js:**

For each note with issues, run the stdin form (`-` + quoted heredoc) — `finding_detail` carries free text, and prose quotes/backticks/`$` must not break shell quoting (escape only JSON's own `"` and `\`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" - <<'JSON'
{"agent":"verify","skill":"verify","action":"score","target":"note-filename.md","result":"fail","finding_type":"overclaim","finding_detail":"single RCT stated as consensus","trigger":"verify-manual","confidence":"clear","ambiguous_alt":""}
JSON
```

Where:
- **finding_type** is one of: `url-fabrication`, `author-swap`, `number-reassignment`, `overclaim`, `source-missing`, `stale`, `logical-gap`, `conflation`. See `agents/_skills/capture-rules.md → Finding-Type Discriminator` for the source-missing vs logical-gap boundary rule.
- **trigger** is one of: `verify-auto` (URL/source check), `verify-manual` (human review), `cross-note` (pattern across notes), `retrieval` (found during search), `stale-scan` (date check)
- **confidence** is `clear` (obvious classification) or `ambiguous` (could be another type)
- **ambiguous_alt** is the alternative type considered when confidence is `ambiguous`, empty string when `clear`

For quality scores, emit one event per note:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"verify","skill":"verify","action":"score","target":"note-filename.md","tier":"deep","gate":"6/6","claim_specificity":2,"source_grounded":2}'
```

A note with no finding events is a pass.

**Then emit session-end:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"verify","skill":"verify","action":"session-end","notes_checked":N,"notes_flagged":N,"findings_total":N,"fixes_applied":N}'
```

A note with zero score records is a pass.

## Process

### Step 0: Parameter Resolution

**No argument (`/verify`):**
Run the `inbox` scope immediately (the default — no prompting needed). After presenting results, mention the other scopes in one line:

> Verified inbox. Other scopes: `/verify "note-name"`, `/verify permanent`, `/verify "topic"`.

**Argument provided:**
Proceed immediately.

### Step 1: Identify Scope

| Input | Scope |
|-------|-------|
| `/verify "note-name"` | Single note |
| `/verify inbox` | Everything in `0-inbox/` |
| `/verify fleeting` | Everything in `1-fleeting/` |
| `/verify permanent` | Everything in `3-permanent/` |
| `/verify "topic"` | All notes matching the topic across the vault |
| `/verify` | Default to `0-inbox/` |

### Step 2: Gather Notes

- For single note: `Glob` for `**/<note-name>*.md` in `{{VAULT}}/`, Read it
- For folder-based: `Glob` for `*.md` in the target folder (`inbox` → `0-inbox/`, `fleeting` → `1-fleeting/`, `permanent` → `3-permanent/`)
- For topic-based: `Grep` with `path: "{{VAULT}}/"` and `pattern: "<topic>"` + `Glob` for filenames + `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs search "<topic>" --rerank` for semantic matches. Deduplicate results.

Read each note.

### Step 3: Quality Scoring (Parallel Subagents)

Spawn `note-scorer` agent(s) to assess the gathered notes. When spawning multiple agents, dispatch them all in the same turn (a single message with multiple Agent tool calls):

- **< 10 notes:** Single `note-scorer` agent with all file paths.
- **10-99 notes:** Split into batches of ~10. Spawn one `note-scorer` agent per batch in the same turn.
- **>= 100 notes (sweep):** Split into batches of ~50. Spawn one `note-scorer` agent per batch in the same turn. Haiku handles 50 notes per batch; the bottleneck is Read calls, not reasoning.

Each agent reads its own notes, applies promote-gate assessment (6-criterion pass/fail + scoring mode dimensions), and returns per-note gate results (N/6 pass count, claim_specificity 0-2, source_grounded 0-2) with a maturity tier (shallow/medium/deep).

Wait for all scoring agents to complete before proceeding.

### Step 3.5: Emit Scores to Provenance

After all scorer agents return, parse their results and emit one provenance event per note via `provenance-emit.js`. Run all emit calls in a single Bash command (chained with `&&`) to avoid excessive tool calls:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"verify","skill":"verify","action":"score","target":"note-1.md","tier":"deep","gate":"6/6","claim_specificity":2,"source_grounded":2}' && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"verify","skill":"verify","action":"score","target":"note-2.md","tier":"shallow","gate":"2/6","claim_specificity":0,"source_grounded":0}'
```

This closes the subagent provenance gap -- scorer agents return text results, the main thread emits them to the provenance system.

### Step 4: Consistency Detection

Embeddings find topical similarity and surface both near-duplicates and potential contradictions.

For each note, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs similar "<note-path>" --top 5`. Read the top similar notes (score > 0.7). Flag two types:
- **Near-duplicates** (similarity > 0.85): notes covering the same insight with different wording. Recommend merge candidate (flag for user).
- **Potential contradiction** (similarity 0.7–0.85, conflicting claims): notes that look related but opposed. Recommend review.

Also check `edges.db` (see `scripts/lib/edges.mjs`) for `challenges_*` typed edges written by the regex classifier — these are authoritative contradiction signals where they exist.

### Step 4.5: Synthesis-Tag Audit (permanent + fleeting scopes)

For the `permanent` and `fleeting` scopes (and `"topic"` scopes that surface synthesis-tagged notes), audit every `source: synthesis` / `synthesis`-tagged note against the factual-signals heuristic before trusting its exemption. The exemption is self-certified by the writing agent and is never otherwise re-checked, so a smuggled factual claim can sit in `3-permanent/` unaudited.

**Skip-if-fresh:** Before running the audit on a note, read its `synthesis_validated` frontmatter field. If the field is present and the note's file `mtime` is not newer than that date, the verdict is fresh — skip the audit for that note and count it as passing (the body is unchanged since the last judgment). This prevents `/verify` and the inbox organiser from diverging on notes that neither of them has changed.

Run the canonical procedure from `${CLAUDE_PLUGIN_ROOT}/agents/_skills/promote-gate.md` → "Synthesis-tag re-validation" for notes that are not skipped: scan each synthesis note's body (outside fenced blocks) for bare factual signals (a number with a unit/comparator, a named study or author+year, an effect size, a "research shows" attribution) that are **not** backed by a grounding `[[wikilink]]`. After the audit, apply the verdict stamp per the canonical procedure (stamp `synthesis_validated: <today>` on pass; remove the field on demote).

For each note where the audit fires, flag it in the report as `synthesis exemption misapplied` — high priority, same tier as a fabricated source, because the note bypassed Sourcing and Source Integrity it should have faced:

```
### Synthesis Audit
| Note | Factual signal found | Recommendation |
|------|----------------------|----------------|
| [[some-pattern-note]] | "improves recall by 23%" (no grounding link) | demote: add source or move to 1-fleeting/ |
```

A synthesis note that cites numbers only via wikilinks to grounded vault notes passes the audit (legitimate `source_grounded=1`). Notes with no factual signals pass silently.

### Step 5: Source Verification (Parallel Subagents)

Filter notes to those with sources/citations. Skip sourceless notes (report as "no sources: skipped").

Spawn `note-verifier` agent(s). When spawning multiple, dispatch them all in the same turn:

- **< 5 notes with sources:** Single agent with all note contents
- **>= 5 notes with sources:** Split into batches of ~5. Spawn one agent per batch in the same turn. (Verification involves URL fetching which is slow.)

Each agent receives the note content and returns the structured verification report (source checks, claim checks, missing citations, corrections).

### Step 6: Present Report

Merge outputs from all agents into a single report:

```
## Verify: [scope]

### Summary
- N notes assessed
- Quality: Deep N | Medium N | Shallow N
- Sources: Pass N | Issues N | Skipped (no sources) N

### Quality Scores
| Note | Tier | Gate | Specificity | Grounded | Issues |
|------|------|------|-------------|----------|--------|
| [[note]] | shallow | 2/6 (missing: sourcing, voice, source integrity, depth) | 0 | 0 | no sources, topic-as-title |

### Consistency
- [[note-A]] ↔ [[note-B]] (challenges_* counter-argument edge, cosine 0.84): conflict, run /rewrite or mark as deliberate
- [[note-C]] ↔ [[note-D]] (cosine 0.91): near-duplicate, merge candidate
- [[note-E]] ↔ [[note-F]] (cosine 0.78): potential contradiction: [specific conflict]

### Source Issues
#### [[note-name]]: N issues
| Type | Detail | Severity |
|------|--------|----------|
| Dead URL | [url] returns 404 | high |
| Unsupported claim | "[claim]": source actually says [what] | high |
| Missing citation | "[claim]" has no source | medium |

### Clean
- [[note-name]]: all sources verified
```

Notes with `wrong_author` or fabricated sources should be flagged in the top section regardless of quality score: a well-written note with fabricated sources is worse than a thin note with real ones.

### Step 7: Fix Plan

Prioritize notes by combined quality + source issues:

1. High priority: fabricated references, dead URLs, unsupported claims, confirmed contradictions (challenges_* counter-argument edge or strong embedding signal)
2. Medium priority: shallow notes with potential, missing citations
3. Low priority: minor voice issues, weak links

```
## Fix Plan (prioritized)
1. [[note-name]]: fabricated source + shallow → `/deepen "note-name"`
2. [[note-name]]: 2 dead URLs → `/deepen "note-name"`
3. [[note-name]]: shallow, no links → `/deepen "note-name"`
```

For each note needing work, suggest the right tool:

| Issue | Recommendation |
|-------|---------------|
| Thin, needs research | `/deepen "note-name"` |
| Missing sources | `/literature` to capture, then link |
| Covers multiple ideas | Split (manual or via `/deepen`) |
| Wrong folder for maturity | Promote or demote |
| Duplicate of another note | Merge candidate: flag for user |

### Step 7.5: Detect Promotion Clusters

Group scored notes by filename prefix to find coherent knowledge clusters ready for batch promotion.

**Detection method:**
1. Extract prefix from each filename: the portion before the first hyphen that follows a recognizable word (e.g., `zustand-*`, `gemini-*`, `cbc-*`, `apollo-*`, `concept-creep-*`)
2. Group notes by prefix. Keep only clusters with 3+ notes.
3. For each cluster, compute: total notes, count at deep tier, percentage deep.
4. Surface clusters where >80% of notes score deep.

**Present as:**
```
### Promotion Clusters Detected
| Cluster | Notes | Deep | % | Action |
|---------|-------|------|---|--------|
| zustand | 12 | 12 | 100% | promote all? |
| gemini | 6 | 6 | 100% | promote all? |
| cbc | 4 | 3 | 75% | review 1 outlier |
```

On approval, `mv` all qualifying files from the main thread (not subagents) so the PostToolUse hook captures the promotions. Log a batch provenance event:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"verify","skill":"verify","action":"batch-promote","cluster":"CLUSTER_NAME","count":N,"from":"1-fleeting","to":"3-permanent"}'
```

Clusters below the 80% threshold are reported but not offered for batch promotion. Individual deep notes within those clusters can still be promoted in the normal batch actions step.

### Step 8: Offer Batch Actions

```
Quick actions available:
- Promote N deep notes to 3-permanent/ (say "promote all")
- Fix N notes with source issues (say "fix all" or pick specific notes)
- Review N consistency issues (contradictions/duplicates)
- Flag N shallow notes for /deepen queue
```

Execute promotions freely. Merges and deletions require user approval.

If user approves fixing:
- Run `/deepen` sequentially on each flagged note
- Pass the verification report as context so deepen knows what to focus on

## Subagent Usage

### note-scorer

Scores a batch of vault notes using promote-gate scoring mode.

**Launch pattern:**
```
Agent (subagent_type: "learning-loop:note-scorer"):
  "Score these notes: <file-path-1>, <file-path-2>, ...
   Return per-note: dimension scores + maturity tier (shallow/medium/deep) + specific issues found."
```

**Batching rules:**
- One agent handles up to ~10 notes.
- For larger sets, split evenly and launch multiple agents in parallel.

### note-verifier

Verifies source URLs, checks claims against cited sources, catches fabrication.

**Launch pattern:**
```
Agent (subagent_type: "learning-loop:note-verifier"):
  "Verify these notes:
   Note 1: <path>
   <content>

   Note 2: <path>
   <content>

   Return per-note: source checks, claim checks, missing citations, corrections."
```

**Batching rules:**
- One agent handles up to ~5 notes (URL fetching is slow)
- For larger sets, split evenly and launch multiple agents in parallel

## Verification Markers

Notes may carry inline markers from write-time verification (e.g. `[unresolved]`, `[not in source]`, `[partial]`). The canonical marker vocabulary — which markers exist, which block promotion, and how each resolves — lives in `agents/_skills/capture-rules.md` → Verification Markers. Read that section; do not rely on a local list (local copies drift).

When reporting, include counts for every marker in that vocabulary in the summary. Markers indicate the write-time check already ran: focus verification effort on resolving the markers rather than re-checking what already passed.

## Key Principles

- **Verify, don't rewrite.** Report issues. Fixing is `/deepen`'s job.
- **Read every note.** No scoring from titles alone.
- **Skip sourceless notes for verification.** Notes with no citations have nothing to verify: still score their quality.
- **URL checks are mandatory.** Every URL gets fetched. Dead links are high severity.
- **Be specific.** "Source doesn't support claim" is useless. Say what the source actually says.
- **Shallow is not bad.** A shallow note is a seed. Verify identifies where to invest, not what to discard.
- **Promotions are free.** If a note meets the bar for permanent, move it without asking.
- **Merges and deletes need approval.** Always ask before combining or removing notes.
