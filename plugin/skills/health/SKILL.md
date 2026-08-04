---
name: health
description: 'Vault health dashboard. Usage: /learning-loop:health [--deep] [--auto] [--provenance] [--librarian]. Light mode (default) shows counts + file lists. --deep uses note-scorer for full analysis. --auto fixes safe issues without asking. --provenance shows pipeline observability; --librarian reviews queued librarian suggestions.'
---

# Health: Vault Health Dashboard

## Overview

Quick-check command that surfaces vault hygiene issues: ghost duplicates, near-duplicate pairs, orphan notes, stale inbox entries, embedding gaps, and broken wikilinks. Fast by default, deep on demand, with optional auto-fix for safe operations.

## When to Use

- `/health` or `/health --light`: quick vault status check (default)
- `/health --deep`: full diagnostic with note-scorer analysis
- `/health --auto`: auto-fix safe issues (combinable with either mode)
- After a burst of `/reflect` sessions
- Before `/inbox` to see what needs attention
- Periodic maintenance

## Argument Parsing

| Input                   | Mode       | Auto-fix |
| ----------------------- | ---------- | -------- |
| `/health`               | light      | no       |
| `/health --light`       | light      | no       |
| `/health --deep`        | deep       | no       |
| `/health --auto`        | light      | yes      |
| `/health --deep --auto` | deep       | yes      |
| `/health --provenance`  | provenance | no       |
| `/health --librarian`   | librarian  | no       |

## Process

### Step 0: Parameter Resolution

