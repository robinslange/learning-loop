# Changelog

## v1.16.3

### Fixed

- **Librarian link suggestions: 36% noise rate eliminated.** `submit_link` now guards against self-links, missing target files, and links already present in the target note (wikilink slug matching with regex-escaped dots for Excalidraw-style filenames). Each rejection increments a counter under `state.json:counters`.
- **State counters stuck at 0** despite 959 queued items. `submit_link`, `submit_voice_flag`, and `submit_suspect` now increment their respective top-level counters on queue writes.

### Changed

- **README overhaul** -- slimmed from 144 to 88 lines. Replaced dense prose sections (What it solves, How it works, Resource usage, Troubleshooting) with a short "Why" and four concrete usage examples.
- Moved resource usage, troubleshooting, and detailed workflow patterns to dedicated guide files.

### Added

- **`librarian.log`** -- the librarian now writes timestamped log output to `<PLUGIN_DATA>/librarian/librarian.log` (rotated at 10 MB), restoring `tail -f` visibility when running under `ll-search watch`.
- **`scripts/verify-librarian-fixes.mjs`** -- standalone verification script exercising all submit_link guard rules (10 assertions).
- **`guide/workflows.md`** -- session lifecycle, research/capture/maintenance/consolidation patterns, skill chaining reference.
- **`guide/resource-usage.md`** -- token costs, local compute requirements, cost mitigation strategies, cache health measurement.
- **`guide/troubleshooting.md`** -- all common issues and fixes previously embedded in the README.

## v1.16.2

### Fixed

- **`ll-search` Cargo.toml version out of sync** with the release tag. `release.sh` now updates crate versions alongside `package.json`.
- **`/init` Phase 7 path reference** pointed at wrong `resolve-paths.mjs` location.

## v1.16.1

### Added

- **`.gitignore` entry for `.planning/`** -- planning artifacts stay local.
- Documentation for vault librarian in README, changelog, help skill, agents guide, and configuration guide.

## v1.16.0

### Added

- **Vault librarian** -- a continuously running background agent that uses Gemma 4 E2B via ollama to maintain vault hygiene autonomously. Wanders the vault picking random notes, investigating orphans for missing links, flagging topic-style titles in inbox notes, and marking potentially stale claims. Queues observations for Claude to review via `/health --librarian`. Disabled by default; opt in via `/init` Phase 7 (requires ollama + 16GB+ RAM).
- **`ll-search link-stats`** subcommand -- queries the link graph for per-folder note counts, zero-inlink tallies, permanent-to-maps ratio, and optional orphan path listing. Used by the librarian and exposed via `vault-search.mjs link-stats`.
- **`/health --librarian`** mode -- two-phase review of librarian observations. Phase 1: approve/reject link suggestions and acknowledge voice flags. Phase 2: Claude investigates staleness suspects using source-resolver, web search, and vault graph walks.
- **`/health` Step 7.5** -- librarian queue summary in the dashboard when pending observations exist.
- **`/inbox` Step 1.5** -- surfaces librarian voice flags targeting inbox notes during triage.
- **`/init` Phase 7** -- librarian hardware detection and opt-in setup. Checks ollama, system RAM, model pull status.
- **`scripts/librarian.mjs`** -- continuous agent loop with ollama `/api/chat` tool calling (10 tools), mechanical staleness regex, visited state tracking, queue cap management.
- **`scripts/lib/librarian-queue.mjs`** -- append-only JSONL queue + `state.json` for librarian observations. 30-day and mtime-based expiry.
- **`scripts/lib/librarian-tools.mjs`** -- tool definitions and executor for the ollama agent (find_similar, search_vault, get_inlinks, get_outlinks, read_note, submit_link, submit_voice_flag, submit_suspect, and more).
- **Watch integration** -- `ll-search watch --librarian-script <path>` spawns and manages the librarian as a child process. Explicit kill on watcher shutdown prevents orphaned processes.
- **Librarian config** in `config.json` -- `enabled`, `model`, `pace_seconds`, `queue_cap`, `ollama_url` (all with sensible defaults, disabled by default).

