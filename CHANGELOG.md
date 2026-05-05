# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Breaking changes are marked **BREAKING**; entries that require user action after upgrade are marked **MIGRATION**.

## Unreleased

This batch addresses the verified P0/P1 findings from a multi-agent internal review of the plugin. No breaking changes for end users.

### Fixed

- **Edges DB lost-update race.** `scripts/lib/edges.mjs` exported `acquireLock`/`releaseLock` helpers that were never called. Concurrent `edges-cli add` invocations both opened the DB, mutated independently against the same in-memory snapshot, then raced on `saveDb`. The loser's edge was silently overwritten. Fix brackets the entire load+mutate+save lifecycle in one lock per write command (`add`, `remove`, `confirm`, `reject`, `super-add`, `super-remove`); read-only commands stay lock-free. Same pattern for `scripts/backfill-edges.mjs`. New `tests/edges-locking.test.mjs` covers same-process semantics and forks a second Node process to verify cross-process exclusion. Note: `hooks/modules/edge-infer.mjs` has the same gap and is captured as deferred follow-up #4a.
- **Federation peer-id path traversal.** `native/crates/ll-search/src/sync/client.rs:171` joined `peer.peer_id` (returned by the hub) into local FS paths with no validation. A malicious or buggy hub returning `../foo` could traverse outside the peers directory. New `is_safe_peer_id` helper restricts to ASCII alphanumeric + `-` + `_`, 1-128 chars; rejected peers are logged and skipped via `continue`. 4 unit tests cover valid IDs, traversal characters, length boundary, and unicode.
- **Secret scrubbing missed three formats.** `hooks/lib/inject.mjs` already covered AWS / GitHub PAT / Anthropic / Stripe / OpenAI / Cloudflare / Bearer. Added Slack tokens (`xox[abprs]-`), JWTs (three-segment base64url), and PEM private key blocks (multi-line lazy match including `RSA PRIVATE KEY` variants). Closes the most likely leak surface in the `would_inject` shadow log.
- **`/learning-loop:inbox` dispatched the wrong agent.** `skills/inbox/SKILL.md:44` told the orchestrator to use `subagent_type: "learning-loop:note-scorer"` when the surrounding prose said to launch `inbox-organiser`. Fixed.

### Changed

- **`scripts/release.sh` now gates on a non-empty `## Unreleased` section** before bumping. Refuses with an actionable error and reverts the manifest changes if no entries exist. On success, renames the heading to `## vX.Y.Z` and inserts a fresh empty `## Unreleased` stub above. Prevents the silent CHANGELOG drift seen when v1.17.1 shipped without a section. CHANGELOG is now committed alongside the manifests.
- **Lefthook pre-commit gates.** Adds `prettier --check` (scoped to `{hooks,scripts}/**/*.{js,mjs}` to match the CI lint job) and `npm test --silent` (scoped to `{hooks,scripts,tests,agents,skills,native}/**` so doc-only commits skip the ~5s suite). The existing `no-resolved-paths` grep is preserved.
- **All 14 agent definitions now declare `name:` in frontmatter** so they resolve via `subagent_type: "learning-loop:<name>"` deterministically rather than relying on filename fallback. Dead `capabilities:` field (silently ignored by Claude Code) removed from each. Closes a tracked TODO from 2026-04-09.
- **`agents/diagram-rules.md` moved to `agents/_skills/diagram-rules.md`.** It is an include-only ruleset, never dispatched as an agent. Living in `/agents/` registered it as `learning-loop:diagram-rules` in the agent picker, which was misleading. References in `agents/note-writer.md`, `agents/discovery-researcher.md`, `skills/diagram/SKILL.md` updated to the new path.

### Removed

- **`scripts/apply-config.mjs`** (a 4-line `process.stderr.write` no-op deprecated since v1.4) and the `session-start.js` block that invoked it. The block also wrote a `.config-applied` marker that nothing else read; gitignore entry retained for older installs that still produce the file.

## v1.17.0

This release ships a structural refactor pass driven by an internal plugin review. No breaking changes for end users; the install flow gains a separate `/learning-loop:federation` skill.

### Added

