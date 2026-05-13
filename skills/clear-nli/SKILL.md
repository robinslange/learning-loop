---
name: clear-nli
description: 'Roll back NLI vault output: strip NLI frontmatter keys, .bak-rename _system/nli-conflicts.md + _system/viz/cycles.canvas, reset the bootstrap-tagged-notes index. Usage: /learning-loop:clear-nli. Safe (reversible via .bak files); does NOT touch edges.db rows themselves.'
---

# Clear NLI: rollback the NLI vault layer

## Overview

Backs out everything `/learning-loop:viz` writes to the vault, leaving `edges.db` rows intact so the next hook write re-derives state cleanly. Use this when:

- You changed `LL_NLI_THRESHOLD` or `LL_NLI_ENTAIL_THRESHOLD` and want to clear stale frontmatter that reflects the old thresholds
- A spike or eval has invalidated the calibration and you're recalibrating
- You added NLI keys manually and want them re-derived from edges.db
- You're experimenting with viz output and want a clean slate

## When to Use

- Before a recalibration eval: clear, re-tune, re-run viz to see the new state
- After a long period of stale frontmatter accumulation
- When `manual frontmatter edits invisible to the incremental index` (per viz/SKILL.md Limitations) becomes a problem

## Process

### Step 1: Run the rollback script

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/clear-nli-frontmatter.mjs"
```

The script writes a JSON object to stdout with the change summary. Capture it.

### Step 2: Report

Print a summary using the JSON counts:

```
NLI rollback complete:
- frontmatter: <cleared> notes had NLI keys stripped
- artifacts: <artifactsRemoved.join(", ")>
- bootstrap index: reset (next /viz re-scans the vault)
```

### Step 3: Suggest next steps

If the user is recalibrating:

> Run `/learning-loop:viz` to regenerate from current edges.db rows.

If the user backed out completely:

> The `.bak` files preserve the previous artifacts in case rollback was unintended.

## What the script does (and does not)

**Does:**

- Strips `nli-contradicts:`, `nli-supports:`, `has-contradiction:`, `has-entailment:` keys from every vault note's frontmatter
- Renames `_system/nli-conflicts.md` → `_system/nli-conflicts.md.bak` (cross-platform: unlinks existing .bak first)
- Renames `_system/viz/cycles.canvas` → `_system/viz/cycles.canvas.bak`
- Clears the `nli_frontmatter_tags` index in `edges.db`
- Resets the `viz_meta` `nli_frontmatter_index_bootstrapped_v1` flag

**Does NOT:**

- Touch NLI edge rows in `edges.db` (the underlying data survives)
- Re-derive new state — that happens on the next `/viz` or hook write
- Restart `ll-search watch` (the NLI server keeps running with the existing model)

## Safety notes

- The `.bak` rename is reversible. A user who runs this by accident can restore via `mv _system/nli-conflicts.md.bak _system/nli-conflicts.md` etc.
- Running rollback twice in a row overwrites the previous `.bak`. Only the most recent backup survives.
- The script touches files atomically per-note — a Ctrl-C mid-run leaves partial state (some notes cleared, others not). Re-run to converge.