## v1.15.9

### Added

- **Background reindex on Stop** (`hooks/post-stop-reindex.js`). After each turn the Stop hook spawns a detached `ll-search index` so the vector index is fresh for the next `UserPromptSubmit` retrieval. Returns immediately. A lockfile in `os.tmpdir()` (with PID + timestamp + 10 min staleness window) prevents overlapping runs across turns or sessions. `stdio: 'ignore'` keeps the spawn cross-platform-safe — file-descriptor inheritance with `detached: true` does not let the child outlive the parent on Windows.
- **`guide/cross-platform.md`** — supported platforms, known caveats per OS, and the verified-vs-untested matrix.

### Fixed

- **`findEpisodicBinary()` now appends `.exe` on Windows.** Previously returned a Unix-style path on every platform; episodic backend resolution silently failed on Windows.
- **`resolveConfig` strips UTF-8 BOM** before parsing `config.json`. Notepad and some VS Code configurations write BOM-prefixed UTF-8; without stripping, `JSON.parse` threw `SyntaxError: Unexpected token` at position 0.
- **`scripts/download-binary.mjs` zip extraction.** The `.zip` (Windows) artifact was being extracted with `tar -xf`, which only works on Windows 10 1803+. Added fallback chain: tar → PowerShell `Expand-Archive` (Windows) → `unzip` (POSIX).

### Changed

- **`injection_threshold` is now configurable** via `config.json` or `LEARNING_LOOP_INJECTION_THRESHOLD` env var (default `0.35`). The hardcoded `0.65` shipped in v1.15.0 was unreachable in practice — bge-small-en-v1.5 cosine similarities on real prompts sit in the 0.15-0.45 band.
- **`guide/configuration.md`** documents the new env vars (`LEARNING_LOOP_INJECTION_THRESHOLD`, `LEARNING_LOOP_INJECTION_MODE`, `LL_REINDEX_DEBUG`) and the eleventh hook.

## v1.15.8

### Fixed

- **Injection pipeline crash on every gate-pass** (`hooks/session-label.js`). `buildInjection` reads `top.body` to truncate the vault snippet, but `ll-search query` returns `{path, score, title, mtime}` with no body field. Every gate-pass since v1.15.7 (when parseVault started returning real hits) crashed with `Cannot read properties of undefined (reading 'length')`. Hook now reads each hit's body from disk after the search returns, strips frontmatter, and skips hits where the file is unreadable.

## v1.15.7

### Fixed

- **`parseVault` envelope discard** (`hooks/lib/inject.mjs`). The function called `JSON.parse(stdout)` and stored the whole result as `hits`, but `ll-search query` returns a `{meta, results}` envelope. `hits.length` returned `undefined`, every vault hit was silently dropped, and `review-shadow` reported "0/941 passed gate — delete the branch" because the instrument was broken, not the feature. Now coerces to `parsed.results || []`.
- **Injection gate threshold lowered to 0.35** (`hooks/session-label.js`). The 0.65 default was never validated against real score distributions and was unreachable. Configurable via `LEARNING_LOOP_INJECTION_THRESHOLD` env var or `config.json:injection_threshold`. Threshold is also now logged in shadow records for post-hoc tuning.

## v1.15.6

### Fixed

- **SessionStart cache pruner no longer deletes newer plugin versions.** The hook prunes stale `plugins/cache/.../<version>/` directories so they don't accumulate forever. The previous logic kept exactly one version (its own) and deleted everything else, which is wrong when a stale Claude Code process re-fires an old hook (e.g. after `/reload-plugins` post-marketplace-update): the old hook would delete the just-installed newer version, and the next session had no cache to load. Switched to numeric semver comparison so only versions strictly older than the running hook are pruned. Also fixes the latent string-compare bug where `'1.9.0'` would be considered newer than `'1.10.0'`.

## v1.15.5

### Fixed

