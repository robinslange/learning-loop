# Changelog

## v1.15.1

### Changed

- `init` skill Phase 4 rewritten for self-service federation onboarding via `interchange.live` invitation tokens. Paste a redeem token -> automatic headscale provisioning -> `tailscale up` -> sync test, no manual hub admin step.
- Existing peers re-running `init` are unaffected (token prompt only appears on fresh setup).

### Removed

- Manual hub registration step (4b.1) -- superseded by the automatic redeem flow at `interchange.live/api/redeem`.

## v1.15.0

### Added

- **Just-in-time vault + episodic context injection on UserPromptSubmit** -- searches vault and past conversations when you ask a substantive question and injects the top matches into Claude's context. Ships in shadow mode by default; flip `injection_mode: "live"` in config.json after reviewing shadow log via `scripts/review-shadow.mjs`.
- **Episodic pre-warm on SessionStart** -- warms the OS page cache for the episodic-memory model and index.
- **Provenance dedupe** within hook invocations, keyed on (session_id, agent_id, path).
- **`scripts/review-shadow.mjs`** -- shadow injection log analyzer with stats, latency percentiles, and go/no-go gate.

### Changed

- `hooks/session-label.js` -- runs injection pipeline after label-writing. Stdout empty unless `injection_mode: "live"` AND gate passed.
- `hooks/session-start.js` -- sweeps session-dedupe dir (7d TTL) and fires detached episodic pre-warm.
- `hooks/pre-compact.js` -- content review (no behavior change).

## v1.13.1

- fix: remove hardcoded fallback path in federation config resolution

## v1.13.0

Subagent provenance, memory-read tracking, and PRF tuning.

### Added

- Subagent provenance tracking via shared hook module
- `post-read-retrieval.js` hook for vault read instrumentation
- `post-search-tracking.js` hook for episodic memory search tracking

### Changed

- PRF switched from add-as-signal to hybrid-feedback strategy

## v1.12.3

Discovery skill rewrite: mechanical convergence, self-regulating effort.

### Added

- Mechanical convergence checker for research stopping decisions
- Sentence-split utility for convergence checking
- Auto-link safety net in promote-gate for unlinked notes

### Changed

- Discovery researcher rewritten to use mechanical convergence checking
- Depth parameter removed from discovery skill -- effort is now self-regulating
- Decision gates simplified, depth gate removed (now mechanical)
- Backlink hook replaced with autolink hook (`post-write-autolink.js`), extended matcher to Write|Edit

### Removed

- `research-scaling` skill (replaced by mechanical convergence)

### Fixed

- Accept Edit tool_response shape (may not have success field)
- Read links from disk not tool_input to prevent dedup failure
- Status shows summary not raw embeddings, EMA uses mean of first two rates
- Stale depth references in help and discovery skills

## v1.12.2

- fix: source provenance contract across researcher-writer-gate pipeline

## v1.12.1

- fix: inject resolved PLUGIN/PLUGIN_DATA paths from session-start hook

## v1.12.0

ll-search v2: module split, rayon parallelism, EmbeddingStore cache, Rocchio PRF.

### Added

- Rocchio vector PRF as 5th RRF signal
- `EmbeddingStore` cache to eliminate redundant embedding deserialization
- `Migrate` and `Benchmark` CLI commands restored for future model experiments
- `EmbeddingProvider` trait, `ModelConfig`, and `BgeSmallProvider` for model abstraction
- Shadow-table migration for model switching
- Federation: advertise supported models, BM25 fallback for mismatched peers
- `--model` flag on all embedding CLI commands
- Generate embeddings for peers that lack them on sync

### Changed

- `search.rs` split into `search/` module with 8 focused files
- `db.rs` split into `db/` module (schema, index, query)
- Pairwise cosine ops parallelized with rayon
- Batch body loading into single SQL query
- `open_db` returns `anyhow::Result` for proper error propagation
- WAL checkpoint after reindex in watch mode
- Removed unnecessary `RwLock` from `EmbeddingStore` (data is immutable after construction)

### Removed

- Dead `--incremental` CLI flag
- EmbeddingGemma experiment (provider abstraction kept)

## v1.11.0

Graph-augmented retrieval and composable search architecture.

### Added

