# cross-cutting conventions

Conventions that apply across Rust and JS: versioning, performance budgets, observability, concurrency, and drift prevention. Read `docs/baseline/rust.md` and `docs/baseline/plugin.md` for language-specific rules.

*Phase status: Phase 0 codifies these rules. Phase 1 adds the enforcement gates that make violations CI failures. `ARCHITECTURE.md` has the full repo map and data-flow diagrams.*

---

## versioning and release

### ll-core

- Semver strict. `0.1.x` for additive-only changes within the current refactor (phases 0 and 1).
- Deprecation cycle: at least one minor version with `#[deprecated]` before removal. Track 1G adds deprecation markers to the clone-based accessors. Track 2R removes them and publishes `0.2.0` to crates.io.
- No API removals in `0.1.x`. The `-D missing_docs` gate lands in phase 1 once all 54 items are documented (track 0A).
- Decision F1 (`.planning/refactors/baseline-2026-05-11.md`): the workspace `Cargo.toml` version (drifted to `1.17.3`) resets to `0.1.4` in track 0A. ll-core stays on `0.1.x` until the single `0.2.0` publish at the end of phase 2.

### ll-search

- Distributed with the plugin; versions together with it.
- Not published to crates.io. No separate semver contract.
- Daemon protocol is version-tagged in the WebSocket handshake (see `sync/protocol.rs`).

### plugin

- Existing CHANGELOG cadence: bump on every PR touching `hooks/` or `scripts/`.
- Semver minor for new hooks or new `scripts/lib/` exports. Semver patch for bug fixes.
- Plugin version and ll-search binary version must match. CI checks `package.json` version against binary `--version` output.

---

## performance budgets

Criterion benchmarks (Rust) and a hook bench harness (JS) track these. Track 0E establishes baselines; phase 1 gates turn soft warnings into hard CI failures.

| Path | p50 | p95 | Memory ceiling | Enforced from |
|---|---|---|---|---|
| ll-search query (cold) | 80 ms | 150 ms | 200 MB RSS | Phase 1 (after track 1E bench) |
| ll-search query (warm) | 20 ms | 50 ms | 200 MB RSS | Phase 1 |
| `session-start.js` total | 200 ms | 500 ms | n/a | Phase 1 |
| `post-tool.js` total | 50 ms | 150 ms | n/a | Phase 1 |
| `pre-write-check.js` total | 30 ms | 80 ms | n/a | Phase 1 |

"Cold" means a fresh daemon with no cached SearchContext. "Warm" means AppState and SearchContext are cached (available after track 1E).

Budgets are parameterized by vault size:
- Small: <1k notes
- Medium: 1k-10k notes (primary target)
- Large: 10k-50k notes (tracked, not gated until phase 2)

Criterion regression gate: a PR that increases `p50` by >15% on the medium fixture is a build failure from phase 1 onward. Before phase 1, it's a warning.

---

## observability

### Rust: `tracing`

Use the `tracing` crate. Structured fields only, not string interpolation.

**Good:**

```rust
tracing::debug!(path = %note_path, candidates = candidates.len(), "ranked");
```

**Bad:**

```rust
eprintln!("ranked {} candidates for {}", candidates.len(), note_path);
```

`eprintln!` is reserved for startup errors in `main.rs`. Everywhere else, `tracing`. The daemon respects `RUST_LOG=ll_search=debug` for verbose output.

### JS: `log.mjs`

Use `logError(scope, err)` from `scripts/lib/log.mjs`. It writes to stderr, gated on `LL_HOOK_DEBUG=1`:

```js
import { logError } from '../lib/log.mjs';
try {
  await doSomething();
} catch (err) {
  logError('session-start:daemon', err);
}
```

Do not use `console.error` or `console.log` directly in hook or script code. Hook stdout is read by Claude Code as structured JSON; any non-JSON write corrupts the response.

### provenance

Every hook fires one provenance line per invocation. The emit goes through `provenance-emit.js`. This is a fixed contract; don't skip it. Track 2N adds per-line checksums to the provenance JSONL so corrupted lines are detectable.

### debug flags

