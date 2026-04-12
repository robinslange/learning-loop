# ll-core

Hybrid semantic search engine. SQLite + ONNX, no external services.

- **Embedding trait** — model-agnostic interface for ONNX-backed embedders
- **Hybrid scoring** — BM25 (FTS5) + vector cosine fused via RRF, with configurable FTS table schema
- **Graph scoring** — personalized PageRank over pre-loaded edges
- **Cross-encoder reranker** — ms-marco-MiniLM-L-6-v2 bundled via `include_bytes!`, no runtime download
- **Embedding store** — in-memory cache with O(n) cosine over all vectors

Used by [ll-search](https://github.com/robinslange/learning-loop) (Obsidian vault search) and [postbox-search](https://github.com/robinslange/mcp-messaging) (local messaging semantic search).

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
```

## License

MIT. See [LICENSE](LICENSE).
