---
name: health
description: 'Vault health dashboard. Usage: /learning-loop:health [--deep] [--auto]. Light mode (default) shows counts + file lists. --deep uses note-scorer for full analysis. --auto fixes safe issues without asking.'
---

# Health — Vault Health Dashboard

## Overview

Quick-check command that surfaces vault hygiene issues: ghost duplicates, near-duplicate pairs, orphan notes, stale inbox entries, embedding gaps, and broken wikilinks. Fast by default, deep on demand, with optional auto-fix for safe operations.

## When to Use

- `/health` or `/health --light` — quick vault status check (default)
- `/health --deep` — full diagnostic with note-scorer analysis
- `/health --auto` — auto-fix safe issues (combinable with either mode)
- After a burst of `/reflect` sessions
- Before `/inbox` to see what needs attention
- Periodic maintenance

## Argument Parsing

| Input | Mode | Auto-fix |
|-------|------|----------|
| `/health` | light | no |
| `/health --light` | light | no |
| `/health --deep` | deep | no |
| `/health --auto` | light | yes |
| `/health --deep --auto` | deep | yes |
| `/health --provenance` | provenance | no |

## Process

### Step 0: Parameter Resolution

Use `AskUserQuestion` when no arguments are provided to help users discover modes.

**No arguments (`/health`):**
Run light mode immediately (fast, no prompting needed — it's the default and completes in seconds).

**But after presenting results**, if issues were found, mention available modes:

> Found N issues. Options:
> - `/health --deep` — full analysis with note scoring
> - `/health --auto` — auto-fix safe issues (ghost dupes, broken links)
> - `/health --provenance` — pipeline observability (fabrication rates, agent stats)
> - `/health --deep --auto` — both

This teaches the modes through use rather than upfront prompting.

### Step 0.5: Provenance Mode

If `--provenance` flag is present, skip all vault health checks and run:

```bash
node PLUGIN/scripts/provenance-report.mjs
```

Display the output directly.

If the report includes a **Recommendations** section, present each recommendation and ask:

> Which of these would you like to act on? Options:
> - "N" to act on recommendation N
> - "pattern N" to create a learned pattern from recommendation N
> - "all" to review all recommendations
> - "done" to finish

When user selects "pattern N", draft a positive behavior-based pattern following the format in `PLUGIN_DATA/provenance/learned-patterns.md` (where PLUGIN_DATA = `CLAUDE_PLUGIN_DATA` env or `~/.claude/plugins/data/learning-loop`) and present for approval before writing.

After the local report, check for peer provenance data:

1. Read `PLUGIN_DATA/federation/provenance-peers.json` (where PLUGIN_DATA = `CLAUDE_PLUGIN_DATA` env or `~/.claude/plugins/data/learning-loop`)
2. If exists and has peer entries, display a **Network** section:

```
Network (last 7 days):
  peer-a:   12 sessions, 47 notes, 3 fixes
  peer-b:   5 sessions, 12 notes, 1 fix
```

3. If no peer data exists, show: "No peer provenance data. Run `vault-search.mjs sync` to fetch."

Then stop (do not proceed to Step 1).

### Step 1: Gather Vault State

Collect the raw data needed for all checks. Run these in parallel:

1. **Inbox files:** `Glob` pattern `*.md` in `{{VAULT}}/0-inbox/`
2. **Fleeting files:** `Glob` pattern `*.md` in `{{VAULT}}/1-fleeting/`
3. **Permanent files:** `Glob` pattern `*.md` in `{{VAULT}}/3-permanent/`
4. **Literature files:** `Glob` pattern `*.md` in `{{VAULT}}/2-literature/`
5. **System files:** `Glob` pattern `*.md` in `{{VAULT}}/_system/`
6. **Near-duplicate clusters:** `node PLUGIN/scripts/vault-search.mjs cluster --threshold 0.85`
7. **Indexed notes:** `node PLUGIN/scripts/vault-search.mjs list`
8. **Plugin dependencies:** `node PLUGIN/scripts/check-deps.mjs`
9. **Binary version:** Check `ll-search` binary via `node -e "import { binaryVersion } from 'PLUGIN/scripts/lib/binary.mjs'; console.log(binaryVersion());"` -- returns version string or null

### Step 1.5: Check — Plugin Dependencies

Parse the check-deps output from Step 1.

For each dependency:
- **installed:** Show name, version, status
- **missing:** Show name, reason, install command
- **outdated:** Show name, installed version vs required, install command

This check runs in both light and deep modes -- there's no deeper analysis needed.

### Step 2: Check — Ghost Duplicates

Compare inbox filenames against filenames in `1-fleeting/` and `3-permanent/`. A ghost duplicate exists when the same filename appears in inbox AND a promoted folder.

**Light:** List each ghost duplicate with its promoted location.
**Deep:** Read both versions of each ghost duplicate. If content is identical or the inbox version is a subset, confirm as true duplicate. If content has diverged, flag as "diverged copy — review before deleting".

### Step 3: Check — Near-Duplicate Pairs

Parse the cluster output from Step 1. Filter to pairs with similarity > 0.85 that are NOT ghost duplicates (same filename in different folders — already caught in Step 2).

**Light:** List each pair with similarity score.
**Deep:** Read both notes in each pair. Compare content. Recommend which to keep (prefer the more mature version) or merge.

### Step 4: Check — Orphan Notes

For each note across all content folders (0-inbox, 1-fleeting, 3-permanent), grep for `\[\[` outgoing wikilinks. Notes with zero outgoing links are orphans. Exclude `_system/` and `2-literature/` from orphan checks (system docs and literature notes don't need outlinks).

**Light:** List orphan filenames with their folder.
**Deep:** For each orphan, run `node PLUGIN/scripts/vault-search.mjs similar "<note-path>" --top 3` to suggest link targets.

### Step 5: Check — Stale Inbox

For each inbox note, check file modification time using Bash: `node -e "console.log(require('fs').statSync('FILE').mtimeMs)"`. Flag notes older than 14 days.

**Light:** List stale notes with age in days.
**Deep:** Launch `note-scorer` agent(s) with stale note paths. Report maturity tier and recommend action: promote (if deep/medium), `/deepen` (if shallow but promising), or delete candidate (if shallow and empty).

**Batching:** If > 10 stale notes, split into batches of ~10 and launch parallel note-scorer agents.

### Step 6: Check — Embedding Staleness

Compare the full vault file list (all .md files in content folders) against the output of `vault-search.mjs list`. Notes present in the vault but missing from the embedding index are stale.

**Light and Deep:** List missing notes. No difference between modes — there's nothing deeper to analyze.

### Step 7: Check — Broken Links

Grep all `\[\[...\]\]` wikilink references across all vault notes. For each unique link target, check if a matching .md file exists anywhere in the vault (case-insensitive filename match). Broken links are references to non-existent notes.

**Light:** List each broken link with the source note that contains it.
**Deep:** For each broken link, find the closest matching vault filename using fuzzy/substring match and suggest it as a correction.

### Step 8: Present Dashboard

Output the summary dashboard:

```
Vault Health — YYYY-MM-DD

  Binary:        ll-search vX.Y.Z (installed) | not installed
  Dependencies:  N satisfied, M missing
  Ghost dupes:     N inbox notes already promoted
  Near-dupes:      N pairs (>0.85 similarity)
  Orphans:         N notes with no outlinks
  Stale inbox:     N notes older than 14 days
  Embeddings:      N notes not indexed
  Broken links:    N dead [[wikilinks]]

  Status: [total] issues [— run /health --deep for full analysis]
```

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
- **Ghost dupes:** Ask "Delete N ghost duplicates from inbox? (y/n)" — wait for approval, then delete
- **Broken links:** Ask "Remove N broken wikilinks? (y/n)" — wait for approval, then fix
- **Near-dupes, orphans, stale, embeddings:** Flag only with recommended next command (`/inbox`, `/verify`, `/deepen`, or "re-index in Obsidian")

### Step 10: Summary

Output a one-line summary of actions taken:

```
Fixed: N ghost dupes removed, N broken links cleaned. Remaining: N issues — see recommendations above.
```

If nothing was fixed (no `--auto`, user declined, or nothing fixable):

```
No fixes applied. N issues found — see recommendations above.
```

## Subagent Usage

### note-scorer (deep mode only, Step 5)

Reuses the `note-scorer` agent. Only invoked for stale inbox notes in `--deep` mode.

**Launch pattern:**
```
SendMessage to note-scorer:
  "Score these notes: <file-path-1>, <file-path-2>, ...
   Return per-note: dimension scores + maturity tier (shallow/medium/deep) + specific issues found."
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

- **Fast by default.** Light mode should complete in seconds — no agent launches, no note reading beyond filenames.
- **Deep is thorough.** When the user asks for `--deep`, give them the full picture. Use note-scorer, read content, diff duplicates.
- **Safe fixes only.** `--auto` only touches ghost dupes (inbox copy of promoted note) and broken links (references to nothing). Never auto-merge, auto-delete non-duplicate notes, or auto-promote.
- **Route, don't replicate.** Health diagnoses — it doesn't do the work of `/verify`, `/inbox`, or `/deepen`. Recommend the right tool for each issue.
- **Respect vault boundaries.** Never modify notes outside `0-inbox/` without asking. Broken link fixes edit the source note, which may be in any folder — always ask unless `--auto`.
