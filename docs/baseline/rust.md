# rust baseline conventions

Conventions for `native/crates/ll-core/` and `native/crates/ll-search/`. Read this before touching any Rust file. See `docs/baseline/plugin.md` for JS/MJS hooks and scripts, `docs/baseline/cross-cutting.md` for versioning, perf budgets, and observability.

*Phase status: Phase 0 establishes these rules as documented expectations. Phase 1 adds enforcement gates (clippy deny, grep CI, `cargo doc -D missing_docs`). After track 1I merges, CI rejects violations.*

---

## ll-core conventions

`ll-core` is a published library crate (`crates.io`, currently `0.1.x`). It carries a semver contract. Breaking the API in a patch hurts external users.

### one typed error per crate

Every module propagates a single `thiserror`-derived `Error` enum exported as:

```rust
pub type Result<T> = std::result::Result<T, Error>;
```

`anyhow::Error` is acceptable internally in ll-search (binary) but not in ll-core (library). Inventory confirms all 54 public items in ll-core currently return `anyhow::Result` (see `.planning/inventory/ll-core-api.md:179-238`); track 0A adds the typed `Error` and track 1G converts callers.

### all public enums `#[non_exhaustive]`

Consumers that `match` on ll-core enums must not silently break when a new variant is added. Mark every public enum `#[non_exhaustive]` so callers add `_ => {}` arms. Track 0A adds this; CI will enforce with `cargo-semver-checks` from phase 1.

Inventory identified two structs as candidates: `ModelConfig` (embed.rs, 10 fields, likely to grow) and `FtsConfig` (scoring.rs, 6 fields, query configuration extends). See `.planning/inventory/ll-core-api.md:251-258`.

### document every public item

The `-D missing_docs` lint gate is planned for phase 1. To get there, every `pub` item needs a `///` comment. Inventory found 54 undocumented items at baseline (`.planning/inventory/ll-core-api.md:179-238`). Track 0A must document all of them. No new public item merges undocumented.

One-line minimum:

```rust
/// Top-k limit for ranked candidate sets.
pub const TOP_K: usize = 30;
```

Full doc format for complex items:

```rust
/// Scores a ranked fusion of candidate lists using Reciprocal Rank Fusion.
///
/// `top_n` caps the output. Returns an empty vec if `rrf_scores` is empty.
pub fn finalize_rrf(rrf_scores: HashMap<String, f64>, top_n: usize) -> Vec<(String, f64)> {
```

### no I/O in the crate

ll-core must be pure computation: ranking, graph traversal, embedding normalization, BM25. No file reads, network calls, or `build.rs` model fetches. Model download lives in `xtask`; runtime I/O lives in ll-search. This makes ll-core testable without fixtures and publishable without side effects.

### embeddings flow as `Arc<[f32]>`

Clone-based embedding accessors exist today at `store.rs:29,34` (see `.planning/inventory/rust-audit.md:251-324`):

```rust
pub fn get_by_path(&self, path: &str) -> Option<Vec<f32>>;  // clones every call
pub fn get_by_id(&self, id: i64) -> Option<Vec<f32>>;        // clones every call
```

Each clone in a 10k-note search loop copies 768 f32 values (3 KB). Track 0A adds `Arc<[f32]>` accessors alongside the existing ones. Track 1E eliminates the clone-based calls from hot paths. Phase 2 deprecates and removes the cloning accessors.

### tests beside code

Unit tests live in a `#[cfg(test)] mod tests` block at the bottom of the file they test. Integration tests live in `native/tests/`. Do not create separate `*_test.rs` siblings; the module system handles visibility naturally.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_empty_input_returns_empty() {
        assert!(finalize_rrf(HashMap::new(), 10).is_empty());
    }
}
```

### MSRV pinned

`native/crates/ll-core/Cargo.toml` carries `rust-version = "1.88"`. Keep it. Don't use nightly features or stabilised-after-1.88 APIs without bumping and announcing the MSRV change. ll-search inherits the same floor.

---

## ll-search conventions

ll-search is a daemon binary. It has no semver contract of its own -- it ships with the plugin and versions together with it. Internal structure conventions matter here for a different reason: hot-path latency.

### directory layout

Target layout (see plan §1.2; tracked in `.planning/refactors/baseline-2026-05-11.md`):

```
ll-search/src/
  main.rs             -- CLI entry; ONLY place with .expect()/.unwrap() outside tests
  lib.rs              -- public surface for integration tests
  app/                -- AppState, lifecycle, command dispatch (track 0G)
    mod.rs
    state.rs
    io.rs             -- emit() / pretty-vs-compact JSON
    storage.rs        -- Storage trait abstracting db reads
  model/              -- ONNX session management
  embed/              -- text -> vec
  preprocess.rs       -- pure, no I/O
  db/                 -- sqlite only -- no search logic
    schema.rs
    migrations/
    index.rs
    query.rs
  search/             -- pure query pipeline; uses Storage trait from app/
  nli/                -- entailment inference
  sync/               -- network only -- no search logic