- **`/learning-loop:federation` skill.** The full federation flow (identity, token redeem, Tailscale, visibility rules, sync test) is now a standalone skill. `/init` Phase 4 is reduced to a single yes/no question that hands off. Most installs do not need federation on first run, so the previous Phase 4 fragility (single-use tokens, contact-Robin recovery) no longer pollutes init.
- **Single-writer JSONL helper** at `scripts/lib/jsonl.mjs` (`appendJsonlLine`, `appendJsonlLineSafe`). Atomic up to PIPE_BUF on POSIX, fixes the Windows interleave that `fs.appendFileSync` silently allows when concurrent sessions write to the same file. Migrated callers: `hooks/lib/common.mjs` (provenance + retrieval), `hooks/post-tool.js` (hook errors), `hooks/session-start.js` (retrieval access log), `scripts/provenance.mjs`, `scripts/retraction-notify.mjs`, `scripts/vault-search.mjs`.
- **Hook-error counter.** `hooks/post-tool.js` appends silent module failures to `<plugin-data>/hook-errors-YYYY-MM.jsonl` so degraded autolink / edge-infer / provenance modules become observable instead of failing invisibly.
- **Windows .cmd shims.** `scripts/install-shims.mjs` now writes `ll-watch.cmd` and `ll-search.cmd` on `process.platform === 'win32'`. PowerShell's `[version]` sort handles semver ordering correctly. Mirrors the POSIX priority order (`%CLAUDE_PLUGIN_DATA%` → marker file → canonical default).
- **`/learning-loop:init` orchestrator.** Init now reads phase files from `skills/init/phases/0X-*.md` rather than inlining 636 lines of prose. Easier to edit one phase without touching the rest.
- **102 ll-search lib tests** (was 98) including 26 sync state-machine tests covering Ed25519 sign/verify roundtrip, envelope construction with sha256 binding, tampered-envelope rejection, all `SyncMessage` enum variants, hub message deserialisation, and `summarize`/frontmatter edge cases.
- **213 JS tests** (was 154): `tests/jsonl.test.mjs` (concurrency), `tests/semver.test.mjs` (cache-prune flagging), `tests/sweep-hook-replay.test.mjs` (regression guard for legacy hook filenames), `tests/snapshot-race.test.mjs` (two-process splice persistence), `tests/install-shims.test.mjs` (macOS smoke + best-effort Windows content check), 53 tests under `tests/sources/` covering each adapter contract and the citation-index lock.

### Changed

