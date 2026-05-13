---
name: viz
description: 'Regenerate the NLI viz artifacts. Usage: /learning-loop:viz [--dry-run] [--no-frontmatter] [--no-heatmap] [--no-cycles]. Writes nli-contradicts: / nli-supports: frontmatter on source notes, _system/nli-conflicts.md (heatmap), _system/viz/cycles.canvas (cycle visualisation).'
---

# Viz: NLI artifact regeneration

## Overview

Regenerates the three NLI vault artifacts from edges.db. NLI edges come in two flavours: `challenges_rebuttal` (contradiction-driven) and `nli_supports` (entailment-driven). Each phase has its own filter — the differences are intentional and documented under "Phase thresholds" below.

1. **Frontmatter sync** — overwrites `nli-contradicts:`, `has-contradiction:`, `nli-supports:`, `has-entailment:` keys on each source note (only edges with `confidence_score >= 0.95`)
2. **Heatmap** — overwrites `_system/nli-conflicts.md` with a markdown table of ALL NLI edges (no confidence floor), labelled `contradicts` / `entails`. Rows below the frontmatter sync threshold are marked `(below sync threshold)`
3. **Cycle canvas** — overwrites `_system/viz/cycles.canvas` with detected contradiction cycles from ALL NLI edges + regex `challenges_*` edges (no confidence floor)

### Phase thresholds — why they differ

- **Frontmatter (`p >= 0.95`)** is what Obsidian Graph View sees. High precision is essential because every flagged note is visually marked — false positives clutter the graph
- **Heatmap (no floor)** is a triage view for inspecting marginal edges. Showing only ≥0.95 rows would hide the long tail of "almost contradictions" useful for calibrating the threshold
- **Cycles canvas (no confidence floor)** prioritises topological structure (which notes form contradiction loops) over per-edge precision. One marginal edge inside an otherwise high-confidence cycle is still worth surfacing

A user who sees an edge in the heatmap but not in their note's frontmatter is hitting the `< 0.95` threshold gap — this is by design.

## When to Use

- After substantial vault work that produced new NLI edges (commonly invoked from `/reflect` and `/ingest` automatically)
- Ad-hoc when you want to see fresh contradiction state in Graph View
- Before screenshots or social-media-worthy graph captures

## Provenance

At skill start:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"viz","skill":"viz","action":"session-start"}'
```

At skill end:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"viz","skill":"viz","action":"session-end","frontmatter_updated":N,"heatmap_rows":N,"cycles":N}'
```

Replace the three `N` literals with the integer values from the JSON captured in Step 2: `counts.frontmatterUpdated`, `counts.heatmapRows`, `counts.cyclesFound`.

## Process

### Step 1: Parse args

Recognised flags (passed through to the script unchanged):

- `--dry-run` — report what would change without writing
- `--no-frontmatter` — skip phase 1
- `--no-heatmap` — skip phase 2
- `--no-cycles` — skip phase 3

If the user passes an unknown argument, print the usage line from the description and exit.