**No arguments (`/health`):**
Run light mode immediately (fast, no prompting needed: it's the default and completes in seconds). Teach the other modes through results, not upfront prompting.

**But after presenting results**, if issues were found, mention available modes:

> Found N issues. Options:
>
> - `/health --deep`: full analysis with note scoring
> - `/health --auto`: auto-fix safe issues (ghost dupes, broken links)
> - `/health --provenance`: pipeline observability (fabrication rates, agent stats)
> - `/health --deep --auto`: both

This teaches the modes through use rather than upfront prompting.

### Step 0.5: Mode Dispatch (`--provenance` / `--librarian`)

If one of these flags is present, skip all vault health checks and execute the matching mode file, then stop (do not proceed to Step 1):

- **--provenance**: read `${CLAUDE_PLUGIN_ROOT}/skills/health/modes/provenance.md` and execute it.
- **--librarian**: read `${CLAUDE_PLUGIN_ROOT}/skills/health/modes/librarian.md` and execute it.

### Step 1: Gather Vault State

Collect the raw data needed for all checks. Run these in parallel:

1. **Inbox files:** `Glob` pattern `*.md` in `{{VAULT}}/0-inbox/`
2. **Fleeting files:** `Glob` pattern `*.md` in `{{VAULT}}/1-fleeting/`
3. **Permanent files:** `Glob` pattern `*.md` in `{{VAULT}}/3-permanent/`
4. **Literature files:** `Glob` pattern `*.md` in `{{VAULT}}/2-literature/`
5. **System files:** `Glob` pattern `*.md` in `{{VAULT}}/_system/`
6. **Near-duplicate clusters:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs cluster --threshold 0.85`
7. **Indexed notes:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs list`
8. **Plugin dependencies:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-deps.mjs`
9. **Binary version:** Check `ll-search` binary via `node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/binary.mjs').then(m => console.log(m.binaryVersion()))"` -- returns version string or null

### Step 1.5: Check: Plugin Dependencies

Parse the check-deps output from Step 1. Each entry has a `required` boolean — partition into required vs optional, render separately, and use it to set urgency.

For each dependency:

- **installed:** Show name, version, status
- **missing (required):** Flag prominently with name, reason, install command — these gate functionality
- **missing (optional):** List under a quieter "Optional" heading with name, reason, install command
- **outdated (required):** Flag with installed version vs `versionConstraint`, install command
- **outdated (optional):** List under "Optional" with installed version vs `versionConstraint`, install command

This check runs in both light and deep modes -- there's no deeper analysis needed.

### Step 2: Check: Ghost Duplicates

Compare inbox filenames against filenames in `1-fleeting/` and `3-permanent/`. A ghost duplicate exists when the same filename appears in inbox AND a promoted folder.

**Light:** List each ghost duplicate with its promoted location.
**Deep:** Read both versions of each ghost duplicate. If content is identical or the inbox version is a subset, confirm as true duplicate. If content has diverged, flag as "diverged copy: review before deleting".

### Step 3: Check: Near-Duplicate Pairs

Parse the cluster output from Step 1. Filter to pairs with similarity > 0.85 that are NOT ghost duplicates (same filename in different folders: already caught in Step 2).

**Light:** List each pair with similarity score.
**Deep:** Read both notes in each pair. Compare content. Recommend which to keep (prefer the more mature version) or merge.

### Step 4: Check: Orphan Notes

For each note across all content folders (0-inbox, 1-fleeting, 3-permanent), grep for `\[\[` outgoing wikilinks. Notes with zero outgoing links are orphans. Exclude `_system/` and `2-literature/` from orphan checks (system docs and literature notes don't need outlinks).

**Light:** List orphan filenames with their folder.
**Deep:** For each orphan, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs similar "<note-path>" --top 3` to suggest link targets.

### Step 5: Check: Stale Inbox

Check all inbox notes in one pass (single process for the whole folder, never one per note):

```bash
node -e "const fs=require('fs'),p=process.argv[1],now=Date.now();for(const f of fs.readdirSync(p)){if(!f.endsWith('.md'))continue;const d=Math.floor((now-fs.statSync(p+'/'+f).mtimeMs)/86400000);if(d>14)console.log(d+'d\t'+f)}" "{{VAULT}}/0-inbox"
```

Each output line is a stale note with its age in days.

**Light:** List stale notes with age in days.
**Deep:** Launch `note-scorer` agent(s) with stale note paths. Report maturity tier and recommend action: promote (if deep/medium), `/deepen` (if shallow but promising), or delete candidate (if shallow and empty).

**Batching:** If > 10 stale notes, split into batches of ~10 and launch parallel note-scorer agents.

### Step 6: Check: Embedding Staleness

Compare the full vault file list (all .md files in content folders) against the output of `vault-search.mjs list`. Notes present in the vault but missing from the embedding index are stale.

**Light and Deep:** List missing notes. No difference between modes: there's nothing deeper to analyze.

### Step 7: Check: Broken Links

Grep all `\[\[...\]\]` wikilink references across all vault notes. For each unique link target, check if a matching .md file exists anywhere in the vault (case-insensitive filename match). Broken links are references to non-existent notes.

**Light:** List each broken link with the source note that contains it.
**Deep:** For each broken link, find the closest matching vault filename using fuzzy/substring match and suggest it as a correction.

### Step 7.5: Check: Librarian Queue

Read `PLUGIN_DATA/librarian/queue.jsonl` (where PLUGIN_DATA = `CLAUDE_PLUGIN_DATA` env; if absent, resolve via `node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs PLUGIN_DATA`; never hardcode a fallback path). Parse each line as JSON. Filter to items where `status === 'pending'`. Also read `PLUGIN_DATA/librarian/state.json` for visited count.

If the queue file doesn't exist or is empty, skip this step silently.

Group pending items by `task` field:

- `link_suggestion`: link suggestions (orphan notes that should be linked)
- `tag_suggestion`: tag suggestions (under-tagged notes with proposed vocabulary tags)
- `voice_flag`: voice flags (topic-style titles)
- `duplicate_flag`: duplicate flags (notes that make the same claim as a near-neighbour)
- `staleness_suspect`: staleness suspects (Claude investigates)

Add to the dashboard output:

```
  Librarian:       N pending observations (visited M/T notes)
    Link suggestions:     N (X high, Y review)
    Tag suggestions:      N
    Voice flags:          N
    Duplicate flags:      N
    Staleness suspects:   N (for Claude to investigate)
    Queue:                P% full (N/CAP cap)
```

Where CAP is read from config.json's `librarian.queue_cap` (default 200).

If the queue has pending items, add recommendation:

> Run `/health --librarian` to review and act on librarian suggestions.

### Step 7.6: Check: Retrieval Usage

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/retrieval-report.mjs --usage --json
```

Parse the JSON. Two candidate lists plus one coverage list:

- **`surfaced_never_used`**: notes surfaced repeatedly AND explicitly judged unused (`ignored_events >= min_ignored`) by `/reflect`. These are deepen-or-archive candidates — either the note isn't earning its retrieval rank (sharpen/`/deepen` it) or it's noise crowding out better hits (archive it).
- **`surfaced_unevaluated`**: surfaced just as often, but no `/reflect` session ever judged them. This is a telemetry gap, NOT a candidate list — report it as coverage ("N notes surfaced repeatedly have never been evaluated; run `/reflect` to close the loop") and never recommend archiving from it.
- **`never_surfaced`**: content notes (0-inbox, 1-fleeting, 2-literature, 3-permanent) never retrieved by search in the window. These are candidates for archiving, but only when injection coverage is ruled out — do NOT recommend archiving based on `never_surfaced` alone, since the injected channel under-records (bursts pruned before a ledger sync are lost). Say "never retrieved by search" not "never seen".

Honest framing — carry these caveats into the output verbatim, do not soften them:

- "Used" only counts explicit `note-usage` events from `/reflect` Step 4.7, in two kinds: `used_engaged_events` (read/edited/linked) and `used_informed_events` (the note's content reached the session's output untouched, with evidence). Report both — a used-rate resting mostly on `informed` rests on model self-report, auditable but softer than an edit.
- Absence of a verdict is not a verdict. Sessions that never ran the check contribute no events; those notes land in `surfaced_unevaluated`, not in the candidate list. Never describe them as "never used".
- If `unevidenced_informed_events` is above zero, say so: that many `informed` claims arrived with no evidence field and were discarded as unauditable — counted as neither use nor non-use.
- If `coverage_limited` is true, the logs span fewer days than the window: report "never retrieved in `coverage_days`d of logs", not "in `window_days`d".
- `never_surfaced` measures retrieval-only. Do not frame these as "never seen" or recommend archiving without asking the user to confirm the note was not recently injected.

If `coverage_days` is null (no surfacing telemetry yet), skip this step silently.

**Light:** counts + top 5 of each list.
**Deep:** full `surfaced_never_used` list with surfaced counts and explicit-ignore counts; `surfaced_unevaluated` count + top 5; `never_surfaced` count + first 20 paths.

### Step 8: Present Dashboard

Output the summary dashboard:

```
Vault Health: YYYY-MM-DD

  Binary:        ll-search vX.Y.Z (installed) | not installed
  Dependencies:  N satisfied, M missing
  Ghost dupes:     N inbox notes already promoted
  Near-dupes:      N pairs (>0.85 similarity)
  Orphans:         N notes with no outlinks
  Stale inbox:     N notes older than 14 days
  Embeddings:      N notes not indexed
  Broken links:    N dead [[wikilinks]]
  Retrieval usage: N surfaced-then-ignored, U unevaluated, M never retrieved by search in Kd of logs

  Status: [total] issues [run /health --deep for full analysis]
```

Omit the retrieval-usage line when Step 7.6 was skipped for lack of telemetry. "Surfaced-then-ignored" means `/reflect` explicitly judged the note unused; "unevaluated" means no session ever judged it — see the Step 7.6 caveats.

The "run --deep" hint only appears in light mode. In deep mode, replace with a summary of findings.

Then output per-category details:

- In light mode: filenames only, grouped by category
- In deep mode: filenames + analysis + recommendations per note

### Step 9: Offer Fixes

If `--auto` flag is set:

- **Ghost dupes:** Delete inbox copies silently using `Bash`: `rm {{VAULT}}/0-inbox/<filename>`
- **Broken links:** Strip the `[[` and `]]` brackets from broken wikilinks using `Edit` tool, leaving the display text as plain text (e.g., `[[missing-note]]` becomes `missing-note`, `[[missing|displayed]]` becomes `displayed`)
- Report what was fixed

If `--auto` flag is NOT set:

- **Ghost dupes:** Ask "Delete N ghost duplicates from inbox? (y/n)": wait for approval, then delete
- **Broken links:** Ask "Remove N broken wikilinks? (y/n)": wait for approval, then fix
- **Near-dupes, orphans, stale, embeddings:** Flag only with recommended next command (`/inbox`, `/verify`, `/deepen`, or "re-index in Obsidian")
- **Retrieval usage:** Flag only, never auto-fix. Recommend `/deepen "<note>"` for surfaced-then-ignored notes worth sharpening, and archival (move to `_archive/`, ask first) for persistently-ignored notes. Never recommend anything from `surfaced_unevaluated` — the fix there is running `/reflect`, not touching the notes. For `never_surfaced` notes, do NOT recommend archiving based on retrieval telemetry alone — the injected channel under-records, so absence from search logs does not mean absence from sessions. Ask the user whether the note feels useful before suggesting archival.

### Step 10: Summary

Output a one-line summary of actions taken:

```
Fixed: N ghost dupes removed, N broken links cleaned. Remaining: N issues: see recommendations above.
```

If nothing was fixed (no `--auto`, user declined, or nothing fixable):

```
No fixes applied. N issues found: see recommendations above.
```

## Subagent Usage

### note-scorer (deep mode only, Step 5)

Reuses the `note-scorer` agent. Only invoked for stale inbox notes in `--deep` mode.

**Launch pattern:**

Spawn `note-scorer` subagent(s) (dispatch: `skills-shared/dispatch.md`) with this prompt:

```
Score these notes for inbox staleness assessment.

notes: <file-path-1>, <file-path-2>, ...
vault_path: {{VAULT}}/
scope: stale inbox triage (health --deep)

Return per-note: dimension scores + maturity tier (shallow/medium/deep) + specific issues found.
```

**Batching:** One agent per ~10 notes. Parallel for larger sets.

**Output contract:** Each agent returns a list of objects:

```
- file: <path>
  tier: shallow | medium | deep
  issues: [<string>, ...]
  gate: N/6
  claim_specificity: 0-2
  source_grounded: 0-2
```

**Mapping gate pass count to summary labels** (for dashboard display):

- 0-2 pass = weak
- 3-4 pass = solid
- 5-6 pass = strong

## Key Principles

- **Fast by default.** Light mode should complete in seconds: no agent launches, no note reading beyond filenames.
- **Deep is thorough.** When the user asks for `--deep`, give them the full picture. Use note-scorer, read content, diff duplicates.
- **Safe fixes only.** `--auto` only touches ghost dupes (inbox copy of promoted note) and broken links (references to nothing). Never auto-merge, auto-delete non-duplicate notes, or auto-promote.
- **Route, don't replicate.** Health diagnoses: it doesn't do the work of `/verify`, `/inbox`, or `/deepen`. Recommend the right tool for each issue.
- **Respect vault boundaries.** Never modify notes outside `0-inbox/` without asking. Broken link fixes edit the source note, which may be in any folder: always ask unless `--auto`.