- **SessionStart incremental indexing no longer silently drops large deltas.** The hook ran `ll-search index` as a blocking `execFileSync` with a 5 s timeout and `stdio: 'ignore'`. With ~50 ms per note to embed (bge-small q8 CPU), any session-to-session delta above ~30 notes exceeded the budget, got SIGKILL'd mid-embedding loop, and since the indexer only opens its SQLite transaction after the full embed batch completes (`native/src/db/index.rs:153-218`), zero progress persisted. The next session rediscovered the same (now larger) delta and failed again — backlog compounded silently until a manual `ll-search index` was run. Swapped to detached `spawn(..., { detached: true }).unref()`, matching the pattern Stop already uses. Session start no longer blocks on indexing, and the indexer runs to completion in the background regardless of delta size.

## v1.15.4

### Changed

- **cache-health statusline plugin: quiet by default.** The first cut rendered `cache NN%` every turn, which was decorative noise -- individual turns are 99%+ in practice and the rounding meant the display never dropped below 100%. Reworked to render only when something is wrong.
- **Rolling window.** Hit rate is now computed over the last 10 post-warmup turns, not lifetime. Sustained degradation shows up quickly; transient busts self-heal out of the window.
- **Warmup suppression.** The first 5 turns of a session are excluded from the window and from display. Initial turns always have a low lifetime hit rate as the cache is being built -- showing that as "bad" was noise.
- **Instant bust alerts.** Any turn where `cache_read == 0` shows `cache bust (N)` in red on the turn it happens, regardless of warmup state. Bust counter persists across subsequent degradation displays (e.g. `cache 89% 2b`).
- **JSONL schema extended.** Records now carry `turn`, `turn_hit_rate`, `window_hit_rate`, `lifetime_hit_rate`, and `session_busts` so the report tool can analyse windowed vs lifetime behaviour. Previous `hit_rate` field still read as fallback for backwards compatibility.
- **Default thresholds** tuned against real session data: `warnAt: 95`, `criticalAt: 85`, `windowSize: 10`, `warmupTurns: 5`. Healthy sessions in the wild sit at 99%+; observed degraded sessions hit 89-97% aggregate.

## v1.15.3

### Added

- **`ll-search identity`** subcommand -- loads or creates `PLUGIN_DATA/federation/.seed` and returns the raw 32-byte Ed25519 public key as base64 JSON. Used by init Phase 4 to extract the pubkey for the `interchange.live` redeem POST. Backwards compatible with existing seed files.

### Changed

- init Phase 4b now calls `ll-search identity` directly instead of relying on improvised shell commands for key generation and extraction.

## v1.15.2

### Added

- **Cache-health oh-my-claude plugin** (`plugins/omc-cache-health/plugin.js`) -- logs per-turn cache metrics (`cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`) from the Claude Code statusline payload to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl` and displays `cache NN%` in the statusline. Dedupes by session_id + token counts to avoid duplicate rows when the statusline fires multiple times per turn.
- **`scripts/cache-health-report.mjs`** -- summarises the JSONL with weighted hit rate, percentile distribution (p50/p25/p10), per-session breakdown, and zero-hit event listing. Supports `--session <id>` and `--month YYYY-MM` filters.
- **`scripts/install-cache-health.mjs`** -- idempotent installer. Copies the plugin file to `~/.claude/oh-my-claude/plugins/cache-health/`, inserts `cache-health` into `~/.claude/oh-my-claude/config.json` under the first line's `left` column (after `context-percent`), and adds a default plugin config. `--check` for dry-run state, `--uninstall` to remove. Skips file copy when the target directory is a symlink (dev mode).
- **Init Phase 6: Cache Health Statusline** -- detects oh-my-claude and offers to install the cache-health plugin. Skips silently if oh-my-claude is not installed.

### Context

The statusline is the only channel Claude Code exposes per-turn token usage on -- hook events do not carry `current_usage`. This plugin captures the data as it arrives and persists it for later analysis. Useful for measuring the impact of context injection experiments on cache hit rate before and after flipping `injection_mode` to `live`.

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
