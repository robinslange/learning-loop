# NLI Edges Mode (`--nli-edges`)

Executed by /health --nli-edges; see SKILL.md.

If `--nli-edges` flag is present, skip all vault health checks and run NLI tuning mode only:

The DB is `PLUGIN_DATA/edges.db` (see `DATA_FILES.edgesDb` in `scripts/lib/paths.mjs`); sql.js-backed, no daemon — run the SQL via `sqlite3 "$PLUGIN_DATA/edges.db"` or node dynamic-import of `${CLAUDE_PLUGIN_ROOT}/scripts/lib/edges.mjs`.

**1. Aggregate stats**

Query `edges.db`:

```sql
SELECT * FROM edges WHERE source_graph='nli' ORDER BY created_at DESC
```

Report:

- Total NLI edges (all time)
- Total NLI edges (last 7 days)
- Per-day average over last 7 days
- Breakdown by `edge_type`: two are written today — `challenges_rebuttal` (driven by `p(contradiction) > LL_NLI_THRESHOLD`, default 0.90) and `nli_supports` (driven by `p(entailment) > LL_NLI_ENTAIL_THRESHOLD`, default 0.75). Report counts of each separately.
- Count of `from_path` values that also have a regex-classified `challenges_*` edge to the same `to_path` (overlap: where regex and NLI contradiction agreed)
- Below floor: rows where `confidence_score < LL_NLI_THRESHOLD` for `challenges_rebuttal`, or `confidence_score < LL_NLI_ENTAIL_THRESHOLD` for `nli_supports` (surfaces when thresholds were tuned down between writes — these exist in the table but may be excluded from the histogram below depending on the threshold)

```sql
SELECT COUNT(*) FROM edges WHERE source_graph='nli' AND confidence_score IS NOT NULL AND confidence_score < 0.90
```

Show inline as `Below floor: N rows`.

**2. Random sample (10 edges from last 7 days)**

```sql
SELECT from_path, to_path, edge_type, confidence_score, created_at
FROM edges
WHERE source_graph='nli' AND created_at >= date('now', '-7 days')
ORDER BY RANDOM() LIMIT 10
```

Render as a table:

- from (note slug)
- to (note slug)
- p(contradict) (confidence_score, to 3 decimal places)
- created_at

**3. Threshold line**

```
Current LL_NLI_THRESHOLD (contradiction): <process.env.LL_NLI_THRESHOLD || '0.90 (default)'>
Current LL_NLI_ENTAIL_THRESHOLD (entailment): <process.env.LL_NLI_ENTAIL_THRESHOLD || '0.75 (default)'>
Spec sync threshold (frontmatter): 0.95
```

**3a. Schema-mismatch / daemon-error count (last 7 days)**

The hook logs structured errors when the NLI binary returns an unexpected envelope shape or the UDS daemon misbehaves. A non-zero count means edge writes are silently being dropped — check the binary version vs the hook's expected schema_version.

Grep recent hook logs for these tags:

- `edge-infer.runNliBatch.schemaMismatch.daemon`
- `edge-infer.runNliBatch.schemaMismatch.subprocess`
- `edge-infer.runNliBatch.daemon.timeout`
- `edge-infer.runNliBatch.daemon.idle-timeout`
- `edge-infer.runNliBatch.daemon.parse-error`
- `edge-infer.runNliBatch.subprocess`

Report inline as `NLI errors (7d): N (most recent: <tag> at <timestamp>)`.
If the count is zero, render `NLI errors (7d): 0 (healthy)`.

**4. Confidence-score histogram (10 bins from 0.90 to 1.00):**

Query:

```sql
SELECT
  CAST(((confidence_score - 0.90) * 100) AS INTEGER) AS bin,
  COUNT(*) AS n
FROM edges
WHERE source_graph = 'nli' AND confidence_score IS NOT NULL AND confidence_score >= 0.90
GROUP BY bin
ORDER BY bin;
```

The `confidence_score >= 0.90` predicate ensures bin math stays in the rendered 0-9 range. If you tune `LL_NLI_THRESHOLD` below 0.90, rows between the tuned threshold and 0.90 are excluded from this histogram (they still exist in the table). Use a separate query to inspect those.

Render as a horizontal text histogram (one row per bin, block characters scaled to the max count):

```
0.90-0.91  ████████ 24
0.91-0.92  ████ 13
0.92-0.93  ███ 9
0.93-0.94  ██ 7
0.94-0.95  ██ 5
0.95-0.96  ████ 12
0.96-0.97  ███ 8
0.97-0.98  ██ 6
0.98-0.99  ███ 9
0.99-1.00  ██ 7
```

Useful for tuning `LL_NLI_THRESHOLD` and the sync threshold (0.95) per spec. Bins above 0.95 propagate to note frontmatter; bins below stay in the db only.

Then stop (do not proceed to Step 1).
