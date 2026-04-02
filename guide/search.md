# Search

Hybrid search combining BM25 (full-text) and vector similarity (BGE-small-en-v1.5, quantized int8), with optional cross-encoder reranking (ms-marco-MiniLM-L-6-v2, quantized int8). All search, embedding, and reranking runs in the `ll-search` Rust binary -- zero native Node.js dependencies, all JS deps vendored.

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

The `--rerank` flag runs a cross-encoder over the top 20 hybrid candidates and reorders by semantic relevance. Adds ~300ms latency but significantly improves precision for ambiguous and long natural language queries. Search-critical agents (vault-scout, note-verifier, counter-argument linker) use reranking by default. The `reflect-scan` command batches multiple queries into a single process, sharing model init and embedding loads across queries for ~30% faster throughput.

The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. Both the embedding model and reranker model are bundled inside the `ll-search` binary.