| Flag | Effect |
|---|---|
| `LL_HOOK_DEBUG=1` | Enables `logError` stderr output in hooks and scripts |
| `RUST_LOG=ll_search=debug` | Enables `tracing::debug!` output in ll-search daemon |
| `--pretty` | (ll-search CLI flag, track 2L) switches daemon output from compact to pretty-printed JSON |

---

## concurrency

### file-lock primitive (Rust and JS)

Both runtimes have the same locking contract:

- Acquire: `openSync(O_CREAT | O_EXCL | O_WRONLY)` (JS) / `OpenOptions::new().write(true).create_new(true).open(path)` (Rust)
- PID written to lock file for debugging
- On acquire failure: exponential backoff, max 5 retries, then propagate error
- On release: `unlink` the lock file

**In JS:** `withLock(path, async fn)` from `scripts/lib/file-lock.mjs` is the only way to take a lock. The inventory confirmed 9 distinct lock implementations with mixed safety profiles (`.planning/inventory/plugin-patterns.md:223-253`). After track 1I, all go through `file-lock.mjs`.

**In Rust:** No shared file-based lock primitive exists yet. Individual modules open lock files ad-hoc. Track 2N adds a shared Rust primitive aligned with the JS API.

### atomic-write pattern

Non-lock persisted files (snapshots, config, cache) use tmp-then-rename:

1. Write to `path.tmp`
2. `fsync` the file descriptor
3. `rename(path.tmp, path)` -- atomic on POSIX

Violations confirmed at `hooks/session-start.js:115` (update cache write direct) and `hooks/session-start.js:476` (session memory snapshot to `/tmp` direct) (`.planning/inventory/plugin-patterns.md` §4). Track 1I fixes both. All new write code must use the atomic pattern.

### SIGTERM drain

The ll-search daemon handles SIGTERM by:
1. Setting a shutdown flag
2. Draining in-flight search requests (up to 5 seconds)
3. Flushing any pending provenance events
4. Exiting cleanly

The watch daemon (JS) follows the same pattern: SIGTERM sets a flag, pending tasks are flushed with a 5-second timeout, then `process.exit(0)`. Track 1H implements this drain for the librarian daemon.

---

## drift prevention

After phase 2, these artefacts exist in the repo and enforce the conventions above:

1. `docs/baseline/{rust,plugin,cross-cutting}.md` -- this set of documents.
2. `CONTRIBUTING.md` -- links to baselines + PR checklist.
3. `ARCHITECTURE.md` -- module map and data-flow diagrams.
4. `.github/workflows/baseline.yml` -- executable contract; every rule in Part 1 of `.planning/refactors/baseline-2026-05-11.md` has a check. This file does not exist yet; track 1I creates it.
5. `scripts/audit-baseline.mjs` -- quarterly drift detector. Diffs the current codebase state against the committed baseline artefacts and reports new violations. Intended for use as a cron job or pre-release check.

### quarterly audit script

Run after major merges or quarterly, whichever comes first:

```bash
node scripts/audit-baseline.mjs
```

Expected output: a diff of current state vs. committed baseline, grouped by rule. Zero-diff is the target. Any new violations are tracked as issues before the next release.

### when to update these docs

Update these documents when:
- A convention changes because a better approach was found (update the rationale).
- A new subsystem is added that the existing rules don't cover.
- A CI gate is added or upgraded (update the "Lands in" column).

Do not update these documents to retroactively justify a shortcut. The purpose of the baseline is to make the intended standard visible.

---

## error handling across layers

### plugin errors

Errors that occur inside a hook must not crash the hook process. Hooks use `process.exit(0)` on failure to avoid blocking Claude Code. The error gets logged via `logError(scope, err)` so it surfaces in debug mode.

For errors that should block an action (duplicate note in `pre-write-check.js`), exit 1 with a structured JSON response:

```js
process.stdout.write(JSON.stringify({
  ok: false,
  reason: 'near-duplicate',
  similarity: 0.93,
}));
process.exit(1);
```

### Rust errors

