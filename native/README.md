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
ll-search index <vault-path> <db-path> [--force]
ll-search query <db-path> "search terms" [--top N]
ll-search similar <db-path> <note-path> [--top N]
ll-search cluster <db-path> [--threshold 0.85]
ll-search discriminate <db-path> [--threshold 0.78] [paths...]
ll-search embed "text"
ll-search status <db-path> <vault-path>
ll-search version
```

All commands output JSON to stdout, errors to stderr. Exit 0 on success, 1 on error.

## CI

GitHub Actions builds 4 targets on tag push (`v*`):

| Target | Runner | Artifact |
|--------|--------|----------|
| aarch64-apple-darwin | macos-latest | ll-search-darwin-arm64.tar.gz |
| x86_64-apple-darwin | macos-latest | ll-search-darwin-x64.tar.gz |
| x86_64-unknown-linux-gnu | ubuntu-latest | ll-search-linux-x64.tar.gz |
| x86_64-pc-windows-msvc | windows-latest | ll-search-windows-x64.zip |

Each artifact contains the binary + ONNX Runtime sidecar dylib.

## Adding Commands

1. Add variant to `Commands` enum in `main.rs`
2. Implement in the appropriate module (`db.rs`, `search.rs`, etc.)
3. Wire up in `main()` match
4. Update `scripts/vault-search.mjs` dispatcher if the JS layer needs to call it
