# ll-core

Hybrid semantic search engine. SQLite-backed, on-device ONNX inference, no external services.

- **Embedding trait** — model-agnostic interface for ONNX-backed embedders (BGE, mE5, etc.)
- **Hybrid scoring** — BM25 (FTS5) + vector cosine fused via RRF, with configurable FTS table schema
- **Graph scoring** — personalized PageRank over pre-loaded edges, for link/citation/participant graphs
- **Cross-encoder reranker** — ms-marco-MiniLM-L-6-v2 bundled via `include_bytes!`, no runtime download
- **Embedding store** — in-memory cache with O(n) cosine over all vectors
- **Rocchio PRF** — pseudo-relevance feedback for query expansion

Built for local-first tools that need search over SQLite data without shipping a vector database or hitting an API.

## Projects using ll-core

**[learning-loop](https://github.com/robinslange/learning-loop/tree/main/native)** — A Claude Code plugin that turns your Obsidian vault into a queryable knowledge graph. ll-core powers semantic search, link-graph traversal, and note clustering across thousands of atomic notes. Runs entirely on your machine.

## Usage

```rust
use ll_core::embed::EmbeddingProvider;
use ll_core::scoring::{fts_bm25_query, FtsConfig};
use ll_core::store::EmbeddingStore;

// Implement EmbeddingProvider for your model, then:
let store = EmbeddingStore::from_data(vec![(1, "key".into(), vec![0.1; 384])]);

let fts_config = FtsConfig {
    fts_table: "messages_fts",
    content_table: "messages",
    items_table: "messages",
    id_column: "id",
    path_column: "message_id",
    bm25_weights: "5.0, 10.0",
};
let hits = fts_bm25_query(&conn, "search text", 20, &fts_config);

// Fuse with vector search via RRF:
let mut rrf_scores = std::collections::HashMap::new();
ll_core::scoring::add_ranked_rrf(&mut rrf_scores, hits.iter().map(|(_, p, _)| p.as_str()));
let results = ll_core::scoring::finalize_rrf(rrf_scores, 10);
```

## Why another search library?

Existing Rust search crates either ship a full vector database (heavyweight) or are pure algorithms with no SQLite integration (too low-level). ll-core sits in between: enough infrastructure to build a real search experience, thin enough to embed in a sidecar or CLI.

The design came from [learning-loop](https://github.com/robinslange/learning-loop/tree/main/native)'s need to search an Obsidian vault with BM25 + embeddings + wikilink graph + reranking, all running on a laptop.

## License

MIT. See [LICENSE](LICENSE).