- **Personalized PageRank** as a third RRF signal: walks the wikilink graph from seed results to surface bridge notes that connect domains. Damping=0.5, 20 iterations, sub-millisecond at vault scale.
- **IDF-weighted tag expansion** as a fourth RRF signal: finds notes sharing rare tags (freq 2-20) with seed results. Patches vocabulary gap failures where vector similarity misses categorical neighbors.
- `links` table populated during indexing from extracted wikilinks. 6,521 links stored from 2,261 notes.
- `extract_wikilinks` in preprocess.rs: parses `[[target]]`, `[[target|alias]]`, `[[target#heading]]` before wikilink stripping
- `load_link_graph`: builds undirected adjacency from links table with HashSet deduplication for mutual links
- `retrieval-report.mjs`: summary of query patterns, repeated queries, most-surfaced notes, federation hit rates
- Retrieval instrumentation: every search logs to `retrieval/queries-YYYY-MM.jsonl` with session, command, query, results, peer hits
- 15 new tests (7 preprocess, 8 search) covering wikilink extraction, PPR, tag expansion, graph loading

### Changed

- **Search architecture refactored** into composable building blocks: `local_rrf_scores`, `add_peer_rrf_scores`, `add_ranked_rrf`, `finalize_rrf`. All four search functions (hybrid_query, hybrid_query_federated, reflect_scan, reflect_scan_federated) compose from these instead of duplicating logic. Future signal additions (e.g., new embedding model) touch one function, not four.
- Cross-domain query baseline improved: queries that scored B-C now surface graph-connected bridge notes
- `drop_all` includes `links` table cleanup

### Fixed

- Stale init skill text still referenced hub download fallback (removed in v1.10.2)

## v1.10.3

- Fix stale hub download reference in init skill

## v1.10.2

Federated search hardening: test coverage, deduplication, and performance.

### Added

- 17 unit tests for search and federated search functions (discover_peer_dbs, hybrid_query, federated merge/prefix/degradation, body routing, FTS edge cases)
- `batch_load_bodies_federated` shared helper for peer-aware body loading
- `load_title_federated` for lazy per-result title lookup in federated queries
- `tempfile` dev-dependency for filesystem-based tests

### Changed

- Extracted `hybrid_query_inner` and `hybrid_query_federated_inner` to separate ONNX embedding from search logic, enabling tests without model overhead
- Federated hybrid query uses lazy title loading (per-result lookup instead of bulk load from all peers)
- `reflect_scan_federated` hoists merged title map above query loop (was rebuilding N times)
- `reflect_scan_federated` uses `batch_load_bodies_federated` instead of inline peer routing
- Rerank CLI command uses `batch_load_bodies_federated` instead of inline per-result SQL

### Removed

- Dead `keyword_search` function (zero callers)
- `DownloadBinary` CLI command (hub download fallback removed, GitHub-only)
- `native/src/sync/download.rs` module

### Fixed

- Defensive path normalization in export (backslash to forward slash for Windows peers)

## v1.10.1

Cleanup after federated search launch.

- Remove dead `keyword_search_federated` function
- Consistent `--config-dir` flag on export and sync commands

## v1.10.0

Federated search: peer vaults are now searchable alongside local notes.

### Added

- `discover_peer_dbs` finds and opens peer index databases with model ID validation
- `hybrid_query_federated` merges local and peer results via flat RRF fusion
- `reflect_scan_federated` with peer BM25 + vector search + cross-vault reranking
- `--config-dir` on Query, Rerank, ReflectScan CLI commands for automatic federation
- JS dispatcher auto-passes `--config-dir` when federation config exists
- Session-start hook injects federation status and staleness warning
- Federation section in help skill
- Embeddings included in federation export for cross-vault vector search
- FTS5 rebuild on peer indexes after download
- Graceful fallback when peer index lacks embeddings table

### Fixed

- Path normalization to forward slashes in `walk_dir` for Windows compatibility

## v1.9.4

- Fix double `JSON.parse` in federation export

## v1.9.3

- Download binary from GitHub first, hub as fallback

## v1.9.2

- Require source URLs at write-time to prevent source-missing findings

## v1.9.1

- Align vault path resolution, optimize note scanning, clean dead code
- Add tests for dream-gate and session-label hooks

## v1.9.0

Vault write hooks and discriminate threshold tuning.

### Added

- PreToolUse validation hook for vault writes (dupe detection, structure enforcement)
- PostToolUse backlink hook for vault writes
- Tests for pre-write and post-write hooks

### Changed

- Discriminate threshold default raised to 0.85
- H1 title extraction for dupe detection instead of filename

## v1.8.0

