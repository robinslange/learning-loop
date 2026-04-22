# Resource usage

This plugin is heavy. It runs local model inference and injects vault context into every session.

## Tokens

Every session gets a context injection with your memory index, recent captures, and active intentions. A fresh vault adds almost nothing. A mature vault adds thousands of tokens per session, and grows. Skills like `/discovery` and `/gaps` spawn multiple parallel agents, each with its own context window.

## Local compute

The `ll-search` binary (~77MB) bundles two quantized models (BGE-small-en-v1.5 for embeddings, ms-marco-MiniLM for reranking) and runs inference on your machine. On an M4 Max, reranked search takes ~0.6s and indexing ~1.8s. An Apple Silicon Mac with 16GB+ RAM is the practical minimum. Linux x64 and Windows x64 binaries are CI-built; see [cross-platform.md](cross-platform.md) for per-platform status.

## Librarian (optional)

If enabled via `/init` Phase 7, the vault librarian runs Gemma 4 E2B (~5GB active RAM) via ollama alongside `ll-watch`. It investigates notes at ~15s each, writing observations to a local queue. No API calls, no cloud costs. Requires ollama installed and 16GB+ system RAM.

## What we do to keep costs down

- Lightweight agents (vault search, scoring, ingestion) run on Haiku
- Recent captures capped at the last 5 notes
- Intention summaries use compact format
- Provenance, backlinks, and session labels write to disk, not into context
- Pre-compact hook captures insights before Claude compresses context
- Search batches multiple queries into a single process

## Measuring cache impact

`/learning-loop:init` Phase 6 offers to install a bundled `cache-health` oh-my-claude statusline plugin (if oh-my-claude is present). It logs per-turn cache hit rates from the statusline payload to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl`.

```bash
node scripts/cache-health-report.mjs [--session <id>] [--month YYYY-MM]
```

Weighted hit rate, percentile distribution, and zero-hit events. Useful for measuring the cost impact of flipping `injection_mode` from shadow to live.
