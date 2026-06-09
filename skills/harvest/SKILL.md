---
name: harvest
description: "Collect opt-in-marked, IP-scrubbed insights from THIS instance to carry back to another learning-loop instance you own. Usage: /learning-loop:harvest [--all] [--out <dir>]. Keys ONLY on frontmatter `portable: true` (never `visibility`). Mechanical deny-list blocks IP; you review what survives. Emits a lift-bundle to ingest on the home instance."
---

# Harvest portable insights

Collects notes/memories marked `portable: true`, scrubs them against this instance's IP deny-list, lets you review survivors, and emits a `harvest-bundle-<date>/` to carry home and absorb with `/learning-loop:ingest`.

## Invariants (do not violate)
- **Whitelist only:** only `portable: true`. Never harvest by `visibility`, tag, or inference.
- **Mechanical gate:** the deny-list block is authoritative. You may drop MORE in review; you may never un-block or add a note the gate excluded.

## Paths
`PLUGIN`, `PLUGIN_DATA`, `VAULT` injected; else `node PLUGIN/scripts/resolve-paths.mjs`. The deny-list file and dedup log are resolved mechanically, NOT hardcoded:
- deny-list: `node -e "import('PLUGIN/scripts/lib/paths.mjs').then(m=>console.log(m.DATA_FILES.harvestDenylist(process.argv[1])))" PLUGIN_DATA`
- dedup log: same with `DATA_FILES.harvestedLog`.
The memory dir: `node -e "import('PLUGIN/scripts/lib/memory-paths.mjs').then(m=>console.log(m.resolveMemoryDir(process.env.CLAUDE_PROJECT_DIR)))"`.

## Process

### 1. Collect (mechanical whitelist)
Pass DIRECTORIES — the script walks them; do not enumerate files yourself:
```
node PLUGIN/scripts/harvest-collect.mjs "<VAULT>" "<memDir>"
```
prints the paths with `portable: true`. These are the ONLY candidates. Capture them to a temp file for the next steps.

### 2. Dedup
```
node PLUGIN/scripts/harvest-dedup.mjs "<dedupLog>" [--all] < candidates.txt
```
(CLI reads candidate paths on stdin, one per line; `--all` ignores the log.) Use the printed filtered list going forward.

### 3. Federation guard (mechanical, warn-not-block)
```
node PLUGIN/scripts/federation-active.mjs "<PLUGIN_DATA>"
```
If it prints `FEDERATED`, show this before review: "⚠ this instance is federated — confirm each note is yours to carry, not company IP." Friction, not a block.

### 4. Scrub (mechanical hard block + tripwire)
The deny terms = hand-listed file + mechanically-derived instance facts (the CLI merges them; pass PLUGIN_DATA so it can derive peer ids / pubkey / email domains):
```
node PLUGIN/scripts/harvest-scrub.mjs "<denylistFile>" "<PLUGIN_DATA>" <candidate-path...>
```
(Candidate paths here are the deduped survivors — typically a small set after collect+dedup, safe for argv.) Returns `{blocked, tripwire, clean}`. Report `blocked` to the operator (with hits) — these are excluded and CANNOT be added back. Surface `tripwire` flags for attention. Only `clean` proceeds.

### 5. Review (LLM narrows, never widens)
For each note in `clean`, read it and judge: is this genuinely generic + safe to carry, or does it leak paraphrased/conceptual IP the deny-list missed? Drop anything doubtful. Present the final keep list to the operator for confirmation.

Be especially alert to **compound forms of deny-listed names** that the mechanical gate cannot catch: the deny-list matches on word boundaries treating `-` and `_` as boundaries, so a lowercase hyphenated/underscored compound of a listed org or product (e.g. `acme-registry` when only `acme` is listed) passes the gate uncaught. Treat any compound of a denylisted term as a drop.

### 6. Emit the lift-bundle
Create `<out>/harvest-bundle-<date>/`:
- `memory/` — confirmed portable memory files.
- `notes/` — confirmed portable vault notes.
- `HARVEST-MANIFEST.md` — carried files; dropped files with reason (blocked/tripwire-dropped/review-dropped); which checks each carried file passed; source instance label.

### 7. Record dedup (do not mutate notes)
Append the carried paths to the log (resolved via `DATA_FILES.harvestedLog`). Uses `.then()` chaining (CJS-safe on every Node version, matching the Paths-section one-liners):
```
printf '%s\n' <carried-path...> | node -e "import('PLUGIN/scripts/harvest-dedup.mjs').then(m=>{const fs=require('node:fs');const paths=fs.readFileSync(0,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);m.appendHarvested(process.argv[1],paths)})" "<dedupLog>"
```
Leave the `portable: true` markers in place — the log handles dedup; markers are never stripped.

### 8. Report
Tell the operator the bundle path and counts, and remind: carry it to your home instance and run `/learning-loop:ingest` on it, then `/dream` + `/reflect` to consolidate.