Dream v2: seven consolidation operators, confidence-aware memory lifecycle, retrieval tracking, and architectural refactoring across the plugin.

### Added

- **Three new dream operators**: RESOLVE (four-strategy contradiction handling), ABSTRACT (higher-order pattern synthesis with per-cluster user gate), LINK (cross-type memory connections via `related:` frontmatter)
- **Confidence tiering**: `/reflect` assigns `confidence: strong|medium|weak` to auto-memory captures based on signal strength (explicit > correction > implicit)
- **Retrieval tracking**: session-start hook persists memory file snapshots to `PLUGIN_DATA/retrieval/access-*.jsonl` for decay-based pruning
- **Size-limit flagging**: dream Phase 2 flags memories exceeding character thresholds (500 chars feedback/user, 1,000 chars project/reference)
- **Shared skills**: `_skills/fleeting-sweep.md` extracted from inbox-organiser, reusable by `/health`

### Changed

- **Dream architecture**: monolithic 338-line SKILL.md split into 143-line orchestrator + 7 focused operator files in `operators/`. Each operator loads only when Phase 3 reaches it, reducing distractor density.
- **MERGE simplified**: no longer does three-way classification. Merges what belongs together; contradictions flagged separately for RESOLVE.
- **PRUNE upgraded**: confidence-aware thresholds (weak prunes first, strong never auto-prunes on retrieval alone)
- **note-writer**: 70-line inline verification extracted to reference `_skills/source-verification.md`
- **source-verification.md**: added mechanical `verify-note`/`check-claims` API procedure
- **Promote-gate v2**: source routing fork (synthesis/factual/sourced), two-dimension scoring (claim_specificity + source_grounded)
- **note-verifier**: 4-level ordinal output (strong/partial/no source/contradicted)
- **inbox-organiser**: synthesis-tagged notes exempt from Sourcing + Source Integrity criteria

### Fixed

- Ghost provenance process in session-start.js replaced with synchronous `execFileSync`
- Stale "5 criteria" references updated to 6 across note-writer, inbox-organiser, note-deepener, promote-gate
- counter-argument-linking: grep before appending backlinks (prevents duplicates)
- capture-rules: tag de-duplication rule
- route-output: no parallel writes to same project memory

## v1.7.2

Write-time source verification, POS-tagged citation extraction, and improved resolver accuracy.

### Added

- **Write-time source verification**: note-writer now calls `source-resolver.mjs verify-note` on every note before returning, catching author swaps and wrong years against API ground truth instead of LLM self-review
- **Claim-number checking**: new `check-claims` command extracts quantitative claims from notes and checks whether each number appears in the cited source's abstract
- **POS-tagged citation extraction**: vendored winkNLP (4.5MB, pure JS) replaces the naive `[A-Z][a-z]+ \d{4}` regex that had a ~60% false positive rate on author-year patterns (matching month names like "May 2025" and common words like "Reports 2025")
- **Verification markers**: `[unresolved]`, `[unverified]`, and `[not in abstract]` inline markers signal where human or deeper review should focus. All agents understand these markers via capture-rules.
- **Provenance instrumentation**: every note-writer verification emits a structured `source-check` event tracking pass/fail rates, failure types, and claim coverage

### Improved

- **Resolver accuracy**: PubMed field-qualified search (`Author[Author] AND Year[Date]`) before free-text fallback. Multiple candidates scored by author match instead of blindly taking the first result. Note title keywords passed as topic context for ambiguous queries.
- **Discovery-researcher**: research briefs now require literal API-returned abstract text, not paraphrased summaries, so downstream claim verification has ground truth to compare against
- **Verify skill**: marker-aware -- focuses effort on resolving write-time flags rather than re-checking what already passed
- **Deepen skill**: resolves verification markers (`[unresolved]`, `[unverified]`, `[not in abstract]`) when strengthening notes

### Baseline

50-note sample measured before deployment:
- 32% of resolvable sources passed verification
- 31% failed (wrong_author dominated)
- 37% had no resolvable identifier (blog/GitHub/docs)

Post-resolver-improvement spot check on 5 worst-case notes: 14 issues reduced to 0.

## v1.7.1

Provenance system fixes and cross-platform support.

- `provenance-emit.js` replaces `provenance-emit.sh` for Windows compatibility
- Removed `scores.jsonl` Write pattern from verify skill, replaced with direct `provenance-emit.js` calls
- Removed `scores.jsonl` handler from `post-tool-provenance.js` hook
- All 7 skills updated to use `.js` emitter
