# learning-loop — Integrity / Stability / Accuracy Audit

Branch `ll-integrity-pass` · baseline v1.35.0 · 2026-07-10

## Baseline (all green)

| Suite | Result |
|---|---|
| JS (`node --test`) | 1143 pass / 0 fail, 95 suites, ~23s |
| Rust (`cargo test`) | all `ll-core` + `ll-search` binaries pass (a few env-ignored: ORT/socket) |
| Lint | clean — 9 unused-`eslint-disable` warnings only |

## Method

45-agent adversarial workflow: 7 auditors fanned out across JS (lib / hooks / gateway / scripts / librarian) and the two Rust crates; **every finding re-checked by 3 refute-biased skeptics** (majority-refute kills it). 12 findings raised → **9 survived**, 3 correctly refuted. Separately, a test-quality pass ranked 16 mutation targets. I then **read the code myself for the critical + all three high findings** — all four confirmed by direct read (details below).

Mutation tooling is wired and proven: Stryker command-runner for the `node:test` JS (`semver.mjs` = 100%, 20/20 killed) and `cargo-mutants` 27.1.0 for Rust (290 mutants in `ll-core` alone). Nothing has been changed in the code — this is report-first.

---

## Confirmed findings (9)

### 🔴 CRITICAL — data loss

**1. `backfill-edges.mjs` deletes every edge outside a scoped `--folder`/`--limit` walk**
`plugin/scripts/backfill-edges.mjs:170-188` (scoped by 92-93, 107-114) · *verified by direct read*

Orphan removal treats "any `from_path` in the DB not in the set of notes I just walked" as an orphan and `DELETE`s it. But `--folder <x>` and `--limit N` restrict the walk to a subset. So a documented, ordinary run like `backfill-edges --folder 3-permanent` walks only `3-permanent` and then **deletes every edge originating from `0-inbox`, `1-fleeting`, `2-literature`, `4-projects`, `5-maps`** — everything it didn't walk. Only `source_graph = 'archived'` edges survive. A routine partial re-index silently wipes the edge graph.
**Fix:** run orphan removal only on a full unscoped run — skip it when `folderFilter || limit` is set (or restrict the `DELETE` to `from_path`s under the walked folders).

### 🟠 HIGH

**2. Empty/garbage lockfile is never recovered by mtime staleness → permanent lock wedge**
`plugin/scripts/lib/file-lock.mjs:80-111` · *verified by direct read*

The mtime-staleness fallback lives only inside the `catch`, which fires when `readFileSync` *throws*. An **empty or non-numeric** lockfile reads fine → `parseInt('') = NaN` → `Number.isFinite(NaN)` false → `return false` at line 88 without ever consulting mtime. So an empty lockfile wedges the lock permanently (until manual delete). Finding #6 below produces exactly such an empty file — they compound.
**Fix:** when the parsed PID isn't a finite/alive PID, fall through to the mtime check instead of `return false`.

**3. Peer-controlled `updated_at` panics the watch daemon (non-char-boundary slice)**
`native/crates/ll-search/src/sync/protocol/time.rs:24-29` · *verified by direct read*

Length is validated in **bytes** (`s.len() < 19`) but sliced on **char boundaries** (`&s[..19]`). A sync peer sending an `updated_at` whose 19th byte lands inside a multibyte UTF-8 char passes the length guard and panics `byte index 19 is not a char boundary`. `PeerInfo.updated_at` is deserialized straight from the hub's `PeerList` WebSocket message → **a malformed/malicious peer crashes the daemon** for every consumer. Remote-triggerable DoS.
**Fix:** validate bytes / guard with `is_char_boundary(19)` before slicing; add a multibyte regression test.

**4. `rocchio_prf_with` panics (index OOB) on a feedback embedding shorter than the query**
`native/crates/ll-core/src/scoring.rs:334-338` · *verified by direct read*

The pooling loop `for d in 0..dim { v[d] }` indexes every feedback vector at the query's dimension, filtering feedback vecs only by path — never by length. `db/query.rs` decodes embedding blobs with `chunks_exact(4)` and **no dimension validation** (see #9 note), so a dimension-drifted or truncated stored row makes `v[d]` panic and aborts the search. Reachable after any model/dimension change.
**Fix:** filter feedback vecs to `len() == dim` before pooling; re-check emptiness after.

### 🟡 MEDIUM

**5. `acquireLock` returns null when a stale lock is cleared on the *final* retry iteration**
`plugin/scripts/lib/file-lock.mjs:131-145`

On the last iteration, a successful `tryRemoveIfStale` hits `continue`, the loop exits, and it falls through to `return null` — the stale lock is gone but never re-acquired. Bites every `retries:1` caller on the first call after a holder crash (`session-label.js:239` dedupe state → dropped write → the same vault note can be re-injected). Self-heals next call; latent for the `retries:3/5` callers too. *(This is the finding whose one existing stale-recovery test uses `retries:2`, sidestepping the bug.)*
**Fix:** re-open in the same iteration after removal (`if (tryRemoveIfStale(...)) { i--; continue; }` or an inner open-retry).

