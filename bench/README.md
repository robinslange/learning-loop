# Bench harness

Single command runs Rust (Criterion) + plugin hook benches and produces
structured JSON output for comparison against committed baselines.

## Quick start

```bash
# Quick run (1k notes, 10 plugin iterations, ~2 min)
npm run bench:quick

# Full run (10k notes, 50 plugin iterations, ~15 min without ONNX)
npm run bench

# Regenerate committed baseline
npm run bench:quick -- --save-baseline
```

## Commands

| Command | Description |
|---|---|
| `npm run bench` | Full bench run |
| `npm run bench:quick` | Quick run (1k notes, reduced iterations) |
| `npm run bench:baseline` | Full run + save to `bench/baselines/YYYY-MM-DD.json` |
| `node scripts/bench.mjs --compare bench/baselines/2026-05-11.json` | Compare against baseline |
| `node scripts/bench.mjs --rust-only` | Skip plugin bench |
| `node scripts/bench.mjs --plugin-only` | Skip Rust bench |

## With real ONNX embeddings

Set `LL_BENCH_REAL_ONNX=1` to run the ONNX-dependent variants
(`embed_throughput/real_onnx`, `index_reindex/cold_full_onnx`,
`index_reindex/warm_no_changes`). Requires the BGE-small model
to be present in the model cache.

```bash
LL_BENCH_REAL_ONNX=1 npm run bench:baseline
```

## Rust benches

Three Criterion bench files in `native/crates/ll-search/benches/`:

### query_hot_path

Hot-path query pipeline benchmark. Uses pre-computed embeddings
(no ONNX) to isolate the RRF / FTS / graph pipeline.

| Variant | Description |
|---|---|
| `cold_first_call/{n}` | Cold DB build + full RRF pipeline |
| `warm_reused_context` | Warm path, same Connection |
| `warm_with_recency_filter` | Warm path + temporal score decay |

### embed_throughput

Embedding throughput. Default variant is preprocess-only (no ONNX).

| Variant | Description |
|---|---|
| `preprocess_only` | `preprocess_note` over 100 synthetic notes |
| `real_onnx` | Full ONNX inference (requires `LL_BENCH_REAL_ONNX=1`) |

### index_reindex

Reindex pipeline throughput.

| Variant | Description |
|---|---|
| `cold_preprocess_only/{n}` | Preprocess + SQLite schema create, no embedding |
| `cold_full_onnx/{n}` | Full reindex with ONNX (requires `LL_BENCH_REAL_ONNX=1`) |
| `warm_no_changes/{n}` | Second pass, no file changes (requires `LL_BENCH_REAL_ONNX=1`) |

## Plugin hook benches

`bench/plugin-hooks.mjs` spawns each hook via `child_process.spawn` with
a sandboxed tempdir. Measures wall-clock time per hook.

Hooks benched:
- `session-start`
- `post-tool`
- `pre-write-check`
- `stop-nudge`
- `pre-compact`
- `session-label`
- `post-read-retrieval`
- `post-search-tracking`

Sandbox safety: `HOME`, `XDG_DATA_HOME`, `CLAUDE_PROJECT_DIR`, `XDG_CACHE_HOME`
all point to a fresh `mkdtemp` directory. No writes to real user data.

Direct usage:

```bash
node bench/plugin-hooks.mjs --iterations 20
node bench/plugin-hooks.mjs --hooks session-start,post-tool --iterations 10
node bench/plugin-hooks.mjs --json    # machine-readable output
```

## Fixture generator

`bench/fixtures/generate-vault.mjs` generates synthetic markdown vaults.

```bash
node bench/fixtures/generate-vault.mjs --count 100 --out bench/fixtures/.cache/vault-small --seed 20260511
node bench/fixtures/generate-vault.mjs --count 10000 --out bench/fixtures/.cache/vault-10k --seed 20260511
```

Fixtures are NOT committed. Only the generator + seed are stored.
The `.cache/` directory is gitignored.

## Baseline format

`bench/baselines/2026-05-11.json` is the committed baseline.
Schema version 1. Fields:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "ISO timestamp",
  "gitSha": "40-char SHA",
  "quick": false,
  "realOnnx": false,
  "machine": { "os", "arch", "cpu", "memGb", "rustc", "node" },
  "rust": {
    "query_hot_path": {
      "cold_first_call": { "mean_ns", "stddev_ns", "median_ns", "param" },
      "warm_reused_context": { "mean_ns", "stddev_ns", "median_ns" },
      "warm_with_recency_filter": { ... }
    },
    "embed_throughput": { ... },
    "index_reindex": { ... }
  },
  "plugin": {
    "hooks": {
      "session-start": { "samples", "mean_ms", "p50_ms", "p95_ms", "p99_ms", "min_ms", "max_ms", "stddev_ms" },
      ...
    }
  },
  "budgets": { ... },
  "notes": [ "..." ]
}
```

## Performance budgets

From `baseline-2026-05-11.md` Part 1.4:

| Path | p50 target | p95 target |
|---|---|---|
| `query_hot_path/warm_reused_context` | 20 ms | 50 ms |
| `query_hot_path/cold_first_call` | 80 ms | 150 ms |
| `session-start` hook | 200 ms | 500 ms |
| `post-tool` hook | 50 ms | 150 ms |
| `pre-write-check` hook | 30 ms | 80 ms |

Phase 0 uses a soft gate (warning only). Phase 1 flips to hard fail.

## Interpreting results

- Rust times are absolute wall-clock on the run machine; do not compare
  across machines or CI runners.
- Plugin hook times include Node.js startup (~40-50ms baseline per process).
  The meaningful signal is the delta above that baseline.
- `cold_first_call` includes DB creation time; not representative of
  production warm query latency.
- `warm_reused_context` is the production-representative variant.

## Known limitations

1. Synthetic vault does not reproduce real English prose distribution.
   BM25 scores will differ from real vaults.
2. Wikilink graph is acyclic (links only to earlier-generated notes).
   PageRank behaviour on cyclic real graphs will differ.
3. ONNX variants require model download on first run (~40MB).
4. Plugin hook times include shell startup; relative comparisons
   within a run are meaningful; absolute numbers are machine-specific.
5. `bench:quick` uses 1k notes; some cache effects invisible at this scale.

## Regenerating the baseline

After a significant optimisation (Track 1E / 1F), regenerate with real ONNX:

```bash
node bench/fixtures/generate-vault.mjs --count 10000 --out bench/fixtures/.cache/vault-10k --seed 20260511
LL_BENCH_REAL_ONNX=1 node scripts/bench.mjs --save-baseline
```

Commit `bench/baselines/{date}.json`. The old baseline stays in the repo
as a reference point.