- **`scripts/source-resolver.mjs` split from 1560 lines to 141.** Ten API clients (PubMed, arXiv, CrossRef, Semantic Scholar, Europe PMC, OpenAlex, bioRxiv, DBLP, Unpaywall, RFC, Open Library, ChEMBL, PMC) now live as adapters under `scripts/lib/sources/adapters/*.mjs` with a uniform `{matches, search, fetch, verify}` interface. The `verifyNote` driver moved to `scripts/verify/verify-note.mjs`. Public CLI surface (`resolve`, `verify-pmid`, `verify-doi`, etc.) and the `__test__` export are unchanged.
- **`SearchContext` extracted** in `native/crates/ll-search/src/search/context.rs` (~300 lines). Owns embeddings + link graph + titles + mtimes + tags as a single struct. The four near-duplicate query pipelines in `query.rs` / `tune.rs` / `eval.rs` / `reflect.rs` now build the context once per pipeline (or once per query for the CLI). Multi-query callers (`tune_prf`, `eval_prf`, `reflect_scan`) reuse cached signal-loaders across the loop, materially cutting wall-clock per query.
- **`ll-core` `EmbeddingStore::get_by_id` is now O(1).** New `id_index: HashMap<i64, usize>` built at construction.
- **`scripts/release.sh` gates on `npm test` and `cargo test --workspace`** before tagging. `--skip-tests` escape hatch retained for emergency hotfixes.
- **Marketplace metadata fleshed out** (`homepage`, `license`, `keywords`, `categories`, fuller description, owner/author URLs).
- **CHANGELOG header** declares Keep-a-Changelog conformance.
- **`hooks/session-start.js` `syncSleep`** replaced its busy-loop with `Atomics.wait` on a `SharedArrayBuffer` so the daemon-spawn probe stops melting a CPU core.
- **`hooks/pre-write-check.js` no longer recurses the vault per Write.** Uses the existing snapshot cache instead of a fresh `readdirSync` of all six vault folders.
- **Hardcoded `learning-loop-learning-loop-marketplace` literal removed** from 5 skill files. Replaced with `node $CLAUDE_PLUGIN_ROOT/scripts/resolve-paths.mjs PLUGIN_DATA` so a marketplace rename or republish doesn't break the plugin-data fallback.
- **Em-dashes purged** from skills/ and agents/ markdown (vault rule applied to the plugin's own prompts).

### Fixed

- **Snapshot writes race across concurrent sessions.** `hooks/lib/snapshot.mjs` `maybeSplice` and `removeFromSnapshot` previously rewrote the on-disk snapshot without a lock, so two sessions splicing different notes would clobber each other (one splice lost until the next 30-second rebuild). Now wrapped in a PID-tracked file lock with stale-lock detection. New `tests/snapshot-race.test.mjs` forks two child processes and asserts both splices land.
- **Citation-index unlocked write race.** `scripts/lib/sources/citation-index.mjs` (extracted from source-resolver) now uses the same file-lock pattern plus an in-process promise queue so concurrent `verifyNote` calls no longer corrupt the JSON. `verify-note.mjs` correctly awaits the queue before reading the index for cross-vault duplicate detection.
- **24 `.unwrap()` calls inside the `db/index.rs` reindexing transaction** converted to `?` propagation. Reindex now returns `anyhow::Result<IndexResult>` instead of panicking on transient SQLite errors. Callers in `main.rs` and `sync/watch.rs` updated.
- **Orphan-detection SQL incorrectly classified ~8% of vault notes as orphans.** Two distinct bugs in `db/query.rs:380-388` and `:413-422`: (a) the `REPLACE(REPLACE(... INSTR()))` chain only stripped the first folder, so `2-literature/sub/note.md` produced stem `sub/note` and never matched `target_path = "note"`; (b) `target_path` is stored lowercased but `n.path` is case-preserving, with no `LOWER()` in the SQL. Replaced with a Rust-side set-difference computation that handles both correctly. 6 new tests cover depth-1 through depth-3 paths plus case-mismatch.
- **`hooks/post-tool.js` module errors** were swallowed silently unless `LL_HOOK_DEBUG=1` was set. Now appended to `hook-errors-YYYY-MM.jsonl` regardless, so `/health` can surface degraded modules.
- **`scripts/sweep-hook-replay.mjs`** invokes `hooks/post-tool.js` (the v1.16.10 dispatcher) instead of the long-deleted per-hook files. Released in v1.16.13 but the regression test guarding against re-introducing the legacy filenames is in this release.
- **Two `findBinary` implementations** consolidated. `hooks/lib/common.mjs::findBinary` now delegates to `scripts/lib/binary.mjs::binaryPath` while preserving the `{bin, binDir}` return shape needed by ORT env-var callers.

### MIGRATION

No user action required. Federation users who previously ran `/learning-loop:init` to rotate seeds should now use `/learning-loop:federation` (the redirect is documented in `guide/federation.md` and the seed-version notice in `hooks/session-start.js`).

## v1.16.13

### Fixed

- **`scripts/sweep-hook-replay.mjs` was broken since the post-tool dispatcher consolidation in v1.16.10.** It still shelled out to `post-write-autolink.js` and `post-write-edge-infer.js`, which had been merged into `hooks/post-tool.js`. The script silently failed (non-zero exit) on every replay, leaving subagent-written notes without structural backlinks and typed edges. Replaced the per-hook loop with a single `post-tool.js` invocation, updated the doc comment and help text. Also gitignored `native/crates/*/spikes/` for spike scratch directories.

## v1.16.12

### Fixed

- **Auto-started watcher never spawned the librarian.** `hooks/session-start.js` spawns `ll-search watch` directly when no watcher is alive, but it was missing the `--librarian-script` flag that the manual `ll-watch` CLI passes. The Rust binary only forks the librarian Node child when that flag is set, so every session-auto-started daemon ran without librarian tasks (voice gates, tag suggestions, duplicate detection, link investigations), gemma4:e2b sat idle except in sessions where the user manually ran `ll-watch`. Hook now mirrors the CLI: appends `--librarian-script <PLUGIN>/scripts/librarian.mjs` when the script exists. Librarian itself short-circuits cleanly if `librarian.enabled=false` in config, so the flag is safe to pass unconditionally.

## v1.16.11

### Fixed

- **Schema-v3-to-v4 intentions backfill was silently a no-op for unchanged notes.** The schema-upgrade trigger sets `notes.mtime = 0` to force the indexer to re-walk every file, but the reindex loop only writes intentions in the `to_embed` path. Notes whose content hash matches the existing row fall through to `to_update_mtime`, which only updated mtime — intentions were never written. So the entire intentions migration was empty for any v3 DB where most note bodies hadn't changed. Reindex now also writes intentions on the mtime-only path, reusing the already-computed `result.intentions` from preprocess. Verified by resetting all 4,129 mtimes on a real vault and re-running index: 1,269 intentions backfilled in 1.6 s, 0 re-embedded.

## v1.16.10

### Fixed

- **Multi-session filesystem pile-ups under parallel Claude Code sessions.** Per-Write hot path opened a node process for each of three hooks (autolink, edge-infer, provenance), each walking the vault to build a basename→path index and stat'ing every `.md` file. With N sessions writing concurrently, file-descriptor and inode pressure climbed fast enough to trigger `EMFILE` ("too many open files") within seconds of starting `ll-watch`. The fix is daemon-centric: the Rust `ll-search watch` daemon owns vault indexing exclusively, JS hooks consult an on-disk vault-snapshot cache instead of walking, and the three Write/Edit hooks coalesce into one `post-tool.js` dispatcher.

### Changed

- **Daemon DB path aligned.** `scripts/watch.mjs` and `hooks/session-start.js` now spawn the daemon against `VAULT/.vault-search/vault-index.db` (the same path JS hooks read), eliminating the three-way split-brain where the daemon wrote to `PLUGIN_DATA/retrieval/search.db`, hooks read `vault-index.db`, and federation read a third copy. ORT env (`ORT_DYLIB_PATH`, `ORT_LIB_LOCATION`) is now passed to both foreground and detached spawns.
- **Daemon hardened against concurrent spawn.** `PidGuard::new` uses `OpenOptions::create_new` with bounded retry on empty/stale PID files, so racing session-start invocations cannot both win. The daemon also writes `watch.version` next to `watch.pid` on start (and removes both on Drop), which lets the spawn protocol detect a running-but-out-of-date daemon and SIGTERM-replace it on plugin upgrade.
- **Periodic 5-min mtime-diff resync** as an FSEvents safety net — recovers from missed events after sleep/wake or watcher hiccups without forcing a full rebuild.
- **`PRAGMA busy_timeout = 5000`** so the daemon and short-lived JS readers don't abort on transient WAL contention.
- **Auto-spawn from `session-start.js`** with a four-state liveness probe (alive / dead / corrupt / writer-in-progress / missing), `watch.version` comparison for upgrade-replace, and an outer `wx`-flag lock-marker that prevents a thundering-herd of hook invocations all racing to spawn.
- **Vault-snapshot cache (`hooks/lib/snapshot.mjs`).** New on-disk JSON snapshot at `PLUGIN_DATA/vault-snapshot.json` (v1, 30s TTL) caches every `.md` path under `0-inbox`/`1-fleeting`/`2-literature`/`3-permanent`/`4-projects`/`5-maps`/`Excalidraw`. Hooks build basename→path indexes from the snapshot instead of walking the vault on every Write. Atomic-rename writer with PID-suffixed temp files; `maybeSplice` adds new entries on the fly without rebuild.
- **Coalesced post-tool dispatcher.** `hooks/post-tool.js` reads stdin once, builds a shared `ctx` (with snapshot loaded once for the turn), and dispatches to extracted modules `runAutolink`/`runEdgeInfer`/`runProvenance` from `hooks/modules/`. Replaces three separate node spawns per Write event with one.
- **`scripts/lib/edge-classifier.mjs`** drops the redundant `statSync` per directory entry — `Dirent.isFile()` already carries that information from a single `readdirSync({withFileTypes: true})` call.
- **Intentions in SQLite (schema v4).** New `intentions` table populated by the indexer's reindex transaction, with `idx_intentions_context` and orphan cleanup. The indexer pulls intentions from frontmatter via a new `parse_intentions` parser supporting block-array, inline-array, and legacy `"context — cue"` flat-string forms. New `ll-search intentions <db> [<context>]` subcommand (summary mode groups by context, detail mode joins notes). `scripts/vault-search.mjs intentions` now shells out to the CLI instead of walking the vault and regex-parsing frontmatter.

### Removed

- `hooks/post-write-autolink.js`, `hooks/post-write-edge-infer.js`, `hooks/post-tool-provenance.js`, `hooks/post-stop-reindex.js` — superseded by the coalesced `post-tool.js` dispatcher.

### Migration

- `/learning-loop:init` now best-effort deletes orphan `search.db` files (plus `-shm`/`-wal` siblings) at `PLUGIN_DATA/retrieval/search.db`, `PLUGIN_DATA/search.db`, and `PLUGIN_DATA/db/search.db`. No user action required.
- Existing v3 databases backfill the new intentions table on first reindex (the schema upgrade resets `mtime` to 0 to force re-walk).

## v1.16.9

### Added

- **Two new vault-librarian classifiers** running as single structured-output calls against gemma4:e2b. **Tag suggester** runs on notes with 0–1 tags and proposes up to 2 vocabulary-bounded tags per note (vocabulary built from existing vault tags, frequency-curated, top 60, structural categories excluded). Manual precision on a 40-note sample: 0.78 strict / 0.84 charitable. **Duplicate detector** runs on every visited note, comparing against three nearest neighbours from `ll-search similar` with 500-char body context per side, emitting a 3-way enum (`duplicate`/`same_topic`/`unrelated`). Both follow the established `voiceCheck` pattern — pre-fetched context, single `format=` schema call, no tool-use loop. New queue task types: `tag_suggestion`, `duplicate_flag`. New state counters: `tag_suggestions`, `duplicate_flags`. New submit functions in `scripts/lib/librarian-tools.mjs`. 15 new tests in `tests/tag-classifier.test.mjs` and `tests/duplicate-classifier.test.mjs`.

### Changed

- **`noteNeedsInvestigation` returns an array of tasks** (`link_check`, `voice_gate`, `tag_suggest`, `duplicate_check`) instead of a single value. Each note can trigger multiple tasks per visit; the main loop dispatches each in turn.
- **`/health --librarian` review mode** (Step L2) renamed to "Phase 1 — Advisory Review" with subsections for tag suggestions (apply by merging into the target's frontmatter `tags:` field) and duplicate flags (per-item `merge` / `link` / `dismiss` choice). Step 7.5 dashboard groups all five task types.
- **`/inbox` Step 1.5** now surfaces voice flags, tag suggestions, and duplicate flags for inbox notes during triage (was voice flags only).
- **Doc updates**: `skills/help`, `guide/agents`, `guide/configuration` describe the new classifiers and queue task types. `guide/agents` reflects that link investigation runs as a tool-use loop while voice/tag/duplicate run as single structured-output calls.

### Fixed

- **`getPluginData` / `resolvePluginData` no longer stomp the data-path marker with temp paths.** The previous implementation wrote `$CLAUDE_PLUGIN_DATA` to `~/.claude/plugins/data/.ll-data-path` on every call. Tests that set the env var to a `tmpdir()` path persisted that path into the marker; once the test cleaned up its temp dir, shell-only `ll-search` invocations (which fall back to the marker) hit "binary not found" until the next real Claude Code session re-stamped the marker. Both functions (`scripts/lib/config.mjs` and `hooks/lib/common.mjs`) now skip the write when the path looks transient (`tmpdir()`, `/tmp/`, `/var/folders/`, `/private/var/folders/`) and skip redundant writes when the marker already matches. New regression test: `tests/plugin-data-marker.test.mjs` (4 cases).

### Added

- **`ll-search` CLI shim** -- a stable shell script at `~/.local/bin/ll-search` that resolves `PLUGIN_DATA` from `$CLAUDE_PLUGIN_DATA` or the saved `~/.claude/plugins/data/.ll-data-path` marker, then exec's the binary at `$PLUGIN_DATA/bin/ll-search` with `ORT_DYLIB_PATH` and `ORT_LIB_LOCATION` set to the binary's directory (matches `scripts/lib/binary.mjs`). Survives plugin updates because the binary lives in `PLUGIN_DATA`, not in the plugin cache. Fixes the "command not found" failure mode for the `ll-search` invocations in `skills/init/SKILL.md`, `agents/_skills/promote-gate.md`, and other places that assumed `ll-search` was already on `PATH`.
- **`scripts/install-shims.mjs`** -- canonical multi-shim installer. Writes both `~/.local/bin/ll-watch` and `~/.local/bin/ll-search`. Supports `--install` (default) and `--check`. The SessionStart hook auto-runs `--install` whenever either shim is missing.

### Changed

- **`scripts/watch.mjs --install`** now delegates to `install-shims.mjs --install` so the legacy invocation still works and writes both shims.
- **`hooks/session-start.js`** auto-install path now writes both shims (was: `ll-watch` only).
- **`skills/reflect/SKILL.md`** and **`skills/ingest/SKILL.md`** -- the post-batch sweep block dropped its inline `LL_BIN=…` resolution (which silently fell back to a version-pinned dev-build path) and now calls `ll-search index …` directly via the shim.
- **`skills/init/SKILL.md`** Phase 3d -- renamed from "Install ll-watch CLI" to "Install CLI shims"; documents both shims and instructs running `install-shims.mjs --install`. The dashboard line in Phase 1 and the post-init summary now show both shims.

### Added

- **Overclaim mitigation, Tracks A+B.** Verify finding "overclaim" was 44% of all flags but the existing `check-claims` script only fired for PMID/DOI/arXiv sources — silent on the ~90% of vault notes that cite docs/blogs/vendor pages. Two-track fix: (a) `agents/_skills/capture-rules.md` adds a "Claim Shapes Requiring Verbatim Anchoring" section enumerating four write-time-checkable shapes (numerical figures, universal claims, named attributions, strengthened hedges) with per-shape rules, and a new `[not in source]` inline marker; `agents/note-writer.md` Pass 1 verification now walks the note for each shape before emit. (b) `scripts/source-resolver.mjs check-claims` extends to non-academic URLs by fetching and stripping page HTML (`fetchPageText`), with a `WEB_FETCH_BLOCKLIST` for paywalled/PDF domains (sciencedirect, springer, doi.org, etc). Output now includes `source_kind: "abstract" | "page"` and the source `url`. `agents/_skills/source-verification.md` updated to reflect both source kinds and the new marker. Track C (regex shape audit) deferred pending next provenance report.

## v1.16.7

### Added

- **`ll-watch` CLI** -- a single command to start, stop, and check the vault watcher. Replaces the multi-argument `ll-search watch` invocation. Installed automatically on first session start or via `node scripts/watch.mjs --install`. The shim resolves the latest plugin cache version at runtime, so it survives plugin updates.

### Fixed

- **Stop-nudge false positives from concurrent sessions.** Memory snapshot files were written to a single global tmp path, so concurrent Claude Code sessions overwrote each other's baselines. The stop hook then compared against the wrong snapshot and reported phantom memory file creation. Snapshot and session ID files are now keyed per session.

## v1.16.4

### Fixed

- **Null-path crash in unconfigured environments.** `constants.mjs` called `join(null, ...)` when `VAULT_PATH` or `PLUGIN_DATA` was unset, crashing every consumer at import time. `DB_DIR`, `DB_PATH`, and `BIN_DIR` now resolve to `null` when their parent is missing.
- **Session-start hook crash when `pluginData` is null.** Sections 7.5 (learned patterns) and 7.6 (federation status) called `join(pluginData, ...)` without a null guard, crashing the entire session-start hook and leaving sessions with no learning-loop context.
- **Edge inference silent no-op on Windows.** `isVaultNote` in `post-write-edge-infer.js` checked `rel.startsWith(d + '/')` with a hardcoded forward slash, but `rel` uses the platform separator. Changed to `sep`.
- **Watch mode cannot exit on Windows.** The `stopped` AtomicBool was only set by Unix signal hooks. Added `ctrlc` crate for cross-platform Ctrl+C handling so the PID guard runs cleanup and the librarian subprocess is not orphaned.
- **Content hash non-deterministic across Rust versions.** `DefaultHasher` is explicitly not stable across compilations, causing a full vault re-embed on every binary update. Replaced with truncated SHA-256 (deterministic, uses existing `sha2` dependency). First run after this update will re-embed once.
- **`/init` Phase 5 version detection broken.** `templates/claudemd-section.version` was referenced by the init skill but never created.

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