**6. Research extraction ignores the configured OpenAI provider, silently falls to Ollama → zero-source**
`plugin/scripts/librarian/research.mjs:147-159` + `50-63`

`orchestrateResearch` resolves `cfg.provider` but only forwards `cfg.model/keepAlive/ollamaUrl` to `runResearch`, whose default `extractFn` always synthesizes an Ollama provider. A user who sets `librarian.provider.kind='openai'` (honored by GLM verify) gets it silently ignored for extraction, and on sub-tier local hardware degrades to the zero-source fallback. Accuracy/offload correctness.
**Fix:** thread `cfg.provider` through `runResearch` into the default `extractFn`; tier-gate on the provider, not the `:NNb` tag in `cfg.model`.

### 🟢 LOW

**7. `acquireLock` leaks the fd and orphans an empty lockfile if `writeFileSync(pid)` fails**
`plugin/scripts/lib/file-lock.mjs:133-142` — a transient write error (ENOSPC/EIO/NFS) rethrows without closing the fd or unlinking the just-created lockfile; that empty orphan is exactly what #2 can't recover. **Fix:** try/finally around the write — close fd + unlink on failure before rethrow.

**8. `edge-infer` leaks the `edges.db` lock when `openEdgeDb` throws**
`plugin/hooks/modules/edge-infer.mjs:198-222` — the lock is acquired *outside* the try/finally, so a corrupt-db / WASM-load / migration throw skips `releaseLock`, leaving a stale `.lock`. **Fix:** move `openEdgeDb` inside the try (init `db=null`), guard `db?.close()` in finally.

**9. Federated reflect scan skips the dimension guard the hybrid path enforces → silent mis-ranking**
`native/crates/ll-search/src/search/reflect.rs:186-189` — `reflect_scan_federated` calls `add_peer_rrf_scores` for every peer with no `peer_dim == local_dim` check (the hybrid path in `query.rs:211-229` has exactly this guard). A dimension-mismatched peer gets silently mis-scored instead of the BM25 fallback. **Fix:** factor the guard out of `query.rs` and apply it in both paths.

---

## Root-cause cluster worth naming

Findings **#3, #4, #9** — plus the (correctly refuted-as-not-a-crash but real) `load_embedding` truncation in `db/query.rs:79-82` — are one theme: **stored embeddings are decoded with `chunks_exact(4)` and no dimension validation**, so a dimension-drifted/corrupt row silently enters scoring. It panics in one path (rocchio), mis-ranks in another (reflect), and is remote-reachable in a third (peer timestamp is separate but same "trust external byte shape" family). A single **dimension-validation gate at embedding load** would neutralise the two panics and the mis-rank at the source, with the per-site guards as defence-in-depth.

