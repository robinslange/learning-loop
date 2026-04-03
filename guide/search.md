# Search

Four-signal hybrid search: BM25 (full-text), vector similarity (BGE-small-en-v1.5, quantized int8), Personalized PageRank over the wikilink graph, and IDF-weighted tag expansion. Optional cross-encoder reranking (ms-marco-MiniLM-L-6-v2, quantized int8). All search, embedding, graph traversal, and reranking runs in the `ll-search` Rust binary -- zero native Node.js dependencies, all JS deps vendored.

## Commands

```bash
# Hybrid semantic + keyword search
node scripts/vault-search.mjs query "caffeine tolerance"

# Hybrid search with cross-encoder reranking (better precision, +300ms)
node scripts/vault-search.mjs search "caffeine tolerance" --rerank

# Find similar notes
node scripts/vault-search.mjs similar "path/to/note.md"

# Cluster by similarity
node scripts/vault-search.mjs cluster --threshold 0.72

# Rebuild index
node scripts/vault-search.mjs index [--force] [--watch] [--sync]

# Find confusable note pairs
node scripts/vault-search.mjs discriminate <paths>

# Batch search+rerank+discriminate (used by /reflect)
node scripts/vault-search.mjs reflect-scan "query1" "query2" --top 5
```

## How search works

Every query runs four retrieval signals in parallel, merged via Reciprocal Rank Fusion (RRF):

1. **BM25** -- full-text keyword matching via FTS5 (title 10x, tags 5x, body 1x weighting)
2. **Vector similarity** -- cosine similarity against BGE-small-en-v1.5 embeddings (384-dim, int8 quantized)
3. **Personalized PageRank** -- walks the wikilink graph from the top BM25+vector results, surfacing bridge notes that connect domains (damping=0.5, 20 iterations)
4. **Tag expansion** -- finds notes sharing rare tags (frequency 2-20) with the top results, IDF-weighted to favor specific tags over broad ones

The top 30 candidates from each signal enter the RRF merge. The graph signals (PPR + tags) specifically improve cross-domain recall -- surfacing notes that no single keyword or embedding would find, but that your wikilinks connect.

The `--rerank` flag runs a cross-encoder over the top 20 hybrid candidates and reorders by semantic relevance. Adds ~300ms latency but significantly improves precision for ambiguous and long natural language queries. Search-critical agents (vault-scout, note-verifier, counter-argument linker) use reranking by default. The `reflect-scan` command batches multiple queries into a single process, sharing model init, embedding loads, and graph traversal across queries for ~30% faster throughput.

## Retrieval instrumentation

Every search query is logged to `PLUGIN_DATA/retrieval/queries-YYYY-MM.jsonl` with timestamp, session ID, command, query text, result count, peer hit count, and top-10 result paths. Run `node scripts/retrieval-report.mjs` to see query patterns, repeated queries, most-surfaced notes, and federation hit rates.

## Index

The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. It contains note metadata, full-text content, embeddings, and the wikilink graph (links table). Both the embedding model and reranker model are bundled inside the `ll-search` binary. Run `vault-search.mjs index --force` to rebuild everything including the link graph.
