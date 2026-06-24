# ll-search

Rust binary for learning-loop search operations. Handles indexing, embedding (ONNX Runtime), and all search queries.

## Building

```
cd native
cargo build --release
```

First build downloads ~34MB model from Hugging Face and fetches ONNX Runtime. Subsequent builds use cache.

Binary output: `target/release/ll-search`

## Commands

```
ll-search index <vault-path> <db-path> [--force] [--sync] [--config-dir PATH]
ll-search query <db-path> "search terms" [--top N] [--recency DAYS] [--after TS] [--before TS] [--session ID] [--project TAG]
ll-search similar <db-path> <note-path> [--top N]
ll-search cluster <db-path> [--threshold 0.85]
ll-search discriminate <db-path> [--threshold 0.85] [paths...]
ll-search reflect-scan <db-path> "query1" "query2" ... [--top N] [--candidates N] [--threshold 0.85]
ll-search rerank <db-path> "query" [--top N] [--candidates N]
ll-search embed "text"
ll-search status <db-path> <vault-path>
ll-search tags <db-path> [--min-count N]
ll-search export <db-path> <output> <vault-path> [--config-dir PATH]
ll-search sync <db-path> <vault-path> [--config-dir PATH]
ll-search watch <vault-path> <db-path> [--sync-interval SECS] [--config-dir PATH] [--pid-file PATH]
ll-search migrate <db-path> --model NAME [--drop-old]
ll-search benchmark <db-path> --model-a NAME --model-b NAME "query1" "query2" ...
ll-search version
```

All commands output JSON to stdout, errors to stderr. Exit 0 on success, 1 on error.

## CI

GitHub Actions builds 3 targets on tag push (`v*`):

| Target | Runner | Artifact |
|--------|--------|----------|
| aarch64-apple-darwin | macos-latest | ll-search-darwin-arm64.tar.gz |
| x86_64-unknown-linux-gnu | ubuntu-latest | ll-search-linux-x64.tar.gz |
| x86_64-pc-windows-msvc | windows-latest | ll-search-windows-x64.zip |

Each artifact contains the binary. The ONNX Runtime native library is loaded
dynamically at runtime (see below), not bundled into the tarball.

## ONNX Runtime (load-dynamic) and offline install

The binary builds `ort` with the `load-dynamic` feature, so it loads an official
Microsoft `libonnxruntime` (v1.24.2, the version `ort` pins) at runtime rather
than statically linking it. On a networked machine the library is fetched and
SHA-256-verified into `~/.learning-loop/lib` on first use — no setup needed.

For air-gapped or IT-controlled hosts, supply the library yourself:

- `ORT_DYLIB_PATH` — absolute path to a `libonnxruntime` shared library (an
  IT-provisioned or system runtime). A missing path fails immediately with a
  clear error instead of hanging on a loader search.
- `LL_ORT_DIR` — a directory to stage the library into (default
  `~/.learning-loop/lib`); pre-place the correct per-target file there.

The ONNX models pre-stage the same way via `LL_MODELS_DIR`. Per-target hashes
live in `provenance/runtime.json` (runtime) and `provenance/models.json`
(models). Intel macOS (`x86_64-apple-darwin`) is unsupported — Microsoft ships
no `osx-x64` binary for the pinned version; set `ORT_DYLIB_PATH` on such a host.

## Module Structure

```
src/
  main.rs           CLI entry point (clap)
  lib.rs            module exports
  db/
    schema.rs       schema creation, migrations, open_db
    index.rs        reindex, vault walking
    query.rs        load_*, status, sessions, tags
  search/
    scoring.rs      cosine, RRF, BM25, Rocchio PRF
    query.rs        hybrid_query, temporal boosting
    federation.rs   peer discovery, federated queries
    graph.rs        link graph, PageRank, tag expansion
    cluster.rs      similar, cluster, discriminate (rayon)
    reflect.rs      reflect-scan orchestration
    store.rs        EmbeddingStore cache (Arc<RwLock>)
  embed.rs          embedding provider interface
  rerank.rs         cross-encoder reranking (ONNX)
  preprocess.rs     markdown parsing, frontmatter
  model/            embedding model implementations
  sync/             federation sync, watch mode
```

## Adding Commands

1. Add variant to `Commands` enum in `main.rs`
2. Implement in the appropriate module under `db/` or `search/`
3. Wire up in `main()` match
4. Update `scripts/vault-search.mjs` dispatcher if the JS layer needs to call it