The `file-lock.mjs` cluster (**#2, #5, #7**) is the other hot spot — 3 of 9 findings in one 211-LOC module. Worth a focused hardening pass + mutation run on that file specifically.

## Correctly refuted (3) — not bugs

- `nli-cleanup.mjs` multi-line YAML block-list corruption (refuted 3-0)
- `vault-search.mjs stripFlags` swallowing a query word after a value-less flag (3-0)
- `load_embedding` truncation "crash" — it truncates, doesn't crash (2-1); the truncation itself is the #4/#9 root cause, not a standalone panic.

---

## Test gaps → mutation targets (16)

**High priority (untested or boundary-blind, pure-logic / security):**
- `cite-extract.mjs` — **zero** coverage (author/year extraction)
- `edge-classifier.mjs` — only asserts `.flip`; high-vs-medium two-pass precedence unpinned
- `shadow-gate.mjs` — the two backend-health boundary constants (0.6 / rate) never pinned at boundary
- `sources/adapters/pmc.mjs`, `openlibrary.mjs` — **verify gates** whose wrong_author/wrong_year decision has no fixture
- `deny-match.mjs` — security matcher, no direct unit test (needs offender-blocked **and** clean-allowed, both directions)

**Medium:** `edges.mjs findMatchingSupersessions` (comparator boundaries), `sentence-split.mjs` (no test), `retrieval-usage.mjs` window upper-bound, and adapter parsers `europepmc/semantic-scholar/openalex/dblp/chembl` (no fixtures).

**Low:** `unpaywall.mjs` silent-return guards, `source-gateway.mjs` search-verb rejection path.

---

## What was done (branch `ll-integrity-pass`, report-first → fix on approval)

All 9 confirmed bugs fixed, TDD (red test first, red-proven against the unfixed code, then fixed), committed atomically. Full suite: **1180 JS tests + all Rust binaries green** (baseline was 1143 JS).

| Commit | Findings | Tests |
|---|---|---|
| Fix backfill scoped-run data loss | #1 CRITICAL | 3 new, extracted `removeOrphanEdges` gated on scope |
| Harden embedding-dimension handling | #3, #4, #9 | 7 new; rocchio panic reproduced then fixed; one guarded helper for both federated paths |
| Fix file-lock recovery gaps | #2, #5, #7 | 4 new, each red-proven |
| Honor research provider + edge-infer lock | #6, #8 | 1 new (provider passthrough) |

### Mutation testing (Stryker command-runner, node:test)

Tooling wired (`@stryker-mutator/core` 9.6.1, `npm run test:mutation`, per-module configs). Scores after hardening:

| Module | Before | After | Note |
|---|---|---|---|
| `deny-match.mjs` (security matcher) | 0% (no test) | **100%** (16/16) | fully pinned, both directions |
| `shadow-gate.mjs` (gate predicates) | 0% (no test) | **100%** (26/26) | all predicates + optional-chain links |
| `file-lock.mjs` | 72% | **77%** | behavioral/boundary mutants killed; survivors are log-arg + timing equivalents |
| `cite-extract.mjs` (citations) | 0% (no test) | **64%** | contract pinned; remaining survivors are the NOT_AUTHORS month string literals (set-membership already pinned — per-month tests would be tautological) |

### Deferred follow-up (documented, not done)

- **Medium/low test gaps** from the audit (adapter fixtures for `pmc`/`openlibrary` verify gates, `europepmc`/`semantic-scholar`/etc. parsers) — real but lower-blast-radius; worth a follow-up pass.

---

## Phase 2: adversarial pass over the fixes + edge-classifier mutation follow-up (2026-07-11)

The 9 fixes were per-task TDD'd but never got a whole-branch adversarial pass. A 6-dimension review (regression, backfill scope-gate, file-lock loop, RRF parity, edge-infer leak, test integrity) over the `main..HEAD` diff, each finding verified by 3 refute-biased skeptics (majority-refute kills), raised **10 findings, 3 survived**.

**3 survivors, all fixed (red-proven, atomic commits):**

- 🟠 **HIGH: negative `--limit` reintroduced the edge-graph wipe** (`backfill-edges.mjs`). The scope gate `Boolean(folderFilter) || limit > 0` disagreed with `walkVault`, which truncates on any truthy limit (`if (max)`). `--limit -5` truncates the walk to one file but reads as a full unscoped run, so orphan removal deletes every other note's edges: the exact bug finding #1 was created to fix. Fixed by extracting `isScopedRun` and mirroring walkVault's truthiness (`Boolean(limit)`). The branch's own tests passed `scoped` in directly and never exercised the gate. *(commit `23ffe88`)*
- 🟠 **HIGH: the federated RRF guard tests pinned nothing** (`federation.rs`). All three `guarded_*` tests asserted only `rrf.contains_key(peer key)`, which the vector path *and* the BM25 fallback both satisfy (the vector path runs `fts_bm25_query` internally and emits the same key). Confirmed empirically: the tests pass under both `if true` and `if false`. Fixed with a vector-only discriminator (a note matching by embedding but not by query text) so matched-dim must score it and mismatched/empty must not. Now fails under both mutants. *(commit `2be90a5`)*
- 🟡 **MEDIUM: fix #8 (edge-infer lock-leak) had no test.** Added a regression test that forces `openEdgeDb` to throw at the filesystem boundary (edges.db as a directory, so EISDIR) and asserts the lock is released. Red-proven against the pre-fix open-above-try structure. *(commit `f23f4e5`)*

**7 refuted (3-0 each),** good news for the fixes: the `db.close()`-throws-in-finally leak was refuted (fix #8 sound), the symlinked-`main()` guard concern was refuted, the file-lock two-attempt "double-sleep" is a bounded latency shift under contention with no wrong result, and the reflect/#6/deny-match/shadow-gate "untested" claims were mistaken.

### edge-classifier.mjs mutation follow-up

Baseline **34.66%** (87/251 killed) confirmed: its one test asserts only `.flip` (relational-only). Added 42 classification kill-tests (every edge type at both confidence tiers, high-beats-medium plus array-order precedence, sentence-boundary window trimming, link extraction, `classifyNoteEdges` guards, `detectFlip` AND-not-OR). Result: **34.66% to 54.58%** (137/251, +50 mutants killed). *(commit `bae759e`)*

Remaining 114 survivors are genuine near-equivalents, not gaps worth chasing:
- **~68 PATTERNS regex whitespace/verb-form variants:** `\s+` mutated to `\s` and `\S+` both still match a single space, so the real inputs (`"proves"`, `"builds on"`) don't discriminate; killing them needs pathological multi-space strings, i.e. tautological.
- **~30 `buildVaultIndex`:** filesystem-coupled (folder-priority resolution); needs directory fixtures, low blast radius.
- **3 `detectFlip` L173:** *provably equivalent*. The first `if (verbInBefore && !verbInAfter) return false` is redundant with the trailing `return false`; only the second `if` changes behavior, so no test can kill those three. (A latent one-line simplification, out of scope here.)
- Config also gained `ignorePatterns: ["native/target", ...]`. The 4.6GB Rust build dir was being copied into the Stryker sandbox each run and a concurrent build racing the copy crashed it. Worth porting to the other stryker configs.

### Phase 2 final state

JS **1237 tests green** (was 1180), all Rust binaries green. Tree clean. Branch ready for merge decision.
