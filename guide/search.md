# Search

Four-signal hybrid search fused via Reciprocal Rank Fusion. All search, embedding, graph traversal, and reranking runs in the `ll-search` Rust binary with zero native Node.js dependencies.

## Signals

Every query runs four retrieval signals in parallel:

1. **BM25** -- full-text keyword matching via FTS5 (title 10x, tags 5x, body 1x weighting)
2. **Vector similarity** -- cosine similarity against BGE-small-en-v1.5 embeddings (384-dim, int8 quantized)
3. **Personalized PageRank** -- walks the wikilink graph from the top BM25+vector results, surfacing bridge notes that connect domains (damping=0.5, 20 iterations)
4. **Tag expansion** -- finds notes sharing rare tags (frequency 2-20) with the top results, IDF-weighted to favor specific tags over broad ones

The top 30 candidates from each signal enter the RRF merge. Graph signals (PPR + tags) improve cross-domain recall: they surface notes that no single keyword or embedding would find, but that your wikilinks connect.

## Reranking

The `--rerank` flag runs a cross-encoder (ms-marco-MiniLM-L-6-v2, quantized int8) over the top 20 hybrid candidates and reorders by semantic relevance. Adds ~300ms but significantly improves precision for ambiguous queries. Search-critical agents (vault-scout, note-verifier, counter-argument linker) use reranking by default.

## Commands

```bash
# Hybrid semantic + keyword search
node scripts/vault-search.mjs query "caffeine tolerance" [--top N] [--rerank] [--candidates N]

# Hybrid search (broader default: top 20)
node scripts/vault-search.mjs search "caffeine tolerance" [--top N] [--rerank] [--candidates N]

# Find similar notes
node scripts/vault-search.mjs similar "path/to/note.md" [--top N]

# Cluster by similarity
node scripts/vault-search.mjs cluster [--threshold 0.7]

# Rebuild index
node scripts/vault-search.mjs index [--force] [--watch] [--sync]

# Index health check
node scripts/vault-search.mjs status

# List indexed notes
node scripts/vault-search.mjs list [--top N]

# Find confusable note pairs
node scripts/vault-search.mjs discriminate [--threshold T] [paths...]

# Batch search+rerank+discriminate (used by /reflect)
node scripts/vault-search.mjs reflect-scan "query1" "query2" [--top N] [--candidates N]

# List intention contexts
node scripts/vault-search.mjs intentions ["filter"]

# Export federation index
node scripts/vault-search.mjs export-index

# Sync with federation hub
node scripts/vault-search.mjs sync
```

The `reflect-scan` command batches multiple queries into a single process, sharing model init, embedding loads, and graph traversal across queries for ~30% faster throughput.

## Retrieval instrumentation

Every search query is logged to `PLUGIN_DATA/retrieval/queries-YYYY-MM.jsonl` with timestamp, session ID, command, query text, result count, peer hit count, and top-10 result paths. Run `node scripts/retrieval-report.mjs` to see query patterns, repeated queries, most-surfaced notes, and federation hit rates.

## Index

The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. It contains note metadata, full-text content, embeddings, and the wikilink graph. The `ll-search` binary bundles both models. Run `vault-search.mjs index --force` to rebuild everything.