### Step 2: Run the regen script

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/regenerate-viz.mjs" <args>
```

The script writes a JSON object to stdout. Capture it.

### Step 3: Report

Print a summary:

```
Viz regenerated:
- frontmatter: <frontmatterUpdated> notes synced, <frontmatterCleared> notes cleared
- heatmap: <heatmapRows> rows in _system/nli-conflicts.md
- cycles: <cyclesFound> contradiction cycles in _system/viz/cycles.canvas
```

If all three counts are 0:

```
No NLI edges to project. Run /reflect or write contradicting notes to accumulate edges.
```

### Step 4: First-run colorGroup snippet

If `.obsidian/graph.json` colorGroups does NOT yet contain a query for `[has-contradiction:TRUE]`, print this snippet for the user to paste:

```json
{
  "query": "[has-contradiction:TRUE]",
  "color": { "a": 1, "rgb": 16711680 }
}
```

With the instruction:

> Add this object to the `colorGroups` array in your vault's `.obsidian/graph.json` (one-time setup). Restart Obsidian Graph View. Contradiction-flagged notes render in red.

Detect first-run by reading the vault's `.obsidian/graph.json` as JSON and inspecting `colorGroups`. Resolve the vault root via Node (`node -e 'import("./scripts/lib/constants.mjs").then(m => console.log(m.VAULT_PATH))'`) — `VAULT_PATH` is a JS constant in `scripts/lib/constants.mjs`, not a shell environment variable. If any `colorGroups` entry has `query === "[has-contradiction:TRUE]"` (exact match, not substring), the user has already pasted the snippet — skip it. Otherwise print the snippet and the instruction.

If the file is missing, print the snippet (treat as first-run).

If the file exists but is malformed JSON, print BOTH the snippet AND a warning:

> WARNING: `.obsidian/graph.json` could not be parsed. Before pasting the snippet:
>
> - Run `jq . .obsidian/graph.json` to surface the parse error and locate the bad token, OR
> - Back up the file (`mv .obsidian/graph.json .obsidian/graph.json.bak`) and let Obsidian regenerate defaults on next graph-view open, then re-apply your previous colorGroups by hand.
>
> Do not paste the snippet into an unparseable file or your Graph View settings may corrupt further.

Do not write to graph.json under any circumstance.

## Daemon (UDS) — performance note

When `ll-search watch` is running, the edge-infer hook talks to its NLI server over a Unix domain socket at `<plugin-data>/nli.sock` instead of spawning a fresh subprocess every fire. Cold subprocess invocation is ~400ms (reloading the 233MB model); warm UDS round-trip is ~10ms. The hook auto-detects the socket and falls back to subprocess if absent — no user action needed. Run `ll-search watch` (or rely on `/learning-loop:init` to start it) to get the fast path.

## Tunable thresholds

Two environment variables control NLI edge writes:

- `LL_NLI_THRESHOLD` — `p(contradiction)` floor for writing a `challenges_rebuttal` advisory edge. Default `0.90`. The spike eval validated this on the 180-pair test set (86% precision, 1 FP per 100 vault writes at this threshold).
- `LL_NLI_ENTAIL_THRESHOLD` — `p(entailment)` floor for writing an `nli_supports` advisory edge. Default `0.75` (Gemini-suggested asymmetric — entailment is less risky than a wrong contradiction in graph noise terms). NOTE: this threshold is unvalidated on the current eval set; revisit calibration before promoting `nli_supports` past advisory.

Both edges land with `source_graph='nli'`, `confidence='low'`. The frontmatter sync (this skill, phase 1) only writes notes where the score additionally clears `>= 0.95`.

## Limitations

- **Manual frontmatter edits are invisible to the incremental index.** If you add `nli-contradicts:` (or any NLI key) by hand on a note that has no current NLI edge in `edges.db`, the next `/viz` run won't catch the stale key for cleanup — the bootstrap-tagged-notes index doesn't know about it. Workaround: use the rollback helper (next section) for a full vault re-scan.
- **Three different thresholds across phases** (frontmatter `>= 0.95`, heatmap all, cycles all NLI + regex `challenges_*`). Documented earlier; users will see edges in the heatmap that don't appear in their note's frontmatter. This is by design.

## Rollback

To back out all NLI viz output from the vault (e.g., to experiment with different thresholds, validate a recalibration, or simply remove the visual layer):

```bash
node scripts/clear-nli-frontmatter.mjs
```

What it does:

- Strips `nli-contradicts:`, `nli-supports:`, `has-contradiction:`, `has-entailment:` keys from every note's frontmatter.
- Renames `_system/nli-conflicts.md` → `_system/nli-conflicts.md.bak`.
- Renames `_system/viz/cycles.canvas` → `_system/viz/cycles.canvas.bak`.
- Clears the bootstrap-tagged-notes index in `edges.db` and resets the BOOTSTRAP_KEY so the next `/viz` re-scans the vault from scratch.

What it does NOT do:

- Touch `edges.db` rows themselves (NLI edges in the database survive — rollback is purely the vault-visible layer).
- Delete `.bak` files from a previous rollback (they get overwritten if you rollback again).

After rollback, the next hook write that produces NLI edges re-establishes the vault state cleanly; you don't need to re-init anything.