```

Currently `app/` does not exist. Track 0G creates it. Until 0G merges, the convention is documented here but not enforceable. After 0G: `load_store(` outside `app/` triggers a CI grep failure.

The audit found that `search/query.rs`, `search/store.rs`, and `search/reflect.rs` all call `db::load_all_embeddings()` directly (`.planning/inventory/rust-audit.md:180-189`). This cross-boundary dependency is the primary target of track 1E.

### Storage trait in `app/`

`app/storage.rs` defines the trait that all search-layer code uses to read from SQLite. This prevents `search/` from depending on `db/` directly.

```rust
pub trait Storage: Send + Sync {
    fn all_embeddings(&self) -> Result<Vec<(NoteId, PathBuf, Arc<[f32]>)>>;
    fn note_by_path(&self, path: &str) -> Result<Option<Note>>;
    fn link_graph(&self) -> Result<LinkGraph>;
    fn titles_map(&self) -> Result<HashMap<String, String>>;
    fn mtime_map(&self) -> Result<HashMap<String, i64>>;
    fn tags_map(&self) -> Result<HashMap<String, Vec<String>>>;
    fn project_phases(&self) -> Result<HashMap<String, ProjectPhase>>;
}
```

Track 0G adds the trait + a `DbStorage` impl backed by current `db::*` functions. Track 1E rewires `search/` to consume it.

### AppState owns long-lived state; built once per daemon

`AppState` is constructed once in `main.rs` at startup and threaded through every command handler. It owns: the Storage impl, the ONNX model session, federation config, and the SearchContext cache (after track 1E). Nothing outside `app/` constructs AppState.

See `.planning/inventory/rust-audit.md:483-488` for the audit finding: main.rs currently has no AppState; context is rebuilt per-command.

### no `expect`/`unwrap` outside `main.rs` and tests

`main.rs` is allowed to use `.expect()` for unrecoverable startup failures (binary can't proceed without a DB connection). Everywhere else, propagate with `?`. Currently ~25 sites violate this (`.planning/inventory/rust-audit.md:328-352`). Track 1G resolves them.

Clippy denial (planned for phase 1):

```toml
[lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
```

Exceptions go in a `#[allow(clippy::unwrap_used)]` with a comment explaining why the value is guaranteed.

### hot-path: zero new `String` clones in candidate loops

The hot paths are `search/{query,context,federation,graph,reflect}.rs`. The audit found 15-20 clone sites in these files (`.planning/inventory/rust-audit.md:251-324`), primarily `path.clone()` in per-candidate loops. Track 1E eliminates them by switching to `Arc<str>` paths. Do not introduce new `.clone()` calls in these modules. Criterion benchmarks track the regression.

### daemon output: compact JSON; `--pretty` flag for debug

All output goes through a single `emit(value)` helper in `app/io.rs`. Default is compact single-line JSON for machine consumers. `--pretty` is a global flag for human debugging. Track 2L adds this helper; before it merges, new command output should follow the same pattern manually.

### every public CLI subcommand has a snapshot test

Add a `tests/cli/<subcommand>.rs` file using `assert_cmd` for each new CLI entry point. The test asserts on stdout shape and exit code. See `native/crates/ll-search/tests/` for existing examples.

### one tokio runtime declared in `main.rs`

`Runtime::new()` appears exactly once. If an async helper function needs to block, it calls `tokio::task::spawn_blocking` from within the existing runtime, or is rewritten as `async`. Never create a second runtime inside a submodule.

---

## why these rules exist

**Arc vs Vec on embeddings.** ll-search processes up to 50k notes per query. A 1024-dimensional embedding is 4 KB. Cloning it per-candidate during ranking means gigabytes of allocation per second at scale. `Arc<[f32]>` is a single reference-counted pointer; sharing is free after the initial load. The hot-path clone sites in `.planning/inventory/rust-audit.md:251-324` are the primary reason query latency at `p95` is above the 50 ms budget on larger vaults.

**AppState lifetime.** `SearchContext` is an expensive struct: it joins tags, titles, graph edges, and the full embedding matrix. The audit flagged that `(*ctx.titles).clone()` at `search/reflect.rs:144` clones the entire titles `HashMap` on every reflective search call (`.planning/inventory/rust-audit.md:483-488`). AppState + a cached `SearchContext` eliminates this rebuild. Track 1E targets ≥30% p50 reduction.

**Unwrap density.** Twenty-five sites outside tests and `main.rs` use `.unwrap()` or `.expect()` (`.planning/inventory/rust-audit.md:328-352`). Each is a silent panic path in production. The embed.rs `panic!()` for an uninitialised provider is the worst: it fires inside a search request, crashing the daemon and losing all in-flight state. Typed errors + `?` make failures visible and recoverable.

**No I/O in ll-core.** ll-core is a library. Users `cargo add ll-core` expecting pure computation. A file fetch in `build.rs` means their CI fails on a network timeout. Side effects at library scope are a trust violation.

---

## CI enforcement

| Rule | CI check | Lands in |
|---|---|---|
| No `.unwrap()` / `.expect()` outside `main.rs` + tests | `clippy::unwrap_used` + `clippy::expect_used` at deny | Phase 1 (track 1G) |
| All public items documented | `cargo doc --no-deps -D missing_docs -p ll-core` | Phase 1 (after track 0A) |
| No new breaking API changes in ll-core | `cargo semver-checks -p ll-core` diff vs 0.1.x | Phase 1 |
| No `Runtime::new()` outside `main.rs` | grep CI pattern in `.github/workflows/baseline.yml` | Phase 1I (future) |
| No `load_store(` outside `app/` | grep CI pattern | After track 0G |
| Hot-path bench regression | Criterion via `npm run bench`, soft-fail | Phase 0E; hard fail in phase 1 |

*After track 1I, `.github/workflows/baseline.yml` will exist and enforce the grep rules above. It does not exist yet.*

---

## example: writing a new public function in ll-core

Scenario: adding a `decay_scores` function that applies temporal decay to a ranked list.

**Step 1.** Add to the appropriate module. Scoring functions go in `ll-core/src/scoring.rs`.

**Step 2.** Document it:

```rust
/// Applies exponential temporal decay to a ranked list.
///
/// `half_life_days` controls the decay rate. A note last accessed `half_life_days`
/// ago receives half its original score. Decay is applied multiplicatively.
///
/// Returns a new vec with scores adjusted; order is preserved.
pub fn decay_scores(
    results: Vec<(String, f64)>,
    mtime_map: &HashMap<String, i64>,
    half_life_days: f64,
    now_secs: i64,
) -> Vec<(String, f64)> {
```

**Step 3.** Mark the struct `#[non_exhaustive]` if it will grow.

**Step 4.** Write a test in the same file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_zero_half_life_panics() {
        // half_life_days must be > 0; document the contract
    }

    #[test]
    fn decay_very_old_note_approaches_zero() {
        let mut mtime_map = HashMap::new();
        mtime_map.insert("note.md".to_string(), 0_i64); // epoch
        let results = vec![("note.md".to_string(), 1.0)];
        let decayed = decay_scores(results, &mtime_map, 30.0, 86400 * 365);
        assert!(decayed[0].1 < 0.001, "ancient note should nearly vanish");
    }
}
```

**Step 5.** Run the check:

```bash
cd /Users/robin/brain/learning-loop/native
cargo test -p ll-core
cargo doc --no-deps -p ll-core
cargo public-api -p ll-core   # verify additive-only diff
```

**Step 6.** If `all_embeddings` in the signature uses `Vec<f32>` -- switch to `Arc<[f32]>`. New ll-core code should not introduce the clone pattern.

---

---

## build and dependency conventions

### MSRV matrix

| Crate | `rust-version` | Last updated |
|---|---|---|
| ll-core | 1.88 | 2026-05-11 |
| ll-search | 1.88 (inherits workspace floor) | 2026-05-11 |

Run `rustup update stable` before raising MSRV. Check that CI matrix covers both the pinned floor and latest stable.

### dependency audit

Run before adding a new dependency:

```bash
cargo audit                           # known vulnerabilities
cargo deny check                      # license + advisory policy
cargo tree -p ll-core --depth 1       # transitive surface area
```

**Pre-release dependencies.** `ort = "2.0.0-rc.12"` (ONNX inference) is the only pre-release dependency in either crate. It is not expected to have a stable 2.0 release imminently. Before shipping a crates.io publish (track 2R), either upgrade to a stable ort release or vendor the ONNX model loading to remove the dependency. See `.planning/inventory/rust-audit.md` findings §9 for the risk note.

**Bundled SQLite.** `rusqlite = { version = "0.32", features = ["bundled"] }` bundles SQLite at compile time. This is intentional: it ensures a consistent SQLite version across macOS, Linux, and Windows without relying on the system library. Do not remove the `bundled` feature.

### workspace structure

All Rust code lives under `native/`. The workspace `Cargo.toml` is at `native/Cargo.toml`. The two member crates are:

```toml
[workspace]
members = ["crates/ll-core", "crates/ll-search"]
resolver = "2"
```

Build from repo root:

```bash
cd /Users/robin/brain/learning-loop/native
cargo build --release
cargo test --workspace
```

---

## common pitfalls

### adding a new CLI subcommand

1. Add the variant to the `Commands` enum in `main.rs`.
2. Add a `fn handle_<subcommand>(args, state: &AppState)` in the appropriate module.
3. Add a snapshot test in `native/crates/ll-search/tests/cli/<subcommand>.rs`.
4. Document the command in `guide/workflows.md`.

Do not add business logic directly in `main.rs`. It is a dispatcher only.

### modifying the SQLite schema

1. Add a new migration file at `db/migrations/NNNN_description.sql` (SQL only -- idempotent, include rollback comment).
2. Register it in `db/schema.rs` migration array.
3. Add a test in `native/crates/ll-search/tests/migration_<description>.rs` that runs the migration on a fixture DB and verifies the result.
4. Increment `SCHEMA_VERSION` in `db/schema.rs`.

All SQL must be parameterized. The two known `format!` exceptions (`db/schema.rs:167`, `db/query.rs:448`) are tracked for phase 1F cleanup (see `.planning/inventory/rust-audit.md` §3).

### modifying the federation protocol

Protocol changes go in `sync/protocol.rs`. The `ClientMessage` and `HubMessage` enums use `serde_json` for wire format. Adding a new variant is additive. Removing or renaming is a breaking change: bump the protocol version field in the WebSocket handshake before deploying.

### understanding SearchContext

`SearchContext` (in `search/context.rs`) is the expensive struct that underpins every query:

- `titles_map` -- `HashMap<String, String>` loaded from SQLite (all note paths + titles)
- `tags_map` -- `HashMap<String, Vec<String>>`
- `embeddings` -- the full `EmbeddingStore`
- `link_graph` -- `HashMap<String, Vec<String>>` for PageRank

Today, this is rebuilt per-query. Track 0G creates `AppState` to own it; track 1E moves the build into a cache. Until 1E merges, do not add new fields to `SearchContext` that require expensive loads -- they will run on every query.

The expensive rebuild is the primary reason `session-start.js` has occasional 200+ ms spikes on larger vaults. The audit confirmed `search/reflect.rs:144` clones the entire titles map on every reflective search call (`.planning/inventory/rust-audit.md:483-488`).

---

## ll-search integration tests

Integration tests live in `native/crates/ll-search/tests/`. They use `assert_cmd` for CLI assertions and `tempfile` for fixture databases:

```rust
use assert_cmd::Command;
use tempfile::tempdir;

#[test]
fn search_returns_results_on_indexed_vault() {
    let dir = tempdir().unwrap();
    // set up fixture db at dir.path()
    let mut cmd = Command::cargo_bin("ll-search").unwrap();
    cmd.arg("search")
       .arg("--vault")
       .arg(dir.path())
       .write_stdin(r#"{"q":"test"}"#)
       .assert()
       .success()
       .stdout(predicates::str::contains("path"));
}
```

Fixture database setup is in `search/test_helpers.rs`. Use the helpers there; do not create a new fixture pattern.

---

## ll-core semver guidance

The published crate is at `0.1.3` on crates.io. Track 0A advances the Cargo.toml to `0.1.4`. The sequence:

| Phase | Version | Change type | Publish? |
|---|---|---|---|
| 0A | 0.1.4 | Additive: Arc accessor, typed Error, doc comments | No |
| 1G | 0.1.5 | Additive: RerankOutcome enum, error propagation | No |
| 2R | 0.2.0 | Breaking: remove deprecated clone accessors | Yes |

Use `cargo public-api -p ll-core` to verify diffs are additive before each PR. The tool requires nightly; if nightly is unavailable, run `cargo check -p ll-search` to confirm downstream callers compile.

Breaking changes need a `#[deprecated]` marker for at least one minor version before removal. The clone-based accessors (`get_by_path`, `get_by_id`) are deprecated in track 1G and removed in track 2R.

---

## see also

- `docs/baseline/plugin.md` -- hook and script conventions
- `docs/baseline/cross-cutting.md` -- versioning, perf budgets, observability
- `ARCHITECTURE.md` -- repo map and data flow
- `.planning/inventory/rust-audit.md` -- full clone and unwrap inventory
- `.planning/inventory/ll-core-api.md` -- 54-item documentation baseline
- `.planning/refactors/baseline-2026-05-11.md` -- track-by-track plan with acceptance criteria