ll-core uses `anyhow::Result` at baseline. Track 0A introduces `thiserror`-derived errors. The migration is additive: new errors use the typed enum; existing callers use `anyhow::Error` until track 1G converts them. See `docs/baseline/rust.md` for the ll-core typed error convention.

ll-search errors that reach `main.rs` are logged via `tracing::error!` and cause the daemon to return a structured JSON error on stdout:

```json
{"error": "embed:model_not_loaded", "msg": "embedding model failed to initialize"}
```

The plugin receives this and logs it via `logError`. The search call returns an empty result set rather than crashing.

---

## data validation

### Rust

SQLite query parameters are always `?1`, `?2` etc. Do not use `format!` to build SQL with user-controlled values. The two known exceptions in the codebase (`db/schema.rs:167`, `db/query.rs:448`) use enum-controlled table names and integer IDs respectively -- low risk but tracked for phase 1F cleanup. See `.planning/inventory/rust-audit.md` §3.

### JS

All JSON read from disk goes through `safeLoad` (after 0C). All user-controlled values inserted into file paths are sanitized with `path.basename` or validated against an allow-list before use. No `eval` or dynamic `require`.

---

## naming conventions

### files

- Rust: `snake_case.rs` for modules.
- JS: `kebab-case.mjs` for scripts and lib. `kebab-case.js` for hook entry points (Claude Code requires `.js` at entry).
- Tests: `<module-name>.test.mjs` for JS, `<module_name>.rs` for Rust integration tests.

### symbols

- Rust: follows standard Rust conventions (`PascalCase` types, `snake_case` functions, `SCREAMING_SNAKE_CASE` constants).
- JS: `camelCase` functions, `PascalCase` classes, `SCREAMING_SNAKE_CASE` constants.
- Config keys: `snake_case` in `config.json`.
- Env vars: `SCREAMING_SNAKE_CASE`, prefixed with `LEARNING_LOOP_` for plugin-specific vars.

---

## release checklist

Before publishing ll-core `0.2.0` (track 2R):

1. `cargo semver-checks -p ll-core` -- confirms only additive changes since 0.1.3.
2. `cargo test --workspace` -- all tests green.
3. `cargo doc --no-deps -p ll-core` -- no missing docs warnings.
4. `cargo audit` -- no known vulnerabilities.
5. Review `ort` version -- aim to be on a stable release before publishing.
6. Update `CHANGELOG.md` with all changes since last publish.
7. Tag `ll-core-v0.2.0` in git before `cargo publish`.

For plugin releases, bump `package.json` version, update `CHANGELOG.md`, and ensure the ll-search binary version matches.

---

## migration patterns

### SQLite schema migrations

Migrations run at daemon startup in `db/schema.rs`. Each migration:
- Is a numbered SQL file: `db/migrations/NNNN_description.sql`.
- Is idempotent: safe to run twice.
- Includes a rollback comment at the top.
- Is registered in the migration array in `db/schema.rs`.

After adding a migration, run:

```bash
cd /Users/robin/brain/learning-loop/native
cargo test -p ll-search migration_
```

### plugin data migrations

When the shape of a persisted JSON file changes (config.json, state.json), the plugin migrates old data at load time. Migration logic goes in the `safeLoad` wrapper (after 0C) or in a dedicated `migrate-<name>.mjs` script. Never silently overwrite old data -- log and preserve.

---

## security notes

### auth seed

Track 2K (shipped) moves the federation auth seed off `federation/.seed` (plaintext 32 bytes, mode 0600) into the OS keyring (macOS Keychain, Linux Secret Service) with an encrypted-at-rest fallback for headless installs. The plaintext file is migration-source only; run `ll-search migrate-seed` to upgrade. See the "Federation seed storage" section below for backend details.

### vault path exposure

The vault path is a user-specific local path. Do not log it at info level. Do not include it in provenance events that might be synced to peers. The federation visibility filter (`sync/visibility.rs`) strips private paths before export.

### env vars

`LL_HOOK_DEBUG=1` enables verbose logging to stderr. Do not set it in production or leave it in `.env` committed to the repo. It may expose vault paths and embedding details in hook output.

---

---

## Federation seed storage

The federation Ed25519 signing seed is stored in one of three backends, probed in order:

| Backend | When used | File |
|---|---|---|
| `keyring` | macOS (always), Linux desktop with DBus | OS keyring, no file |
| `encrypted` | Linux headless, WSL, CI | `federation/.seed.enc` (64 bytes) |
| `plaintext-legacy` | Pre-2K installs (migration source only) | `federation/.seed` |

### Encrypted-at-rest layout

```
offset  bytes  meaning
0       4      magic = b"LLS1"
4       12     nonce (random per write)
16      48     ciphertext (32-byte seed + 16-byte poly1305 tag)
total: 64 bytes
```

Key derivation: `HKDF-SHA256(ikm=machine_id, salt="ll-search-seed-v1", info="federation-signing-seed")`.
Machine ID source: `machine-uid 0.6.0` (`gethostuuid(3)` on macOS; `/etc/machine-id` on Linux).

### Threat model

The encrypted-at-rest fallback protects against naive backups, `rsync /home`, and
over-the-shoulder file readers. It does NOT protect against an attacker with root
on the host (root can read machine-id and rederive the HKDF key). The OS keyring
is the strong path; encrypted-at-rest is "no raw seed bytes on disk" hardening for
environments that cannot run a keyring daemon.

### Migrating from plaintext

```bash
ll-search migrate-seed --config-dir <plugin-data-root>
# outputs: {"from":"plaintext-legacy","to":"keyring","plaintext_removed":true,...}
```

The migration is fail-closed: the plaintext `.seed` file is deleted only after the
new copy has been written and verified by round-trip read. Running `migrate-seed`
twice is safe (idempotent; returns `already_migrated: true`).

### Rolling back a migration

If you need to revert to pre-2K code after migrating:

```bash
ll-search migrate-seed --config-dir <plugin-data-root> --rollback
```

This reads the seed from keyring/encrypted, writes it back to `federation/.seed`,
and removes the secure-backend copy. The signing key bytes are preserved so
federation peers continue to trust the identity.

**If rollback is impossible** (e.g., keyring was cleared): rotate identity via
`/learning-loop:federation`. All peers must re-trust the new public key.

### Manual rotate

```bash
# Delete the seed from the OS keyring
security delete-generic-password -s ai.learning-loop.federation   # macOS
# On Linux with Secret Service: use the `secret-tool` CLI
# Then run identity to generate a fresh seed
ll-search identity --config-dir <plugin-data-root>
# Inform peers of the new pubkey via /learning-loop:federation
```

### LL_SEED_BACKEND override

Set `LL_SEED_BACKEND=encrypted` to force the encrypted-at-rest path (CI, reproducible
builds, paranoid users). Set `LL_SEED_BACKEND=mock` in tests to use an in-process store
without real keyring or machine-id access.

---

## CI workflow (planned)

After track 1I, `.github/workflows/baseline.yml` will enforce:

```yaml
# check: no process.env outside env.mjs
- run: node scripts/audit-baseline.mjs --check env

# check: no JSON.parse(readFileSync) outside safe-load.mjs
- run: node scripts/audit-baseline.mjs --check jsonparse

# check: no raw lock file writes
- run: node scripts/audit-baseline.mjs --check lockfile

# check: no unwrap/expect outside main.rs and tests
- run: cargo clippy --workspace -- -D clippy::unwrap_used -D clippy::expect_used

# check: ll-core public API additive
- run: cargo semver-checks -p ll-core
```

This workflow does not exist yet. The baseline docs describe the intended state after phase 2.

---

## see also

- `docs/baseline/rust.md` -- ll-core and ll-search conventions
- `docs/baseline/plugin.md` -- hook and script conventions
- `ARCHITECTURE.md` -- repo map and data flow
- `.planning/refactors/baseline-2026-05-11.md` -- full plan with exit criteria and risk register
- `.planning/inventory/plugin-patterns.md` -- JS pattern inventory
- `.planning/inventory/coverage-and-magic.md` -- magic number and coverage baseline
- `.planning/inventory/rust-audit.md` -- Rust clone, unwrap, and SQL inventory
- `.planning/inventory/ll-core-api.md` -- ll-core public API baseline
