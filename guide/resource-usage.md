# Resource usage

This plugin is heavy. It runs local model inference and injects vault context into every session.

## Tokens

Every session gets a context injection with your memory index, recent captures, and active intentions. A fresh vault adds almost nothing. A mature vault adds thousands of tokens per session, and grows. Skills like `/discovery` and `/gaps` spawn multiple parallel agents, each with its own context window.

## Local compute

The `ll-search` binary (~60MB) bundles two quantized models (BGE-small-en-v1.5 for embeddings, ms-marco-MiniLM for reranking) and runs inference on your machine. On an M4 Max, reranked search takes ~0.6s and indexing ~1.8s. An Apple Silicon Mac with 8GB+ RAM is sufficient. Linux x64 and Windows x64 binaries are CI-built; see [cross-platform.md](cross-platform.md) for per-platform status.

## Librarian (optional)

If enabled via `/init` Phase 7, the vault librarian runs a local Ollama model as a child of `ll-watch`. It investigates notes at ~15s each, writing observations to a local queue. No API calls, no cloud costs. Requires ollama installed.

The model is chosen by **RAM tier** so one resident model serves everything:

- **≥32GB RAM → `gemma3:12b`** (~8.9GB resident): triage **and** local web research for `/learning-loop:research`.
- **16–32GB RAM → `gemma4:e2b`** (~7.2GB resident): triage only; `/research` falls back to its Claude-native path.
- **<16GB RAM →** librarian skipped.

`/init` detects your RAM and recommends the tier; you can override it. The shipped `config.json` default is `gemma4:e2b` (the conservative tier), which `/init` upgrades to `gemma3:12b` on a 32GB+ machine.

## What we do to keep costs down

- Lightweight agents (vault search, scoring, ingestion) run on Haiku
- Recent captures capped at the last 5 notes
- Intention summaries use compact format
- Provenance, backlinks, and session labels write to disk, not into context
- Search batches multiple queries into a single process

## Measuring cache impact

`/learning-loop:init` Phase 6 offers to install a bundled `cache-health` oh-my-claude statusline plugin (if oh-my-claude is present). It logs per-turn cache hit rates from the statusline payload to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl`.

```bash
node scripts/cache-health-report.mjs [--session <id>] [--month YYYY-MM]
```

Weighted hit rate, percentile distribution, and zero-hit events. Useful for measuring the cost impact of live `injection_mode` (or of a shadow calibration run).
