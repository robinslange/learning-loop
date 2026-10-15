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

// `messages_fts` is an FTS5 table whose rowid is `messages.id`. The content
// table must be a real table (not the FTS table itself), and `id_column` must
// equal the FTS rowid. One bm25 weight per FTS column.
let fts_config = FtsConfig::new(
    "messages_fts", // fts_table: queried with MATCH
    "messages",     // content_table: joined on id = messages_fts.rowid
    "messages",     // items_table: joined on id, supplies path_column
    "id",           // id_column
    "message_id",   // path_column
    "5.0, 10.0",    // bm25_weights
);
let hits = fts_bm25_query(&conn, "search text", 20, &fts_config);

// Fuse with vector search via RRF:
let mut rrf_scores = std::collections::HashMap::new();
ll_core::scoring::add_ranked_rrf(&mut rrf_scores, hits.iter().map(|(_, p, _)| p.as_str()));
let results = ll_core::scoring::finalize_rrf(rrf_scores, 10);
```

## Features

`bge` (off by default) adds `models::bge_small`: a pinned, SHA-256-verified
bge-small-en-v1.5 loader. `models::bge_small::load()` locates ONNX Runtime,
downloads the model and tokenizer on first use into `~/.learning-loop/models`
(override with `LL_MODELS_DIR`), and returns a boxed `EmbeddingProvider`. The
first download shells out to `curl`, so it must be on `PATH`.

## Why another search library?

Existing Rust search crates either ship a full vector database (heavyweight) or are pure algorithms with no SQLite integration (too low-level). ll-core sits in between: enough infrastructure to build a real search experience, thin enough to embed in a sidecar or CLI.

The design came from [learning-loop](https://github.com/robinslange/learning-loop/tree/main/native)'s need to search an Obsidian vault with BM25 + embeddings + wikilink graph + reranking, all running on a laptop.

## License

MIT. See [LICENSE](LICENSE).
