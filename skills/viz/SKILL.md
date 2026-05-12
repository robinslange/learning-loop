---
name: viz
description: 'Regenerate the NLI viz artifacts. Usage: /learning-loop:viz [--dry-run] [--no-frontmatter] [--no-heatmap] [--no-cycles]. Writes nli-contradicts: frontmatter on source notes, _system/nli-conflicts.md (heatmap), _system/viz/cycles.canvas (cycle visualisation).'
---

# Viz: NLI artifact regeneration

## Overview

Regenerates the three NLI vault artifacts from edges.db:

1. **Frontmatter sync** — overwrites `nli-contradicts:` and `has-contradiction:` keys on each source note (p>=0.95)
2. **Heatmap** — overwrites `_system/nli-conflicts.md` with a markdown table sorted by p(contradict)
3. **Cycle canvas** — overwrites `_system/viz/cycles.canvas` with detected contradiction cycles

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

Detect first-run by reading the file (path: `${VAULT_PATH}/.obsidian/graph.json`) and checking for the substring `has-contradiction:TRUE`. Skip the snippet on subsequent invocations.
