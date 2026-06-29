# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Breaking changes are marked **BREAKING**; entries that require user action after upgrade are marked **MIGRATION**.

## Unreleased

- **`/reflect` correctness, speed, and prose-clarity pass (no efficacy claim — see below).** All behind the same green test net (`reflect-new-notes-track`, `refinement-validate`, the new `strip-reflect-sid`/`sweep-scan-vault`/`resolve-paths-sh` suites). _Correctness:_ Step 4.6.g cleanup now runs on the 0-candidate path too (a no-candidate run used to leak every note's transient `reflect_sid` stamp into the vault permanently); the `reflect_sid` strip is frontmatter-scoped so a body line starting with `reflect_sid:` survives; and the stale `reflect-track.mjs` header comment (which still described the superseded `$TMPDIR`-keyed marker the rest of the file documents as a fixed bug) was corrected. _Speed:_ a new `resolve-paths.mjs --sh` mode lets each bash fence resolve every run-invariant path from one spawn instead of two or three, and both `/reflect` python3 heredocs (the Step 4.4 candidate walk, the Step 4.6.g per-note strip) folded into node — the walk into a new `sweep-hook-replay.mjs --scan-vault` mode that carries the explicit 5-folder allowlist (never the `4-projects`-including `listVaultNotes` denylist), the strip into `strip-reflect-sid.mjs`. Step 2.5 also gains an optional up-front incremental index so dedup sees notes subagents wrote earlier in the session. _Prose clarity:_ the route-to-store rule is now a crisp behaves-vs-world test with a gated split clause (never the same sentence to both stores; there is no cross-store dedup), auto-memory dedup is grep-gated to read candidate bodies instead of eyeballing the index, and a forcing line names the three categories that hide in a fast pass (mid-session corrections, project-context shifts, unstated repeated behavior) without pressuring fabrication. A cold 5-domain adversarial review (each finding 3-skeptic-verified) confirmed zero invariant breaks and zero live bugs; its 16 findings — all test-coverage gaps and doc drift on correct code — were closed (a regression guard on the Step 4.4 fence's `--sh` resolver, a real-`shQuote` eval-safety test, a string-guard on the 0-candidate 4.6.g-cleanup contract, an end-to-end `--scan-vault` CLI test plus argument-guard hardening, a parameterized all-5-folder allowlist-inclusion test, and corrected handshake/attribution comments).
  - **The prose changes are shipped for clarity/maintainability, NOT as a measured learning improvement.** A blind A/B over 12 real episodic sessions (old prose vs new prose, over-capture-penalized rubric) returned `B ≈ A`: +8/110 total but 100% of the margin came from one atypical session, per-capture quality dropped slightly (2.62→2.57), and recall did not improve. **The proposed duplicate-threshold change (`0.90`→`0.85`) was the one change with a measurable footprint and it was negative on per-capture quality, so it was dropped — `/reflect` keeps the conservative `0.90`/`0.70` bands.** Two of the change's mechanisms (the threshold and the grep-gated memory dedup) could not be exercised by a dry replay without a live vault/memory index; re-testing the threshold against a live index, with an ablation and inter-rater judges, is left as a separate experiment.

## v1.33.0

- **Fixed the plugin-load error from a phantom skill directory.** `plugin/skills/_shared/` held a shared instruction doc (`hook-replay.md`) but no `SKILL.md`, so the harness tried to register `_shared` as a skill and errored on every load ("1 error during load"). Same anti-pattern as the v1.32.0 agents/\_skills phantoms: a shared-doc dir inside a harness-scanned tree. Moved it to a sibling `plugin/skills-shared/` and rewrote the 6 referencing skill files. New `M17` architecture-lint test fails the build if any `skills/` subdirectory lacks a `SKILL.md`.

## v1.32.0

- **Eliminated 19 phantom full-privilege agents (Foster Moore audit, second CRITICAL).** The shared agent-instruction docs lived in `plugin/agents/_skills/`; any `.md` under `agents/` auto-registers as a dispatchable subagent, and a frontmatter-less one gets the default "All tools" grant. The 19 docs (which agents only ever `Read()`, never dispatch) were registering as `learning-loop:_skills:<name> (All tools)` phantom agents — a security-review blocker and dispatch-noise for the real agents. Moved them to a sibling `plugin/agents-shared/` directory the harness does not scan, and rewrote every `${CLAUDE_PLUGIN_ROOT}/agents/_skills/...` reference across 28 agent/skill/guide files. New `M16` architecture-lint test fails the build if any frontmatter-less `.md` reappears under `agents/`.

## v1.31.0

- **`LL_OFFLINE` air-gap / update-control switch.** Setting `LL_OFFLINE=1` suppresses every plugin-initiated network call through a single `isOffline()` chokepoint: the SessionStart GitHub update poll, the binary auto-update download (including the manual `/init` and `/doctor` fetch paths), and all external web-research fetches (`/verify`, `/deep-research`, `/discovery`, source-resolver, claim-checker) — which now short-circuit cleanly instead of attempting a request and timing out. Localhost (Ollama) is never gated, so an air-gapped box keeps its local model. `/doctor` surfaces an "Offline mode: ON" line so operators can confirm the suppression is engaged. This closes the deployment gap left by the v1.30.0 Foster Moore audit remediation: the plugin can now run in an update-controlled or fully air-gapped enterprise environment.

## v1.30.0

- Pinned vendored sql.js to v1.14.1 with recorded SHA256 digests (vendor/README.md) so operators can verify the bundled WASM artefact (Foster Moore audit Domain 05).
- **Foster Moore security audit remediation.** Closes all six findings from the FM ai-tools governance review:
  - **Domain 06 (prompt injection).** Vault retrieval is now wrapped in a data-origin envelope (`{origin, trust: "untrusted-data", note, local_count, peer_count, results}`) at the single emission choke point, so re-emitted note content — including federated peer notes — is distinguishable from operator instructions. Episodic-memory results and external ingest (`/ingest`, `/literature`) are framed as untrusted data in their consuming prompts.
  - **Domain 09 (uninstall hygiene).** New `/learning-loop:uninstall` skill walks marketplace removal, dependent-MCP removal, and captured-index purge with per-step confirmation; README documents the manual sequence and how to silence hooks via `disableAllHooks` without uninstalling.
  - **Domain 04 (hook robustness).** New opt-in `hooks.pre_write_fail_mode: "closed"` lets operators make the vault-write duplicate gate fail closed (block) instead of fail open on internal scan failure; default remains `open`. `/learning-loop:doctor` now surfaces a hook-error count and the latest error.
  - **Domain 07 (data exposure).** New `/learning-loop:doctor --redact` scans plugin data for likely secrets (GitHub PAT, OpenAI `sk-`/`sk-proj-`/`sk-svcacct-`, Slack, JWT) and offers per-file scrub with masked output; README documents the full capture surface and trust model.
  - **Domain 02 (hook scope).** README documents that the broad `PostToolUse: Write|Edit|Agent|Skill` matcher is intentional — Agent/Skill events run lightweight provenance only.

## v1.29.5

### Performance

- **post-tool snapshot gate.** PostToolUse now loads the vault snapshot only for
  Write/Edit to actual vault notes. Previously every code save (the common case
  while a vault is configured) read and parsed the multi-hundred-KB snapshot,
  then threw it away in autolink/edge-infer's non-vault early-return.
- **TTL sweeps gated to once per 24h.** The session-dedupe / marker / tmp-legacy
  stale-file sweeps ran on every SessionStart and usually deleted nothing; they
  are now gated by a `last-sweep` marker. Reads already filter stale entries by
  mtime, so the deferral is behavior-preserving (edges.db tmp-orphan reaping
  widens from 1h to ≤24h — harmless for tiny crash artifacts).

### Token efficiency

- **Compact retrieval JSON.** `vault-search` emits unindented JSON; the 2-space
  indent was ~16-30% pure overhead on every skill/agent-driven retrieval that
  reaches the model context.
- **Score precision trimmed.** `ll-search` serializes result scores at 4dp
  instead of full f64; the model only ranks on score, and filtering/sorting
  already ran on the full-precision value.
- **Oversized memory index becomes a pointer.** When a project/global auto-memory
  index overflows the injection cap, SessionStart now injects a one-line pointer
  (entry count + path) instead of an unranked ~1%-of-file byte prefix, saving
  ~720 tokens/session of near-zero-signal content. Indexes that fit are still
  injected whole.

### Removed

- **Dead memory access log.** SessionStart no longer appends the per-session
  `retrieval/access-*.jsonl` record (the full memory filename list); nothing read
  it and it grew ~10MB/month.

### Fixed

- **ONNX Runtime resolution under the `$BIN_DIR` convention.** The plugin's
  spawner code and CLI shims set `ORT_DYLIB_PATH` to the binary's directory, but
  the hardened resolver (workstream F) required `ORT_DYLIB_PATH` to be a file, so
  a directory was rejected as "does not exist" and embedding failed. Two-sided
  fix: (1) `ll-core`'s resolver now accepts a directory `ORT_DYLIB_PATH` by
  resolving the pinned library within it, and rewrites the env var to the
  resolved file so `ort` never hands the macOS loader a bare directory (which
  hangs); (2) the JS spawners and shims now point `ORT_DYLIB_PATH` at the bin
  directory only when a runtime library is actually staged there, otherwise
  leaving it unset so the binary self-resolves (`~/.learning-loop/lib`) or honors
  an operator-set override. Centralized the eight duplicated injection sites into
  one `ortSpawnEnv()` helper.
- **Ingest agents now run on their declared model.** `ingest-context`,
  `ingest-linear`, and `ingest-repo` were dispatched as `general-purpose`, so
  their `model: haiku` frontmatter was ignored. They are now dispatched by
  `subagent_type` (with explicit `tools:` allowlists added), so the cheap-model
  intent applies. The dispatch prompts still resolve `${CLAUDE_PLUGIN_ROOT}` to a
  literal before spawn, so each agent can still load its shared `_skills/`
  contracts (`extract-insights`, `vault-io`) at runtime.

### Documentation

- **ARCHITECTURE.md: librarian-research offload.** Added the data-flow section for
  `/research` (Scope on Claude, then Search/Fetch/Extract on the local model, then
  adversarial Verify + Synthesize), the `verify-route.mjs` invariants, and the
  provider-agnostic `model-client.mjs` surface.
- **ARCHITECTURE.md: ONNX Runtime is `load-dynamic`, not static.** Corrected the
  dependency story to the runtime-resolved, SHA-pinned dylib (ORT 1.24.2 via
  `dylib.rs`, `ORT_DYLIB_PATH` injection), including the x86_64-macOS caveat.
  Also refreshed the librarian repo-map/topology rows and dated the stale
  2026-05-11 refactor-baseline section.
- **Guides: RAM-tiered librarian model.** `agents.md`, `configuration.md`, and
  `resource-usage.md` now describe the tier (`gemma3:12b` on 32GB+, `gemma4:e2b`
  on 16-32GB, skipped under 16GB) instead of a flat `gemma4:e2b` default. Fixed the
  config table (`keep_alive` default `30m`, added `pause_on_battery` and
  `battery_poll_seconds`, documented the remote `provider` surface).
- **`/research` documented.** Added to the README skills table and the workflows
  research-patterns section.
- **CONTRIBUTING.md.** Lint is four checks (added the eslint custom-rules step);
  corrected the test glob and the `cargo test --locked` invocation.

## v1.29.4

### Security

- **ONNX Runtime supply chain.** `ll-search`/`ll-core` now build `ort` with the
  `load-dynamic` feature instead of `download-binaries`. This removes `openssl`,
  `native-tls`, and `ureq` from the build graph and drops the `cdn.pyke.io`
  native-library fetch — the published CycloneDX SBOM no longer lists them. The
  binary instead loads an official Microsoft `libonnxruntime` (v1.24.2, the
  version `ort` pins), fetched and SHA-256-verified at runtime into
  `~/.learning-loop/lib`, overridable with `ORT_DYLIB_PATH` (operator-supplied
  library) or `LL_ORT_DIR` (pre-staged directory) for air-gapped installs. A
  missing `ORT_DYLIB_PATH` fails with a clear error instead of hanging on a
  loader search. Per-target hashes are recorded in `provenance/runtime.json` and
  pinned in code; `native/docs/OFFLINE_INSTALL.md` documents offline staging.
- **No-RC posture made enforceable.** cargo-deny has no global pre-release ban,
  so a CI step now greps `Cargo.lock` and fails on any pre-release dependency
  outside the `ort`/`ort-sys` allowlist (kept until a stable `ort` 2.x ships).

## v1.29.3

### Security

Dependency and supply-chain hardening for deployment in regulated / corporate-IT
environments (informed by a full dependency security review).

- **Model integrity.** The reranker model is now pinned to an immutable commit
  (was `resolve/main`) and verified by SHA-256 + size on both download and cache
  hit before it is embedded into the binary; an `LL_RERANKER_MODEL_PATH` escape
  lets air-gapped builds pre-stage it. The bge-small embedding model gains the
  same SHA-256/size verification (was trust-on-first-download) and an
  `LL_MODELS_DIR` override for offline pre-staging.
- **Federation egress.** The hub client refuses any non-`wss://` endpoint before
  connecting (loopback `ws://` still allowed for local/test) and pins the hub
  public key against config when provided. Frontmatter visibility detection
  handles BOM/CRLF, and an empty/unknown default visibility tier now fails closed
  to `private`.
- **Seed storage.** A legacy plaintext signing seed is auto-migrated to a strong
  backend and shredded when one is available (mode repaired to 0600 otherwise);
  read-path secrets are wrapped in `Zeroizing`.
- **Supply-chain gates.** Added `native/deny.toml` and a `security-audit` CI job
  (cargo-deny: advisories, license allowlist, crates.io-only sources, banned
  crates). All CI cargo invocations now run `--locked`. The binary downloader
  fails closed when a release ships no `SHA256SUMS` rather than installing
  unverified.
- **Licensing & provenance.** `ll-core`/`ll-search` carry explicit `Apache-2.0`
  license fields (resolving a prior MIT/none contradiction). `NOTICE` enumerates
  the vendored libraries; `plugin/vendor/LICENSE` covers sql.js;
  `provenance/models.json` records each ONNX model's source, revision, license,
  and SHA-256; CycloneDX SBOMs are generated and published with each release
  (committed snapshots in `provenance/`).

## v1.29.2

### Fixed

- **The /dream nudge no longer counts other sessions' memory writes.** The Stop
  hook computed "new memory files this session" by diffing the whole auto-memory
  dir against a session-start snapshot, so a session left open while concurrent
  sessions wrote got blamed for their files ("this session created 31 new memory
  files" with zero of its own — and a push toward a destructive /dream on false
  pretenses). The count now comes from a session-scoped write log that post-tool
  appends to on each Write/Edit into the memory dir, intersected with files still
  on disk. The `memory-snapshot-<sid>` marker is replaced by `memory-writes-<sid>`
  (both reaped by the existing 7-day marker sweep).
- **Binary auto-update fails loudly instead of looping silently.** When the
  detached session-start download spawn ran in a stripped environment with no
  resolvable plugin-data, `download-binary.mjs` threw `join(null, …)` into ignored
  stdio, leaving `.version` unwritten so every later session re-spawned the
  download forever. It now exits 1 with a clear message, and the spawn passes the
  resolved `CLAUDE_PLUGIN_DATA` explicitly so the child can't lose it.

### Internal

- **De-flaked the pre-write-check duplicate-gate tests.** Under a contended
  full-suite run the 3s production hook budget could be spent on cold Node startup
  before the duplicate-gate subprocess fallback ran, failing a different fallback
  assertion each run. The budget is now overridable via `LL_PRE_WRITE_BUDGET_MS`
  (a test seam; production default unchanged and still pinned to the hooks.json
  deadline), and the fallback tests set a generous value.

## v1.29.1

### Fixed

- **Research honors a custom Ollama host.** `research.mjs` never threaded
  `librarian.ollama_url`/`OLLAMA_URL` into extraction, so a user on a remote or
  custom-port Ollama got connection-refused, swallowed to an empty bundle, and a
  silent Claude fallback. The configured host is now used end to end.
- **Research model gate accepts quantized/variant tags.** `researchModelOk` only
  matched a bare `:<N>b` suffix, so capable models like
  `llama3.3:70b-instruct-q4_K_M`, `qwen2.5:14b-instruct`, and `phi4:14b-q8_0` were
  rejected with a misleading "below the research tier" exit. It now allows a
  separator after the size.
- **Fetch caps body size and rejects non-HTML.** `fetchText` buffered arbitrary
  response bodies in full before slicing; it now sends `Accept: text/html`,
  short-circuits a non-text `Content-Type`, rejects an over-budget `Content-Length`
  (~5MB), and drops an unclosed `<script>`/`<style>` block that previously leaked
  its body as text.
- **Research reports zero-claim runs distinctly.** A librarian run that exited 0 but
  extracted no claims was reported as "librarian unavailable (exit 0)"; it now says
  "librarian ran but extracted 0 claims from N sources" — a degraded-extraction
  signal, not an outage.
- **`chatJSON` honors `options` sampling params on the openai path.** `temperature`
  (and `top_p`/`top_k`/`max_tokens`/`seed`) passed in `options` were silently
  dropped for OpenAI-compatible providers, so a `temperature: 0` ran at the server
  default. They are now lifted to the request body.
- **`extractClaims` can surface failures (`throwOnError`).** New opt-in flag
  (default off — production still swallows) so tooling can distinguish a provider
  failure from a genuine zero-claim result.
- **Docs name `/learning-loop:research`** as the research entry point and describe
  its Claude fallback as internal, rather than attributing it to `/deep-research`.

## v1.29.0

### Added

- **Provider-agnostic model surface (`lib/model-client.mjs`).** A single
  `chatJSON()` entry point for structured-output model calls that targets either
  a local Ollama (`/api/chat`, `format`) or any OpenAI-compatible endpoint
  (`/v1/chat/completions`, `response_format`, bearer auth) — e.g. GLM/DeepSeek via
  Fireworks. The librarian's claim-extraction and triage tools (voice, tags,
  duplicate) route through it. Configure via a `librarian.provider` block
  (`{ kind, base_url, api_key_ref, model }`); absent it, behavior is unchanged
  (synthesized local Ollama provider). API keys resolve from the macOS Keychain by
  `api_key_ref`, never stored in config. `base_url` points at a cloud host now and
  a self-hosted box later with no code change.

- **Local research engine (`scripts/librarian/research.mjs`).** Brave search →
  fetch → local-Gemma claim extraction, emitting a JSON claims bundle. Distils
  ~15 source documents to one-line cited claims before anything reaches Claude.
  Search/fetch/extract run locally; verify and synthesis stay on Claude.
- **`/learning-loop:research` skill.** Deep research that offloads the
  token-heavy middle (Search + Fetch + Extract) to the local librarian, keeping
  Scope, 3-vote adversarial Verify, and Synthesize on Claude. Falls back to
  Claude-native WebSearch when the librarian is unavailable, sub-tier, or returns
  no claims (`stats.gatherMode` records which path ran). This is the wiring that
  turns the engine into actual token savings — the built-in `/deep-research`
  cannot call the engine on its own.
- **Research engine reports which path ran.** `/learning-loop:research` returns a
  top-level `engine`/`gatherMode` field and logs a prominent live banner
  (librarian vs Claude-fallback), so a silent fallback can't masquerade as a
  successful offload.
- **Provenance-routed Verify phase.** `/learning-loop:research` now routes each
  claim at verification: a claim carrying a resolvable academic identifier
  (`sourceId`, captured during extraction) is checked deterministically against
  PubMed/CrossRef (no LLM, no tokens); every other claim runs a 3-vote adversarial
  check on GLM-5.2 off Claude, with Claude 3-vote as the fallback when no
  GLM provider is configured or it errors. The deterministic branch is
  positive-evidence-only: it kills only on a resolved record with a high-severity
  mismatch and defers every ambiguous result (not-found, transient API error) to
  GLM rather than killing a real claim on a database hiccup. A survivor-biased
  Claude audit re-checks a sample of GLM's survivors (log-only, GLM's verdict
  ships) to watch for drift. `stats.verify` reports the per-engine counts plus the
  audit, and a top-level `verifyEngine` field surfaces which engine ran so a silent
  fallback stays visible. With no `librarian.provider` openai block, the phase runs
  on Claude exactly as before.
- **Research engine fetches sources concurrently.** Fetch is parallelized (I/O-
  bound); extraction stays serial because Ollama serializes concurrent requests to
  one local model. Output order is guaranteed structurally (a projection of a
  `Promise.all` index-aligned array), not by convention.
- **Single consolidated librarian model.** Daemon triage and research share one
  model (`librarian.model`, default `gemma3:12b`) on the same Ollama server with a
  long `keep_alive` (`librarian.keep_alive`, default `30m`) so it stays resident
  across both — no cold-boot thrash. `researchModelOk()` gates research to 12b+.
- **RAM-tiered model selection at `/init`.** `/init` picks the librarian model
  from system RAM (skip <16GB; `gemma4:e2b` triage-only for 16–32GB;
  `gemma3:12b` triage+research for ≥32GB) and writes `librarian.model`.
- **`/init` can configure the GLM Verify-offload provider (Phase 7d).** Optional,
  opt-in step that stores a Fireworks (or any OpenAI-compatible) API key in the
  macOS Keychain and writes a `librarian.provider` block, so `/learning-loop:research`
  runs its Verify phase off the Claude budget. `/init` Phase 1 now also detects an
  existing provider. With no provider, Verify falls back to Claude — unchanged default.

### Changed

- **MIGRATION:** model/Ollama defaults hoisted to `lib/defaults.mjs`
  (`DEFAULT_MODEL='gemma3:12b'`, `DEFAULT_OLLAMA_URL`), the single source of truth
  for daemon and research CLI. `env.MODEL` is now a pure override, not a shadowing
  default. Existing installs whose `librarian.model` was written by a pre-tiering
  `/init` (e.g. `gemma4:e2b` on a ≥32GB machine) should re-run `/init` so research
  is enabled on capable hardware.

### Fixed

- **`/research` Verify no longer ships verifier failures as refutations.** The
  router/audit treated a verifier that could not reach quorum (a rate-limit/outage
  nulling its votes) identically to an adversarial refutation, silently shipping
  well-sourced claims as "refuted" with a `0-0` vote. Verification now has a third
  outcome — _inconclusive_ (`survives=null`) — reported separately from confirmed
  and refuted; an all-inconclusive run says the verifier was unavailable rather than
  claiming the research was refuted.
- **`/research` Verify recomputes survival from the votes, never trusts a
  transcribed scalar.** A subagent dropping `verdict`/`survives` from a verify-source
  or verify-glm result (the loose result schema permits it) previously short-circuited
  to a silent kill. The mechanical branch now requires a recognized verdict plus a
  boolean `survives` before it can short-circuit; the GLM branch recomputes `survives`
  from the verdicts array. Logic extracted to `scripts/librarian/verify-route.mjs`
  with a contract test pinning the SKILL.md inline copy.
- **`/research` source ids trim publisher view-qualifier suffixes.** Wiley legacy
  `/doi/<DOI>/full|/abstract|/pdf` URLs no longer yield an unresolvable DOI that 404s
  at CrossRef and drops the claim out of the free deterministic check.
- **`/research` mechanical verification keeps the citation author/year.** The
  URL-derived id retains the model's claimed author/year so a citation mismatch is
  surfaced as a flag (carried into the evidence), instead of being discarded; a
  mismatch flags rather than kills, since the claimed author comes from the same
  chrome-heavy text the id parse was deliberately moved off.

## v1.28.3

### Fixed

- **CI binary-gated guard no longer flaky.** The "must not skip" step re-ran the binary-gated suites in a second process that could resolve the ll-search binary differently from the main run, blocking releases on a non-bug. The pinned binary is now installed _before_ `npm test` (Linux) so the gated suites execute in the normal run, with a direct `hasBinary()` assertion replacing the second TAP parse.

## v1.28.2

### Fixed

- **macOS CI lane green.** Relaxed an over-strict session-start trim-ordering test that required the lowest-priority learned-patterns section to keep its byte-cap pointer even when it was the section legitimately absorbing the stdout-budget tail trim; it passed locally by byte-position luck but failed on the macOS runner. Load-bearing invariants unchanged.

## v1.28.1

### Fixed

- **`npm test` no longer hangs at end-of-suite.** Under Node's default `--test-isolation=process`, the runner could complete every test but never exit, wedging the CI `Test` lane indefinitely. Root causes: the duplicate-gate test's spawned UDS-server children kept the event loop alive (now `unref`'d, with bounded wait-for-exit teardown and a parent-death reaper in the helper), and the runner now passes `--test-force-exit`. Also hardened `pre-write-check`'s daemon socket to `destroy()` rather than `end()` on timeout so a wedged daemon connection is torn down immediately instead of lingering.

## v1.28.0

### Added

- **Retrieval-quality regression gate.** `bench.mjs` gains a quality variant that runs `ll-search eval-funnel` against a seeded fixture vault across both title-shaped and long natural-language query distributions, with a committed baseline and a CI job that hard-fails on a >3% absolute drop in recall@10/ndcg@10. The gate fails closed on eval-pipeline errors; CI uploads metrics artifacts and a `workflow_dispatch` bless path regenerates the baseline on ubuntu.
- **Warm duplicate gate.** The watch daemon's UDS server now serves `duplicate-scan` requests with the embedding model kept warm (~430ms vs 0.8–3.7s subprocess cold start); `pre-write-check` tries the socket first with a budget-aware subprocess fallback, logs distinct `duplicate-gate-timeout` / stale-daemon codes, and a new `duplicate-gate-health` doctor check surfaces repeated failures.
- **`filename_style` config** (`kebab` | `spaces` | `auto`, default auto-detect from the vault's existing notes): new vault notes that diverge from the vault's filename convention get a non-blocking pre-write advisory with a suggested rename. The kebab-case filename rule is now stated in the canonical capture-rules and the `/init` vault template.
- **Shadow→live injection path.** A new `injection-shadow-gate` health check evaluates the go/no-go criteria over post-calibration shadow logs and nudges once ready; `/doctor` offers a consent-gated flip of `injection_mode` to live, or a dismissals state to hold in shadow.
- **Usage telemetry.** `/reflect` classifies each surfaced note as used/ignored (machine-generated signals excluded) and emits `note-usage` provenance events; `/health` surfaces "frequently surfaced, never used" and "never retrieved in 90d" lists as deepen/archive candidates.
- **Lifecycle exits.** `/verify` gains a `fleeting` scope; `/deepen` auto-pick considers gate-demoted `1-fleeting/` notes; the fleeting sweep gains a NEEDS-DEEPEN repair category capped at 2 attempts before routing to archival; resolved and ≤2-pass inbox notes get consent-gated archival to `_archive/0-inbox/`; synthesis-tagged notes are re-validated against the factual-signals heuristic with persisted verdicts.

### Changed

- **BM25 handles natural-language queries.** FTS queries are AND-first with an OR fallback (stopword-filtered, 32-token cap) when AND matches nothing, so the keyword signal participates on the JIT injection path instead of returning zero rows for long prompts.
- **Injection gate recalibrated** from 0.35 to 0.30 (RRF-sum scale, derived from 18,360 logged shadow evaluations); the injected header now says `match score` instead of mislabeling RRF as cosine similarity.
- **Session-start context assembly** dedupes project/global memory indexes, caps the learned-patterns and intentions sections, and orders capped sections ahead of unbounded ones so the 8KB trim can no longer evict the retrieval protocol or memory indexes. Stop-nudge thresholds raised to 512KB / 200 messages; `session-label` reads a 256KB transcript tail instead of the whole file.
- **Refinement pipeline integrity.** The validator enforces the promised sentence-removal check (sentence-unit LCS, fenced code blocks included as opaque units), emits an upstream content hash, and `/reflect` re-reads before applying so stale decisions are dropped instead of clobbering; applied edits are provenance-stamped (source merge + wikilink).
- **Eval honesty.** `eval-prf`/`eval-funnel` hold out the evaluated note from PPR seeds and mask its gold edges (the leak inflated the graph stage ~2.3×); the embedding model download is pinned to a revision.
- **CI matrix.** The Node suite runs on ubuntu/macos/windows (windows `continue-on-error` pending triage); binary-gated suites assert non-skip; lefthook runs cargo test on `native/**` changes.
- **`/ingest` worklist redesign.** The routing subagent returns a structured vault worklist and the driver fans out note-writer (subagents cannot spawn subagents), with artefact rows written directly by the driver, per-row failure reconciliation, and hook replay seeded from reported paths.
- Onboarding accuracy: install.sh fails closed on platforms without prebuilt binaries (with a documented source-build path), federation skill §C matches the keyring-first identity contract, doctor/health-check fix commands run verbatim, and the cross-platform smoke tests work on installed machines.

### Removed

- **`/inbox --skip-nli` flag** (meaningless after the NLI removal below).
- **`/doctor` no longer auto-fixes `nli-socket-fresh`.** The fix row was removed with the NLI subsystem. A stale `nli.sock` file left by a pre-upgrade install must be removed manually: `rm <PLUGIN_DATA>/nli.sock`, then restart `ll-watch`.
- **NLI contradiction-edge subsystem removed.** The DeBERTa-backed `challenges_rebuttal` / `nli_supports` edge types and their promotion-gate buckets have been fully removed after an audit showed 12% precision and zero recorded outcomes. Counter-argument detection now relies exclusively on the regex `challenges_*` classifier and embedding-similarity signals, which were already the primary path. Existing installs should run `node PLUGIN/scripts/nli-cleanup.mjs` (where `PLUGIN` is the installed plugin directory — see `guide/troubleshooting.md`) to purge residual `source_graph='nli'` rows from `edges.db`, drop unused NLI-bucket columns from `promotion_log`, and strip `nli_qualified_by` / `nli_resolved` / `nli_tension*` frontmatter fields from vault notes. **MIGRATION**

## v1.27.3

### Fixed

- **`/learning-loop:federation` is model-invocable again.** Its `disable-model-invocation` flag blocked the very handoffs that reference it (init Phase 4, broken-sync repair), erroring with "cannot be used with Skill tool". The flag stays on init, rewrite, seed, and harvest — those are deliberately user-only entry points.

## v1.27.2

### Fixed

- **Hooks no longer warn "Failed to load the ES module" on every fire.** The v1.27.1 restructure kept `package.json` at the repo root, so the installed plugin shipped without one and the eight ESM `hooks/*.js` files lost their inherited `"type": "module"` — Node fell back to per-process module detection with a stderr warning on every hook (surfacing as "Failed with non-blocking status code" in Claude Code), and runtimes without detection hard-failed. The plugin now ships its own `plugin/package.json` containing exactly `{"type": "module"}`. A regression test runs every `hooks.json`-referenced hook from an installed-layout copy of `plugin/` (no ancestor `package.json`) with module detection disabled — the stderr-cleanliness assertion the v1.27.1 install smoke lacked.

### Changed

- CI's pinned truncation-contract binary bumped v1.26.0 → v1.27.1.

## v1.27.1

### Fixed

- **Supersedes v1.27.0, whose build failed in CI before any artifacts published** (the tag has no release). This release ships the same content plus the fixes below.
- **`build-native` no longer fails on a guard hunting a library that never ships.** The packaging steps demanded a standalone onnxruntime next to the binary, but `ort`'s `download-binaries` feature statically links it — every release ever has shipped a self-contained `ll-search`. The guard and the copy are gone; packaging ships the binary alone, as before.
- **Two `writeMarker` tests no longer depend on the developer machine's real plugin-data.** They passed locally only because `~/.claude/plugins/data/.ll-data-path` exists there, and failed on CI where it doesn't; the marker-cache tests now sandbox `CLAUDE_PLUGIN_DATA` into a temp dir like the rest of the marker family.

## v1.27.0

### Changed

- **The installed plugin now ships only the runtime.** The plugin moved into `plugin/` and the marketplace source points there, so an install pulls ~6.6M of runtime (hooks, skills, agents, scripts) instead of the whole repository — tests, native sources, benches, and CI stay behind. Provenance templates ship inside `plugin/`, and version readers derive from `.claude-plugin/plugin.json`. First release cut in the plugin-shaped layout.
- **Dash policy is unified to added-only.** The write-path dash deny applies only to lines a write adds (pre-existing dashes in a note no longer block edits), and the validator's dash character class is widened to match.

### Added

- **Binary downloads are verified.** `build-native` generates `SHA256SUMS` for each release, and `download-binary` verifies the fetched `ll-search` binary against it, follows https-only redirects, and orders the version stamp after the verified install.
- **ESLint is wired into the repo**, including a no-raw-lockfile rule enforced at zero violations.

### Fixed

- **Release and CI hardening.** `release.sh` gains a main-only, fast-forward-synced preflight, lockfile sync, and atomic push, and no longer supports `--skip-tests`; `build-native` builds `--locked` with a durable model cache and ships the self-contained `ll-search` binary (onnxruntime is statically linked via `ort`'s `download-binaries`); CI enforces the NLI truncation contract against a release binary instead of skipping.
- **Subagent verification loops actually run.** `/discovery`'s note-verifier loop is hoisted out of the researcher agent (where it never executed) into the skill; `/inbox` rewrites flow through an explicit worklist from the inbox-organiser, with an NLI-hold column so held notes defer promotion; PostToolUse hooks are replayed after sub-agent fan-out; dispatched vault agents get minimal tool allowlists and a uniform `${CLAUDE_PLUGIN_ROOT}` path contract; `note-writer` reports the filename it actually used. A lint suite pins these subagent architecture invariants.
- **Skill UX.** `/health` splits into a light default and a deep mode (plus fixes for live bugs found in the split), `/verify` and `/gaps` run their defaults immediately instead of prompting, `/doctor` targets the real install for its fixes, and `/quick` gains a verification posture.
- **`/ingest` and `/reflect` upstream-refinement pipeline.** Paths are vault-derived instead of hardcoded, a heredoc env bug is fixed, and the deferred refinement queue is actually drained.
- **Hook lifecycle reliability.** Dream/reflect markers go through one central registry (`marker.mjs`), ending a tmpdir split-brain; the dream gate recovers stale locks and guards its first-run stamp; the stop-nudge once-guard is actually read; session-start takes its session id from the stdin payload and sweeps stale markers and tmp orphans; the watch-daemon spawn lock is crash-safe; plugin-data resurrection is closed behind one shared guard.
- **Dead code and docs.** The librarian-queue shim and unreferenced benchmark artifacts are removed, frontmatter parsing is consolidated through `markdown-parse`, the librarian queue is crash-safe, docs are rewritten to describe the post-coalescing hook family (librarian launch story, binary size, federation sync, doctor pointer), and client names in shipped examples and fixtures are neutralised — project slugs now derive from the vault's `4-projects/` index.
- **Update-check reliability.** A failed check no longer clobbers a cached `update_available` (going offline used to hide a known update), the timeout and malformed-response paths now stamp the cache so the checker stops respawning every session, and the check runs in an extracted worker instead of an inline child that hung session-start for ~10 seconds on the global keep-alive socket.
- **The dream-nudge ghost session is gone.** Stamping `last-dream` now also clears the cached dream-gate nudge, so the first session after a `/dream` consolidation no longer re-nudges from stale cache.
- **`/doctor` surfaces a stuck binary auto-update.** The binary check compares the installed `.version` against the running plugin version and warns when the binary lags releases, instead of treating any readable version file as healthy.
- **Provenance events no longer double-emit.** `provenance.mjs` ran its CLI block on import, so every `provenance-emit.js` call recorded the event twice; the CLI block is now main-guarded, and the guard realpaths `argv[1]` so symlinked installs still emit.

## v1.26.1

### Fixed

- **SessionStart no longer emits malformed JSON when the assembled context exceeds the 8KiB hook stdout budget** (e.g. a large auto-memory index). Two layers: memory-index injection is now capped at 3KiB per section, cut at the last full line with a `[truncated — full index at <path>]` pointer to the full file; and `emitJson` itself now trims the `additionalContext` field and re-serializes instead of byte-slicing the stringified envelope — when nothing is trimmable it logs and emits nothing, because no output beats corrupt output.
- **The harvest scrub gate fails closed on an unreadable config.** `getConfig()` never throws (it logs and returns `{}`), so the scrub CLI's try/catch was dead code: a corrupt `config.json` silently dropped the `email_domains` deny terms and the scrub reported clean. The CLI now loads strictly via the new `getConfigStrict()` and exits 1 when a config exists but won't parse (or parses to a non-object); an unreadable federation config surfaces instead of silently dropping the own-pubkey deny term; numeric deny terms are coerced to strings, any other non-string shape throws.
- **`fleeting-sweep.sh` no longer hardcodes instance-specific project slugs** (which also made stale-project detection a no-op on every other install). Slugs now derive from `4-projects/*.md` index notes with anchored prefix matching (a short slug like `ai` no longer flags unrelated notes via substring); the config path is passed via argv instead of interpolated into inline JS, and wikilink greps are fixed-string.
- **Promotion-gate verification markers match case-insensitively.** Markers are LLM-written text, and `[Unverified]` sailed straight through the lowercase-literal match into `3-permanent/`. The body is lowercased before matching, and `[needs verification]` / `[citation needed]` — already declared blocking in `promote-gate.md` — gained the mechanical backstop.
- **`edges.db` is written atomically.** `saveDb` rewrote the full database image in place on every vault write; a crash mid-write corrupted the whole justification graph. Writes now go through a pid-suffixed tmp file plus rename, which also closes a torn-read window for unlocked readers.
- **Live injection mode scrubs secrets.** Shadow mode passed the would-be injection through `scrubSecrets`; live mode emitted the raw context. Both now share one scrubbed value computed above the mode branch.

## v1.26.0

### Added

- **Instance portability: carry your working-style and curated insights between learning-loop instances you own, without leaking IP in either direction.** Two new generic skills plus an `/init` restore phase:
  - **`/learning-loop:seed`** builds a portable starter slice — feedback memories + `_system` (persona, capture-rules, protocol) + the portable sections of your global `CLAUDE.md` — that a fresh instance can boot from. No vault notes and no projects by default (`--for-job`); carries working-style, not knowledge. Selection is mechanical (frontmatter `type` filter + word-boundary filename deny-list); you review and prune at the source before the bundle is written.
  - **`/learning-loop:harvest`** collects notes/memories you explicitly marked `portable: true`, scrubs them against this instance's IP deny-list, lets you review the survivors, and emits a lift-bundle to carry home and absorb with `/learning-loop:ingest`. Two axes are kept strictly orthogonal: `portable` (may leave this instance) governs harvest; `visibility` (federation share) is never consulted. The deny-list is a **hard, fail-closed gate** (hand-listed terms merged with mechanically-derived instance facts — federation peer ids, your own pubkey, configured email domains); a hit blocks unconditionally, and review may only drop more, never un-block. Deny terms match on word boundaries in both the note body and the filename, including `-`/`_`/`.` compounds (`acme` blocks `acme-registry` but not `acmecorp`).
  - **`/init` phase 08** restores a seed bundle on a fresh instance and seeds the harvest deny-list for a work/IP context.

## v1.25.16

### Fixed

- **Lifecycle hooks no longer fail to spawn when the session's working directory has been deleted.** Each hook command is run by Claude Code as `/bin/sh -c "<command>"`; on macOS, `posix_spawn` reports `ENOENT` against the shell executable itself when the spawning process's current working directory no longer exists — surfacing as `Failed with non-blocking status code: ... ENOENT: no such file or directory, posix_spawn '/bin/sh'` even though `/bin/sh` is present. This happens when a session was started in a directory that is later removed (e.g. a git worktree that gets cleaned up). Every hook command now prefixes `cd "$HOME" &&` so the shell relocates to a guaranteed-valid directory before invoking node. The hooks were already cwd-independent for locating their scripts (they use `${CLAUDE_PLUGIN_ROOT}`) and read the session cwd from the stdin payload rather than the shell's cwd, so this guard is purely spawn-resilience and changes no behavior.

## v1.25.15

### Fixed

- **Release build resilience, part two: the NLI model download now retries too, and the model cache survives `build.rs` edits.** v1.25.14 added retry/backoff to `ll-core/build.rs`, but the v1.25.14 release build still failed: there is a _second_ compile-time HuggingFace fetch in `ll-search/build.rs` (the DeBERTa NLI model, behind the `nli` feature) that still used a single `curl` and panicked on the first 429 — before `ll-core` even got to retry. That second downloader now retries up to 5 times with the same exponential backoff (2s/4s/8s/16s), preserving its SHA-256 pin and size-floor validation on the final bytes. Separately, the `Cache models` step in `build-native.yml` was keyed on `hashFiles('native/crates/ll-search/build.rs')`, so _editing build.rs to add the retry_ changed the key and guaranteed a cold HuggingFace fetch on the very release that needed the cache most. The key is now a manual `native-model-v5` tag, bumped only when the pinned model/SHA actually changes, so build.rs edits no longer bust it. (v1.25.14 was tagged but its build failed, so no GitHub Release was cut for it; this is shipped as v1.25.15.)

## v1.25.14

### Fixed

- **Release builds no longer fail when HuggingFace rate-limits the compile-time model download.** `ll-core/build.rs` fetches the reranker ONNX model and tokenizer from HuggingFace during the build; it did so with a single `curl -fsSL` and a bare `assert!` on success. When two tag pushes raced the same endpoint (v1.25.12 + v1.25.13 pushed together), HuggingFace returned HTTP 429, curl exited non-zero, and the build panicked at `build.rs:16` — the fail-fast matrix then cancelled the other platforms and skipped the GitHub Release. The download now retries up to 5 times with exponential backoff (2s/4s/8s/16s), writes to a `.partial` temp file renamed only on success (so an interrupted attempt can't leave a truncated file that the `dest.exists()` short-circuit treats as complete), and panics with a clearer message only after all attempts are exhausted. Verified the retry/backoff path against a forced-429 endpoint.

## v1.25.13

### Fixed

- **`/reflect` Step 4.6 Upstream Refinement no longer silently skips because the session id resolves differently across processes.** Fifth chapter in the new-notes-handshake saga, and the first to fix the _architecture_ rather than a symptom. v1.25.8–v1.25.12 each repaired one rung of how the marker path is resolved or backfilled; all correct, none sufficient, because they all built on a session-id resolver that was never stable across the processes that have to agree. `getSessionId()` keyed its candidates on `process.ppid` (`plugin-data/session/id-<ppid>` first, then the unsuffixed `id`). But `process.ppid` is the _immediate parent_, and the three processes in the handshake have three different parents: the SessionStart hook's parent is the harness, the post-tool hook's parent is the harness, and the skill's `resolve-paths.mjs` runs as `node` whose parent is the bash that spawned it. They never shared an `id-<ppid>` file — they only met by falling through to the unsuffixed `id`, which is last-writer-wins and gets clobbered by any concurrent session. Worse, `id-<ppid>` files **accumulate forever** (ppids are reused across sessions; 18 stale files observed in one live install, including the exact id from a broken `/reflect` report), and a stale one with a colliding ppid **shadows** the real id — so the hook resolved one id, the skill another, the marker paths diverged, every Write was silently skipped, and refinement saw an empty marker. Fix: resolution is now env- and ppid-independent. `getSessionId()` returns `$CLAUDE_CODE_SESSION_ID` (the harness session id — the one id identical across the SessionStart hook, both hook subprocesses, the skill's bash, and sub-agents, and immune to `$TMPDIR`), falling back to `plugin-data/session/id` then the legacy unsuffixed tmp file. SessionStart (`vault-snapshot.mjs`) stamps the harness id into the single unsuffixed `session/id` (was `randomBytes(4)`), writes **no** `id-<ppid>` files, and one-shot sweeps any stale ones so existing installs self-heal. The dead `DATA_PATHS.sessionId(pd, ppid)` helper is removed. The skill side is unchanged — it already funnels through `resolve-paths.mjs SESSION_ID` → `getSessionId()`, so both sides now agree by construction; `hooks/post-tool.js`'s comment (which had warned _against_ using the harness id, the prior design's central wrong assumption) is corrected. `tests/lib-session.test.mjs`, `tests/common.test.mjs`, and `tests/reflect-new-notes-track.test.mjs` are reworked from the ppid contract to the harness-id contract, including the decisive regression: a stale on-disk `id-<ppid>` must not shadow the live harness id. Full suite 657/0. Why the prior four fixes' tests stayed green while this stayed broken: every test seeded the id files for the running process's own ppid, so the writer and reader always shared a ppid by construction — the cross-process ppid divergence that breaks production was never exercised until the new cross-process test spawned `resolve-paths.mjs` with a divergent environment.

## v1.25.12

### Fixed

- **`/reflect` Step 4.6 Upstream Refinement no longer silently skips when the session's notes were written by sub-agents.** Fourth chapter in the new-notes-handshake saga, and the one the previous three never reached. v1.25.8–v1.25.11 fixed how the two sides _resolve_ the marker path (env var → stdin payload → shared id file → plugin-data anchor); all correct, all necessary, none sufficient — because the real gap is that the live PostToolUse hook never fires on sub-agent Write/Edit calls at all. Notes from `note-writer`, `discovery-researcher`, `literature-capturer` (i.e. every `/discovery`- or research-heavy reflect) bypass `reflect-track.mjs` entirely, so their paths never hit the marker through the hook. The _only_ backfill was Step 4.4's sweep — but its candidate filter selects notes with **no `[[links]]`** in the body (it exists for autolink backfill), and `capture-rules.md` requires at least one link, which `note-writer` always emits. So every well-formed sub-agent note was filtered straight out of the sweep, never replayed, never reached the marker → marker empty → Step 4.6 saw zero new notes and skipped with no error. The marker-resolution fixes all worked; there was simply nothing to resolve, because nothing was being tracked. Fix threads an **explicit** session id through the replay so it stays correct under **concurrent `/reflect` runs** (the constraint that rules out mtime, git-diff, and provenance for attribution — provenance's own `session_id` is last-writer-wins on the shared plugin-data `id`): (1) `scripts/lib/env.mjs` exposes `LL_REFLECT_SID`; (2) `hooks/post-tool.js` sets `ctx.sessionId = env.LL_REFLECT_SID || null` (was a hard `null`, which is why the explicit override `reflect-track.mjs` already supported never reached it) — the normal main-thread hook path keeps `null` and resolves via `getSessionId()` as before; (3) `scripts/sweep-hook-replay.mjs` forwards env to the spawned `post-tool.js`; (4) SKILL.md Step 4 stamps a transient `reflect_sid: <LL_SID>` in each note's frontmatter, Step 4.4's candidate scan becomes the **union** of link-less notes (autolink backfill, unchanged) and notes whose `reflect_sid` matches this session (marker backfill), the replay is invoked with `LL_REFLECT_SID=$LL_SID`, and Step 4.6.g strips `reflect_sid` from the tracked notes so it never leaks into the permanent vault. The explicit id is what keeps attribution correct when two `/reflect` runs overlap: each appends only to its own marker. `tests/reflect-new-notes-track.test.mjs` adds a sub-agent-backfill block — a linked note routed via the override reaches the calling session's marker, a concurrent session's note is excluded, and a real `sweep-hook-replay.mjs` spawn with `LL_REFLECT_SID` set populates the marker end-to-end — plus SKILL.md-contract assertions pinning the `LL_REFLECT_SID` invocation and the `reflect_sid` candidate selection so a future edit can't regress back to the link-less-only filter. Full suite 655/0 (2 skipped). Why the prior three fixes' tests stayed green while production stayed broken: they all drove the main-thread Write path, where the hook does fire; none exercised a sub-agent write reaching the marker through the sweep.

## v1.25.11

### Fixed

- **`/reflect` Step 4 new-notes handshake: the marker is now anchored in plugin-data and the session id resolves from an env-independent source, so the hook (writer) and the skill bash (reader) finally meet across the process boundary.** Third and root fix for a bug v1.25.8 and v1.25.9 each diagnosed correctly but only half-resolved. Both prior fixes assumed the two sides could be made to agree by aligning the _formula_ they use (`process.env.TMPDIR || tmpdir()` on both, or the shared `learning-loop-session-id` file read the same way). They can't: the skill's Step 4 bash runs in the interactive shell, which exports `$TMPDIR` (e.g. `/tmp/claude-501`), while the hook runs in a subprocess that does **not** inherit it. `os.tmpdir()` _honors_ `$TMPDIR`, so the very same session resolved different temp dirs depending on which process asked — and `getSessionId()`, which also reads `os.tmpdir()`, returned the real 8-char id from the hook but `unknown` from the shell (verified live: `resolve-paths.mjs SESSION_ID` printed `unknown` under the shell's `$TMPDIR`, `ef5e9aa1` with it unset). So _both_ the marker dir and the id key diverged; the marker came up empty and Step 4.6 (Upstream Refinement) silently saw zero new notes. Fix has two parts: (1) the marker dir is now `plugin-data/reflect-scratch` (`DATA_PATHS.reflectScratch`) — plugin-data is resolved from `$CLAUDE_PLUGIN_DATA`/its persisted marker, not `$TMPDIR`, so it's identical in every subprocess; the skill resolves it via the new `resolve-paths.mjs REFLECT_SCRATCH` field and the hook via `reflectScratchDir()`. (2) `getSessionId()` (the canonical resolver in `scripts/lib/session.mjs`, used across ~5 call sites) now prefers an env-independent `plugin-data/session/id[-<ppid>]` over the legacy tmp files; SessionStart (`hooks/session-start/vault-snapshot.mjs`) stamps the id there in addition to tmp. The skill resolves the id via `resolve-paths.mjs SESSION_ID` (which runs `getSessionId()`); the hook calls it directly. The skill's bash no longer `cat`s the id file under `${TMPDIR:-/tmp}` at all. Tmp files are retained as a resolver fallback for sessions started before this change. `tests/reflect-new-notes-track.test.mjs` adds a real cross-process spawn (a child `resolve-paths.mjs` given a divergent `$TMPDIR` must build byte-for-byte the same marker as the in-process hook) plus a `$TMPDIR`-immunity assertion; `tests/lib-session.test.mjs` adds plugin-data-precedence coverage. Why v1.25.9's test passed while production broke: it set one `$TMPDIR` for the whole process and seeded the id file under it, collapsing away the two-process split that defines the bug. Full suite 651/0 (2 skipped).

- **`getPluginData()` no longer logs an error or writes to stderr when no plugin-data is configured.** A missing `.ll-data-path` marker is the expected no-plugin-data case (CLI, cron, tests), not a fault. Previously every call with no `$CLAUDE_PLUGIN_DATA` and no marker hit `readFileSync` on a non-existent path → caught + `logError('config.getPluginData', ENOENT)` + a stderr warning. That was harmless when the only callers were hooks (which always have `$CLAUDE_PLUGIN_DATA`), but the env-independent `getSessionId()` above now calls `getPluginData()` on a hot path, so the noise surfaced in CLI/test runs. `getPluginData()` now reads the marker only when it `existsSync`, staying silent otherwise; it still logs when the marker exists but is unreadable (perms/IO).

## v1.25.10

### Fixed

- **Session-start now sweeps orphaned `ll-search.*-bak` binaries and stale `convergence/` telemetry from the live plugin-data dir.** Two artifacts accumulated in the _current_ version's data, where the existing stale-version prune (which only removes whole version dirs older than the running one) never reached them. First, `bin/ll-search.*-bak` (~290M each): leftovers from the old delta-patch updater. That update path is gone — the current `download-binary.mjs` does an atomic tmp-file-plus-rename with no `.bak` — but any install that passed through the delta-patch era still carries 1–3 of these backups, and nothing ever deleted them (observed live: 621M across three `.preDelta*-bak` files on a single machine). Second, `convergence/*.json` discovery/verify session telemetry, which is regenerable and whose distilled knowledge already lives in the vault; files older than the new `CONVERGENCE_TTL_MS` (7 days, matching `SESSION_DEDUPE_TTL_MS`) are pruned. The sweep runs in `hooks/session-start/cache-cleanup.mjs` after the version-prune and before the binary-update block, is fully best-effort (missing dirs and vanished entries are swallowed via gated `debug()`, never `logError`), and never blocks session-start. New `bin`/`convergence` helpers added to `DATA_PATHS`. Covered by `tests/hook-session-start-stale-sweep.test.mjs` (deletes backups, preserves the live binary and `.version`, respects the TTL cutoff, no-ops cleanly when the dirs are absent).

## v1.25.9

### Fixed

- **`/reflect` Step 4 new-notes handshake: both sides now key the marker on the plugin's own session id (the shared `learning-loop-session-id` file), and the writer of that file resolves `TMPDIR` the same way its readers do.** Completes — and corrects — the v1.25.8 fix, which was itself incomplete. v1.25.8 pointed the skill bash at `$CLAUDE_CODE_SESSION_ID` and the hook at the stdin payload's `raw.session_id`. Both are harness UUIDs, but the plugin keys all its _other_ session state on a third id — an 8-char hex written at SessionStart to `learning-loop-session-id` and read everywhere via `getSessionId()`. So the marker path still didn't match the rest of the system, and worse, the sweep-hook-replay path (which replays subagent Writes) passes **no** `session_id` at all, so subagent-written notes diverged regardless. Aligning two of the four id sources produced a green review and a passing happy-path test while production stayed broken. Real fix: both the skill bash (`cat "${TMPDIR:-/tmp}/learning-loop-session-id"`) and `hooks/modules/reflect-track.mjs` (file read) now resolve the marker from that one shared file — the source the rest of the plugin already trusts. Second, independent bug found and fixed in the same pass: the file's _writer_ (`hooks/session-start.js`) resolved its temp dir with bare `os.tmpdir()` while the readers use `process.env.TMPDIR || tmpdir()`; when a SessionStart subprocess and a PostToolUse subprocess disagree on `$TMPDIR`, the id file lands in a dir the readers never check (observed live: file at `/tmp/learning-loop-session-id`, readers looking under `/tmp/claude-501/`). The writer now uses the identical resolution. `tests/reflect-new-notes-track.test.mjs` updated to drive the file-based path and the no-payload-id (sweep-replay) condition. The reflect-track suite passes deterministically (verified in isolation and under load).

### Known issues

- **A few real-binary spawn tests (`vault-search-session-start-refresh`, the `edge-infer` NLI daemon/subprocess pair) flake when the whole suite runs concurrently.** They shell out to `ll-search` and starve under full-suite CPU pressure; each passes cleanly in isolation. A prior attempt to "fix" this by widening the `vault-search` spawn timeout was wrong — the spawn completes in ~1.5s when not contended, so a wider deadline only lengthened the hang on a genuinely starved run — and was reverted. The correct fix (serialize these real-binary tests, or stub the binary) is deferred; for now treat a concurrent-run failure that passes in isolation as a harness flake, not a regression.

## v1.25.8

### Fixed

- **`/reflect` Step 4 new-notes handshake: the post-tool hook now reads the session id from its stdin payload, not `process.env`.** Completes the fix v1.25.4 only half-made. v1.25.4 corrected the env-var _name_ (`CLAUDE_SESSION_ID` → `CLAUDE_CODE_SESSION_ID`) on the assumption that the env var was the right source on both sides of the handshake. But the two sides don't run in the same environment: the skill's Step 4 bash runs in the Bash tool (which reliably has `CLAUDE_CODE_SESSION_ID`), while `reflect-track.mjs` runs in a PostToolUse hook subprocess that does **not** reliably inherit it. When the hook couldn't see the var it fell back to the literal `session`, computed `${TMPDIR}/ll-session-reflect-new-notes.txt`, found no marker there (the skill created `ll-<real-id>-reflect-new-notes.txt`), and returned silently — a missing marker is the module's entire "not tracking" signal, so nothing was logged. Effect: Step 4.6 saw an empty new-notes list and the agent hand-backfilled the paths. Fix: the harness passes the real id as the top-level `session_id` field in the hook's stdin JSON; `hooks/post-tool.js` now threads `raw.session_id` into the module context as `ctx.sessionId`, and `reflectNewNotesPath(sessionId)` prefers it (env var retained as fallback, `session` as last resort). Both sides now resolve to the same path regardless of whether the hook subprocess inherited the env var. The existing test set `CLAUDE_CODE_SESSION_ID` in setup, masking the field failure entirely; `tests/reflect-new-notes-track.test.mjs` gains a regression block that deletes the env var and asserts the payload id drives the path and the append lands in the skill-built marker (red against the old module, green against the fix). `native/Cargo.lock` also synced (`ll-search` entry was stale at 1.25.4).

- **NLI subprocess timeout is now env-overridable, de-flaking the `edge-infer` daemon/subprocess tests under parallel load.** The `runNliBatchViaSubprocess` `execFileSync` budget was a hardcoded 1500ms — fine in production (single hook fire, idle machine), but the two tests that fork the real `ll-search` stub to exercise the daemon→subprocess fallback (`tests/edge-infer-nli-daemon.test.mjs`, `tests/edge-infer-nli-subprocess-failures.test.mjs`) could exhaust it on the fork alone when the full suite saturates the CPU, failing non-deterministically (the comment at the injection seam already called the path "fragile under parallel test load"). `hooks/modules/edge-infer.mjs` now reads `LL_NLI_SUBPROCESS_TIMEOUT_MS` (default 1500, so production is unchanged); the two test files set a generous 15000ms file-wide, and the one test that genuinely asserts the timeout path sets its own tight 500ms budget with a short-sleep stub (also cutting that test from ~2.5s to ~0.5s). Full suite now passes 639/0 deterministically across repeated runs under load.

## v1.25.7

### Fixed

- **`ll-search migrate`: missing-DB diagnostic now fires before any model load.** Follow-up to v1.25.6 covering the one command that was out of scope last release. `Commands::Migrate` called `parse_model()` + `load_provider()` before `open_db()`, so the same cold-cache failure mode (model download crashes mid-flight, masking the real "database file does not exist" error) applied to `migrate` too. Fix: open the DB first; defer `load_provider()` to the non-`--drop-old` branch where the provider is actually used (the `--drop-old` path doesn't touch the provider at all, so the prior code was loading the model for nothing on that branch). Regression-test coverage extended in `tests/no_silent_db_create.rs::embedding_commands_check_db_before_loading_model` — `migrate` is now case 9 in the parametric set.

## v1.25.6

### Fixed

- **`ll-search` read-side commands: missing-DB diagnostic now fires before any embedding-model load.** `query`, `similar`, `cluster`, `discriminate`, `reflect-scan`, `rerank`, `eval-prf`, `eval-funnel`, and `tune-prf` all called `init_embedding()` before `open_db()`. On a cold HuggingFace cache, the model download would start first; the "database file does not exist" diagnostic was only reachable after the model had loaded. If the download itself crashed mid-flight (e.g. CI environments with constrained `$HOME` permissions, where the model move-into-place fails with `ENOENT`), the real error was masked entirely and the user saw a panic about file moves. This was the failure mode that broke CI on commits 2355597 and 66d4111 — `query_with_missing_db_does_not_create_file` panicked on a download-step error before reaching the "database file does not exist" assertion, even though the bug is genuine and predates v1.25.5 (locally invisible because Robin's HF cache is warm). Fix: every read-side command in `native/crates/ll-search/src/main.rs` now calls `open_db()` first; `init_embedding()` only runs once the DB existence check has passed. Sibling-command coverage added to `tests/no_silent_db_create.rs` (`embedding_commands_check_db_before_loading_model`) — pins the contract for all eight commands so any future reordering regression catches in cargo test, not only when CI's model cache misses.

## v1.25.5

### Fixed

- **`pre-write-check` false positives: removed body-`Source:` warning, taught broken-wikilink check about `6-writing/` and subdir-prefixed targets.** Two false positives were firing on roughly every vault write. (1) `checkBodySourceLeak` warned whenever a note had both a frontmatter `source:` field and a body `Source:`/`Sources:` line — but the established vault convention is that frontmatter `source:` records the capture-pipeline origin (reflect/discovery/ingest) while body `Source:` lines are citation URLs, and ~165 notes use both together. Removed the check entirely; the rule it enforced doesn't match how the vault actually uses the two fields. (2) The wikilink validator built its lookup set from `basename.md` only, and the vault snapshot deliberately omits `6-writing/` (it's in the edge-classifier's `EXCLUDE_FOLDERS`). Result: bare wikilinks like `[[the-loud-room]]` to notes living in `6-writing/`, and subdir-prefixed wikilinks like `[[3-permanent/foo]]` or `[[6-writing/foo]]`, all reported "not found in vault" even when the file existed. Fix in `hooks/lib/snapshot.mjs`: added `6-writing` to `TITLE_INDEX_EXTRA_DIRS` so its files get indexed for title lookup without shifting edge-classifier priority. Fix in `hooks/pre-write-check.js`: `buildNoteIndex` now returns `{basenames, relPaths}` and `noteExistsInIndex` consults both, so `[[3-permanent/foo]]`-style targets resolve against the snapshot's `rel_path`. True broken links still warn as before. Tests in `tests/pre-write-check.test.mjs` (3 new cases for 6-writing/subdir-prefixed resolution) and `tests/hook-pre-write-check.test.mjs` (body-source-leak case inverted to assert silence) pin both halves.

## v1.25.4

### Fixed

- **Session-id env var rename: skills and the `reflect-track` hook helper now read `CLAUDE_CODE_SESSION_ID` instead of the unset `CLAUDE_SESSION_ID`.** Claude Code exposes the canonical session id as `CLAUDE_CODE_SESSION_ID` (with the `CODE_` prefix); the unprefixed variant has never been populated, so every session-keyed tmp path in `/reflect`, `/ingest`, `/gaps`, and `/deepen` silently collapsed to the literal fallback `ll-session-*`. Effect: parallel skill invocations across two windows wrote to the same tmp files, racing on new-notes lists and refinement candidate batches — caught when a `/reflect` in one window picked up unrelated inbox notes from another. The plugin's internal `getSessionId()` in `scripts/lib/session.mjs` is unchanged; it has always read the ppid-keyed marker file written by session-start hooks and was never affected. Renamed across all 5 SKILL.md files, `skills/_shared/hook-replay.md`, `hooks/modules/reflect-track.mjs`, and the matching `tests/reflect-new-notes-track.test.mjs`.

## v1.25.3

### Fixed

- **`/reflect` Step 4 new-notes tracking: moved per-write append into the post-tool hook.** Old contract had Step 4 instruct the agent to `echo "$PATH" >> "${LL_TMP_PREFIX}-new-notes.txt"` after each vault Write, with the init `: > ...` and per-write `echo ... >>` lines living in the same fenced bash block separated only by an inline `# After each vault Write:` comment. Agents reading "after each Write, run this block" naturally re-ran the whole block per Write, re-truncating each time. Step 4.6 then built refinement pairs against only the last vault note in the session. New contract: Step 4 creates an empty marker file once; new `hooks/modules/reflect-track.mjs` wires into the post-tool chain and appends every vault Write/Edit path while the marker exists; Step 4.6.g `rm -f` ends the tracking window. Sub-agent Writes still flow through Step 4.4's `sweep-hook-replay.mjs` replay, which re-fires the new module. `tests/reflect-new-notes-track.test.mjs` (10 tests) pins both halves of the handshake — the SKILL no longer carrying a per-write echo fence, and the hook appending one-line-per-Write under the marker.

## v1.25.2

### Fixed

- **Binary auto-update on session start: closes the "plugin update bumps marketplace files but native binary lags" shipping gap.** `hooks/session-start/cache-cleanup.mjs` now compares the installed `ll-search` version against the running plugin version and spawns `download-binary.mjs` detached when they diverge. Fire-and-forget: the current session keeps using whatever binary is on disk, the next session boots with the fresh one. One-session lag, no blocking. Failure mode this fixes: Robin's machine sat on `v1.20.2` for five releases until the v1.25 `reflect-scan` path tripped the pre-fix `open_db` leak shape and surfaced the gap. Version comparison is `v`-prefix tolerant. Four regression tests cover matching/lagging/missing/v-prefix cases.
- **`skills/reflect/SKILL.md`: explicit warning against bare `ll-search reflect-scan`.** When `/reflect`'s Step 2.5 invocation gets reduced to `ll-search reflect-scan "query"` (without `DB_PATH` + `--config-dir`), clap consumes the first query string as `db_path` and the binary returns hits from an empty schema-only DB plus any federation peers — silent corruption. The fix is documentation: the bash block already names the `vault-search.mjs` wrapper, but a one-line warning makes the trap door visible.

## v1.25.1

### Fixed

- **`tests/no_silent_db_create::index_into_missing_path_DOES_create_file`** spawned `ll-search index` and asserted the parent dir was created post-run. Worked locally (cached embedding model) but failed in CI because `init_embedding` panics before reaching `open_or_create_db` when the ONNX runtime + model download isn't available. Replaced with a direct unit test of `ll_search::db::open_or_create_db` — no subprocess, no embedding-model dependency. Strengthened assertion: now checks both the parent dir AND the file get created. No shipped behaviour change; test-only fix.

## v1.25.0

### Changed

- **`lib/paths`: spatial-knowledge consolidation.** Added `DATA_PATHS`, `FEDERATION_PATHS`, `DATA_FILES` to `scripts/lib/paths.mjs` as the single source of truth for PLUGIN_DATA subdirectory and file paths. 25+ inline `join(pluginData, 'librarian'|'retrieval'|'provenance'|'federation'|'session-start-cache'|'edges.db'|'nli.sock'|'bin/.version')` constructions collapsed to named-constant calls across `scripts/` and `hooks/`. Refactoring a folder name now requires changing exactly one line. Internal helpers like `lib/marker-cache.MARKER_PATHS` and `lib/retrieval.writeRetrieval` use these constants too, so the canonical layer extends down to the leaf writers. `scripts/refinement-candidates.mjs` also drops a hardcoded `~/.claude/plugins/data/learning-loop-learning-loop-marketplace/edges.db` fallback while it's there.
- **Three audit follow-ups closed before v1.25 cut.** (1) `scripts/librarian/config.mjs` mtime+inode cache-busting was dead — `getConfig()` memoised forever, so the librarian's invalidation only cleared its own cache layer. Added `resetConfigCache()` to `lib/config.mjs`; the librarian now resets the upstream cache when its key changes, so hot-edited `config.json` actually propagates through. (2) `hooks/session-label.js` shadow-injection records now carry explicit `type` fields per branch (`gate-fail-fast-path`, `gate-fail-no-vault`, `gate-fail-below-threshold`, `gate-pass-no-payload`, `gate-pass-payload`) so the canonical writer's `command` field discriminates sub-types instead of falling back to the prefix. (3) Added `DATA_PATHS.retrievalSessionDedupe` and migrated the two inline `retrieval/session-dedupe` constructions.
- **`lib/file-lock.isProcessAlive`: exported, shared with watch/health-check daemons.** Six inline `process.kill(pid, 0)` liveness probes hand-rolled their own try/catch wrappers across `scripts/watch.mjs`, `scripts/health-check.mjs`, and `hooks/session-start/watch-daemon.mjs`. Now all call the canonical helper, which correctly treats EPERM as "process exists, owned by another user/SYSTEM" (cross-platform). One audit-surfaced bug fixed in passing: `scripts/health-check.mjs:readVaultRoot` reimplemented vault-path resolution without consulting `VAULT_PATH` env — would have silently used a different path than every other caller on installs with `VAULT_PATH` set. Now delegates to canonical `getVaultPath`.
- **`lib/retrieval`: canonical retrieval ledger writer.** Two prior writers (`scripts/vault-search.mjs:logRetrieval` and `hooks/lib/common.mjs:emitRetrieval`) emitted incompatible record shapes into the same `PLUGIN_DATA/retrieval/` directory. Now both delegate to `scripts/lib/retrieval.mjs:writeRetrieval`. **Record-shape change for downstream analytics:** hook-side records (memory-reads, episodic-search events, shadow-injection events) used to be a passthrough spread of `{ts, session_id, ...event}` — no `command`, no `query`, no `result_count`. They now carry the canonical shape `{ts, session_id, command, query, result_count, peer_results, top_paths, ...event}`. Field mapping at the adapter: `command = event.type || event.command || prefix`, `query = event.query || event.file || ''`, `results = event.results || null`. Vault-search records are unchanged in shape.
- **`lib/migrate-retrieval-logs`: one-shot install-time cleanup.** Pre-canonical `.jsonl` files under `PLUGIN_DATA/retrieval/` are removed on `install-shims --install`, marked complete with `<plugin-data>/.retrieval-migrated-v2`. Idempotent — second invocation skips with `already-migrated`. **Narrowed delete:** only files matching the four pre-canonical prefixes the canonical writer now owns (`queries-`, `reads-`, `episodic-queries-`, `shadow-injection-`) are removed. Third-party retrieval logs (e.g. `cache-health-*.jsonl` written by `plugins/omc-cache-health` and read by `scripts/cache-health-report.mjs`) are preserved. Mixing the old passthrough/inline shapes with the canonical shape would muddy downstream analytics; clean break preferred to a mixed-shape transition.
- **`lib/edges` + `lib/sources/citation-index`: migrated to `lib/file-lock`.** Both files hand-rolled the O*EXCL + stale-PID-recovery lock pattern that `lib/file-lock.mjs` was built to replace, and both carried the same nested-empty-catch silent-failure shape Phase 3 just fixed in `file-lock` itself. `edges.mjs` keeps its public `acquireLock(dbPath) / releaseLock(dbPath)` contract (used by `edge-infer.mjs` and `edges-cli.mjs`) via a thin path-keyed wrapper; path-mismatch release attempts now surface via `logError` instead of silently swallowing. **`citation-index.mjs` behaviour fix (larger than initially stated):** the prior `_doUpdate` called `acquireLock()`, then ran the entire load/mutate/save critical section \_whether or not the lock was acquired*, only skipping the release. Under contention this meant two processes could race the load/mutate/save cycle and one would lose its mutation entirely — a real data-loss bug, not just a silent one. The migration to `withLock` makes acquisition mandatory: `ELOCK_TIMEOUT` is now logged via `logError` with `{pmid, noteFilename}` and the update is a no-op rather than an unsafe write. Contract test pins `resolveConfig === getConfig`, `getSessionId === session.getSessionId`, and the other Phase 1/2/3b aliases against future re-divergence.
- **`lib/config.getConfig`: single source of truth for config loading.** `hooks/lib/common.mjs:resolveConfig` is now a re-export of `getConfig`. Two behavioural deltas to know about: (a) config is cached after first read — a hot-edit of `config.json` mid-session no longer takes effect until the next session (audit confirmed no live hot-editor exists; only test fixtures and the migration helper write the file), (b) a legacy `<plugin-root>/config.json` is now migrated into the primary `<plugin-data>/config.json` on the first hook fire of a fresh install (already happened on the script side; now consistent across hooks too). Local `readJsonStripBom` deleted with the function it served.
- **`lib/file-lock`: silent failures in stale-lock recovery and release now surface via `logError`.** Three of four empty catches in `file-lock.mjs` were broader than their comments admitted: they swallowed every error code, but only one code per site is the expected race. `tryRemoveIfStale`'s inner mtime-fallback catch now logs everything except ENOENT (the expected race when another process unlinked the lockfile mid-recovery). `releaseLock`'s `unlinkSync` catch now logs everything except ENOENT (same race — and EACCES/EBUSY/EPERM/EROFS here mean the lockfile _leaked_, blocking the next acquirer for 60s). `releaseLock`'s `closeSync` catch now logs everything except EBADF (the expected case when release was called twice). The one remaining intentional silent catch is the outer `tryRemoveIfStale` fallback — documented in place. `tryRemoveIfStale` and `releaseLock` gained optional dependency seams (`statFn`, `closeFn`, `unlinkFn`) for testing — defaults preserve runtime behaviour.
- **`lib/config.getVaultPath`: single source of truth for vault path resolution.** Four implementations collapsed into one (`refinement-candidates.mjs`, `hooks/lib/common.mjs`, `spike-classifiers-v2.mjs`, plus the canonical one). `refinement-candidates.mjs` no longer has a hardcoded `~/brain/brain` fallback — explicit exit(2) with a diagnostic when vault is unconfigured. Side fix: refinement-candidates now consults `VAULT_PATH` env (it didn't before, only checked config.json). `spike-classifiers-v2.mjs` migrated the same way. `hooks/lib/common.mjs:resolveVaultPath` is now a re-export of `getVaultPath`; consequence — a `VAULT_PATH=~/vault` value now expands `~` (was treated as literal `./~/vault`).
- **`scripts/lib/session.mjs`: single source of truth for session-id resolution.** Three call sites (`hooks/lib/common.mjs`, `scripts/provenance.mjs`, `scripts/vault-search.mjs`) each carried their own copy. The vault-search copy was the broken outlier — it read only `learning-loop-session-id` (unsuffixed), missing every ppid-bound session, so retrieval-ledger entries silently logged against the wrong session_id. Now all three import from `lib/session.mjs`. Retrieval ledger and hook provenance correlate again.

### Fixed

- **ll-search no longer leaks empty SQLite files on wrong-shaped invocations.** Read-side subcommands (`query`, `status`, `tags`, `intentions`, `sessions`, `link-stats`, `similar`, `cluster`, `discriminate`, `reflect-scan`, `rerank`) now error fast when the db file is missing instead of silently creating one. Root cause: clap's positional `db_path: String` accepted query strings as paths, and `db::open_db`'s unconditional `Connection::open` + `create_dir_all` materialised a fresh schema file at whatever path drifted in. Internally split into `open_db` (read; requires existence) and `open_or_create_db` (write; only `index` and `watch` use this). New regression test: `tests/no_silent_db_create.rs`.

## v1.24.0

### Felt-quality uplift

A focused release that touches the hot path of every session: session-start, MEMORY.md injection, persona consistency, and write-time hygiene. Bench: session-start p50 dropped ~270ms → ~200ms (-26%) once the three blocking subprocesses are no longer in series.

### Added

- **`scripts/lib/marker-cache.mjs`** — single source of truth for session-start cache file paths. Exports `MARKER_PATHS` (canonical path constructors for `intentions` and `dreamGate`), `MARKER_TTL_MS` (25h), `readMarker`, `writeMarker`. Hook (reader) and worker (writer) both resolve paths via the same function — drift is impossible by construction.
- **`LEARNING_LOOP_ALWAYS_INJECT_MEMORY=1`** env override. Forces MEMORY.md injection regardless of mtime. Default behaviour (off) gates injection on 7-day freshness.

### Changed

- **session-start: three blocking subprocesses detached.** `vault-search intentions`, `dream-gate`, and `provenance.mjs` no longer run via `execFileSync` on the SessionStart hot path. Each now fires as a detached `spawn`, returning immediately. `intentions` and `dreamGate` write their output to marker files; the next session reads what's there. Tradeoff: weekly-cadence signals (dream nudge, intention summary) are one-session-stale. p50 measured at 200ms post-change vs 270ms baseline.
- **dream-gate: marker-write on every exit path.** Five early-exit gates (already-running, <24h, never-dreamed, no-project-dir, no-memory-dir) plus the nudge-emit path all write the cache marker when `--session-start-refresh` is set. Prior real nudges are preserved through a crashed refresh (read-before-null-write); TTL caps stickiness at 25h.
- **MEMORY.md injection gated on 7-day mtime.** Project + global memory indices only inject when modified within the last week. ~4-6KB context savings per session during deep-focus weeks. Override via `LEARNING_LOOP_ALWAYS_INJECT_MEMORY=1`.
- **Writing agents route through `_system/persona.md`.** `note-writer`, `note-deepener`, `literature-capturer`, `ingest-synthesizer` no longer hardcode "Hemingway + Musashi + Lao Tzu." Persona file is the source of truth; edits propagate automatically. `ingest-synthesizer`'s "if accessible, otherwise default to..." hedge removed.
- **`pre-write-check` warns on body-source leak.** When a vault note has both a frontmatter `source:` field AND a `Source:`/`Sources:` line in the body, the hook emits a warning citing capture-rules. Warning-only (does not block the write).

### Internal

- **`scripts/lib/env.mjs`** picks up `LEARNING_LOOP_ALWAYS_INJECT_MEMORY` as a frozen `isTruthy` snapshot. Direct `process.env` access remains forbidden outside `env.mjs`.
- 11 new integration + unit tests across marker-cache, hook-session-start, dream-gate, pre-write-check. Test count: 567 → 578.

## v1.23.1

### Fixed

- **`ll-search sync --hub-endpoint <url>` without `--peer-id` now fails fast.** The validation was running inside `load_config_with_override`, after `init_embedding()` had already loaded the ONNX model. On CI runners that triggered a fresh huggingface download, the rename-into-place step could fail with `ENOENT` before the user-facing error message could fire. Validation now runs at the top of the `Sync` branch in `main.rs`, before the embedding model is touched.

## v1.23.0

### Added

- **`/learning-loop:doctor` skill.** Diagnoses your learning-loop install: runs 20 health checks (file presence, plugin state, binary executability, watch-daemon status, NLI socket, ABI drift, version comparison, etc.), presents the result, offers per-fix remediation (auto-runnable fixes execute on consent; manual ones print the command), and re-runs each check after the fix to confirm. Safe to run anytime, makes no changes without approval.
- **Session-start health detector.** A new `hooks/session-start/health-detector.mjs` replaces `deps-check.mjs`. Reads a 12h-TTL cache at `<plugin-data>/last-health.json`; when stale, runs the quick-check subset (~50ms, no shell-outs) and refreshes the cache. Emits a single line above the prompt when any failure-severity checks are unhealthy: `⚠ learning-loop: N issues — run /learning-loop:doctor`. Quiet otherwise. Honors `LL_DISABLE_DETECTOR=1`.
- **`scripts/health-check.mjs` library.** Pure check library: `quickChecks()` (file-existence, version reads — ~50ms), `fullChecks()` (CLI invocations — ~500ms), `formatMissingDeps()` (preserves the markdown context-assembly previously got from deps-check). One source of truth shared by `/init` Phase 1, `/doctor`, and the session-start detector.

### Changed

- **`/init` Phase 1 detection delegates to the library.** The dashboard's data now comes from `scripts/health-check.mjs` instead of inline `fs.readdirSync`/`execSync` calls. Federation, hub-sync, librarian, and model-notes rows remain inline (init-specific concerns, not general health).
- **`scripts/check-deps.mjs` thinned to a wrapper.** Logic moved to `scripts/check-deps-impl.mjs` so other modules can import `detectAbiDrift` without spawning a subprocess. The CLI's JSON output shape is preserved.

### Removed

- **`hooks/session-start/deps-check.mjs`.** Subsumed by the health detector. `ctx.depsAllSatisfied` and `ctx.depsMissing` (read by `context-assembly.mjs`) are populated by the new detector with the same semantics.

## v1.22.1

### Fixed

- **Synthesis hub notes routed to `5-maps/` automatically.** Before this fix the promote-gate had no path to `5-maps/` at all: hub-shaped synthesis notes (discovery synthesis, MOC indices, round-N positioning notes) all landed in `3-permanent/`, polluting the atomic-claim surface. `scripts/promotion-gate.mjs` now routes notes to `5-maps/` when all three conditions hold: (1) all applicable criteria pass, (2) frontmatter signals synthesis via `source: synthesis`, `source: discovery`, or `synthesis` in `tags`, and (3) the body contains ≥10 wikilinks outside fenced code blocks (`MAP_LINK_THRESHOLD`). Borderline synthesis-tagged notes below the link-density threshold stay in `3-permanent/` (they're atomic claims that happen to be about synthesis, not hubs).
- **`promoteWithVerification()` respects caller destinations for `2-literature/` and `5-maps/`.** Previously the gate would override any caller destination and re-run the criteria check, which silently demoted hand-placed maps and literature notes. Now both folders are treated as caller-only destinations: when set via `note.callerDestination`, the verifier is skipped and the destination passes through unchanged.
- **`skills/discovery/SKILL.md` writes synthesis hubs to `5-maps/` directly.** The wrap-up step now routes synthesis notes with ≥10 trail-note wikilinks straight to `5-maps/` instead of `0-inbox/`. Thin-link sessions still land in inbox where the promote-gate's hub-detection rule will catch them if they grow link density via later `/deepen` or `/inbox` passes.
- **`agents/_skills/promote-gate.md` documents the `5-maps/` routing row, the synthesis-hub trigger, and the override rules for `2-literature/` and `5-maps/`.** The routing table previously terminated at `3-permanent/`; the override rules made no mention of `5-maps/` and the only `2-literature/` rule was a single sentence.
- **`agents/note-writer.md` documents `5-maps/` as a valid destination.** The destination field previously listed only `0-inbox/`, `1-fleeting/`, `2-literature/`, and `3-permanent/`, even though `5-maps/` was declared in `vault-io.md` as the home for synthesis maps and MOCs.

### Tests

- 10 new tests in `tests/promotion-gate.test.mjs` covering the synthesis-hub routing rule, link-density threshold edge cases, marker precedence over synthesis-hub routing, caller-only `2-literature/` and `5-maps/` semantics, and `source: discovery` triggering the hub rule. Full suite: 531 pass / 0 fail / 2 skipped.

## v1.22.0

### Added

- **`install.sh` bootstrap script + curl|bash one-liner install.** Takes a fresh macOS/Linux/WSL machine to a state where `/learning-loop:init` can be run in ~3 minutes with continuous feedback. Detects existing Node version managers (nvm, fnm, volta, asdf, mise, n, brew) and uses the user's preferred tool; offers fnm only when none is found. Installs Claude Code via `curl -fsSL https://claude.ai/install.sh | bash` if missing. Adds both marketplaces and installs both plugins. Idempotent: re-running on a fully-set-up machine reports "Already set up". Never silently sudo. Spinner + log tee during long-running steps so users see progress. Reads interactive prompts from `/dev/tty` so the script survives both `./install.sh` and `curl ... | bash` invocations. Logfile at `~/.cache/learning-loop-install.log`. Install one-liner now in the README.
- **`ll-search sync --hub-endpoint <URL>` and `--peer-id <ID>` flags.** Enable atomic federation onboarding: the federation skill spawns `ll-search sync` before writing `federation/config.json`, so a failed sync leaves no half-written state. When `--hub-endpoint` is provided, the binary builds a minimal `FederationConfig` in-memory from the seed store instead of reading config from disk. `--peer-id` is required in that mode because the sync handshake uses `identity.display_name` as the peer_id and the hub binds peer_id server-side at redeem time. Falls back to `LL_HUB_ENDPOINT` / `LL_PEER_ID` env vars when flags are absent.

### Fixed

- **`ll-watch stop` could not stop a SessionStart-spawned watcher.** `scripts/watch.mjs` wrote the pidfile to `<pluginData>/watch.pid`; `hooks/session-start/watch-daemon.mjs` writes to `<vault>/.vault-search/watch.pid` and unlinks the legacy path. Aligned `scripts/watch.mjs` to the per-vault path so `ll-watch stop` finds and terminates the daemon.
- **Rerank ONNX inputs introspected at session load.** `token_type_ids` is now derived from ONNX initializers rather than assumed present, fixing rerank failures against models that omit the field.

### Tests / CI

- 29 bats unit tests for `install.sh` covering version comparison, PATH marker idempotency, shell-rc detection (bash/zsh/fish/nu/unknown), platform detection (darwin/linux/unsupported), proxy env-var detection, step helpers under `set -u`, `run_logged` exit-code propagation, manager-detection priorities, and the curl|bash EOF-stdin regression.
- New GitHub Actions workflow `install-script.yml` runs the bats suite on PRs touching `install.sh`, the test file, or the workflow itself. End-to-end install matrix is intentionally out of CI (would require an authenticated Anthropic session on the runner).

## v1.21.2

### Added

- **eval-funnel:** new `ll-search eval-funnel <db>` CLI command runs a six-config cumulative ablation over the retrieval stack (vec / vec+bm25 / vec+bm25+ppr / vec+bm25+ppr+tag / +prf / +rerank) on the same wikilink-grounded query set as `eval_prf`. Emits R@5, R@10, NDCG@10, MRR, and Hits@1 per stage. `--limit N` caps the query count for fast turnaround. Useful for measuring per-stage contribution before introducing new signals or swapping the embedding/rerank model.
- **`StageFlags`** (in `ll-search::search::context`) gates each retrieval stage. Production callers stay on the default (all on); eval harnesses override individual flags. Pairs with the new `rrf_from_signals_gated` method that skips disabled stages without recomputing signals.
- **NDCG@10** added to `EvalConfig`. The existing `eval_prf` output now surfaces it alongside R@5/R@10/MRR/Hits@1.

### Changed

- **`eval_funnel` reuses a single `compute_signals` call per query** across all cascade configs. The rerank stage reuses the same signals and pays only the cross-encoder body-load + score cost.

## v1.21.1

### Added

- **check-deps:** detect native-module ABI drift in installed plugins. `scripts/check-deps.mjs` exports a new `detectAbiDrift()` function and surfaces drift on the JSON output as `_abi_drift`. Currently watches `episodic-memory@1.0.15`'s `better-sqlite3` binding — a future Node bump will surface a fix command in `/health` instead of silently breaking `/reflect` and episodic search.
- **promotion-gate:** new `scripts/promotion-gate.mjs` exports `canPromote(note)` (pure) and `promoteWithVerification(note, { verifier })` (async wrapper). Verification markers (`[unresolved]`, `[unverified]`, `[not in abstract]`, `[not in source]`) anywhere in a note's body now block promotion to `3-permanent/` and route to `1-fleeting/`. Markers inside fenced code blocks are ignored.
- **route-project-artefact:** new `scripts/route-project-artefact.mjs` exports `extractProjectSlug()`, `routeArtefact()`, and `readVaultProjectIndex()`. Notes whose filename matches a slug in `4-projects/` (file or directory) auto-route to that subfolder instead of `0-inbox/`. Closes the recurring papercut where interview-prep, client-brief, and evidence-bundle artefacts landed in the atomic-insights inbox.
- **inbox-organiser:** verification gate wired into the promotion path. Before any `mv` to `3-permanent/`, the gate calls `promoteWithVerification()` which invokes `source-resolver.mjs verify-note` for non-synthesis notes; high-severity issues demote to `1-fleeting/`.
- **note-verifier:** now emits `verify` (per-note summary) and `score` (per-finding) provenance events with the `skill: "verify"` field. Closes the v1.19+v1.20 observability gap where `/verify` ran but didn't emit structured events.
- **capture-rules:** Finding-Type Discriminator section disambiguates `source-missing` (cited source failed) from `logical-gap` (no citation attempted). Both finding types previously ran ~33% ambiguous in provenance.
- **tests:** 22 new unit tests (`check-deps-abi` × 4, `promotion-gate` × 9, `route-project-artefact` × 8, `episodic-memory-binding` × 1).
- **`getNliEdgesForNote(db, notePath, minConfidence)`** in `scripts/lib/edges.mjs` — bidirectional NLI edge lookup returning rows with a `partner` field. Used by Bundle 2 (promotion gate, refinement-proposer pair hint, /verify consistency detection). Excludes peer NLI edges via literal `source_graph='nli'` (federation authority handling deferred).
- **`LL_NLI_HARD_THRESHOLD`** (default 0.95) and **`LL_NLI_TENSION_THRESHOLD`** (default 0.75) env-var constants exported from `hooks/modules/edge-infer.mjs`, with an ordering invariant (`TENSION <= contradiction-write <= HARD`) enforced at module load. Misconfigured ordering throws loudly rather than silently breaking surface tiers.
- **Bundle 2 promotion-gate wiring.** `inbox-organiser` Step 3a.5 buckets NLI contradictions into hard (≥0.95, surface-and-confirm prompt with supersede/qualify/keep-both/skip) and soft (0.75–0.95, `nli_tension`/`nli_tension_partners` frontmatter stamp) tiers; gated actions surface alongside merges/deletes in one approval phase. `refinement-proposer` accepts nullable `nli_contradiction` / `nli_entailment` per pair with conflict-resolution rules in the decision rubric. `scripts/refinement-candidates.mjs` populates these fields from `edges.db` (degrades to null on DB error per hint-mode rule). `/verify` Step 4 augments embedding-only consistency with NLI lookup; NLI hard contradictions bump to high-priority in Step 7 fix plans. `promote-gate.md` adds an NLI subsection covering the gate logic and escape hatches (`nli_resolved: deliberate` frontmatter, `--skip-nli` flag).

### Changed

- **capture-rules:** verification markers are load-bearing (was: informational). The promote-gate honours markers; an `[unresolved]` source on a deep, well-linked note blocks promotion to permanent.
- **promote-gate:** routing table prepended with a marker-blocks row + reference to the new programmatic gate (`canPromote()`).

### Removed

- **NLI viz layer dropped entirely.** Removed `scripts/regenerate-viz.mjs`, `scripts/clear-nli-frontmatter.mjs`, `skills/viz/`, `skills/clear-nli/`, and 12 viz/clear-nli/legacy-edge tests. Removed the `nli_frontmatter_tags` and `viz_meta` SQLite tables and the helpers `getNliEdgesForFrontmatter` / `getAllNliEdgesForHeatmap` / `getEdgesForCycleDetection` / `getTaggedNotes` / `replaceTaggedNotes` / `addTaggedNote` / `removeTaggedNote` / `getMetaFlag` / `setMetaFlag` from `scripts/lib/edges.mjs`. Removed `--no-viz` flag and viz regeneration step from `/reflect` (Step 4.45) and `/ingest` (Step 5.55). Vault outputs `_system/nli-conflicts.md` and `_system/viz/cycles.canvas` deleted, along with any `.bak` files from prior rollbacks. **MIGRATION**: `nli-contradicts`, `nli-supports`, `has-contradiction`, and `has-entailment` frontmatter keys are no longer written to vault notes. A one-time cleanup pass stripped stale viz-generated frontmatter from all existing notes before the script was deleted. Rationale: wikilinks in YAML frontmatter are graph-invisible to Obsidian's native engine, and the canvas + heatmap had no AI-consuming downstream. NLI edges remain durable in `edges.db` with `source_graph='nli'`; consumers query via `getNliEdgesForNote` rather than parse vault filesystem artifacts.

### Fixed

- **Watch daemon lock now keyed on the vault, not the plugin install.** Pidfile, fingerprint, and lockfile moved from `<plugin-data>/watch.pid` to `<vault>/.vault-search/watch.pid`. The previous layout let two installations (e.g. a real install plus a test sandbox) each spawn their own daemon against the same SQLite index, with no shared mutual exclusion. Includes a one-shot migration that SIGTERMs and removes any daemon still running off the legacy `<plugin-data>/watch.pid` path before checking the new location.
- **Watch daemon no longer restarts on every SessionStart.** The "should we restart this daemon?" check compared the Rust crate version (written into `watch.version` via `env!("CARGO_PKG_VERSION")`) against the npm plugin version (from `package.json`). These drift independently across releases, so every SessionStart saw a mismatch, SIGTERMed the daemon, and restarted the librarian child along with it. Replaced with a binary mtime fingerprint stored in `<vault>/.vault-search/watch.fingerprint`. The mtime changes only when the binary file changes, which is exactly when a restart is warranted.
- **`PreCompact` hook output now validates against Claude Code's hook schema.** `PreCompact` does not accept `hookSpecificOutput.additionalContext` (the universal schema only allows that field on `UserPromptSubmit`, `PostToolUse`, and `PostToolBatch`), so the prior hook silently produced a JSON validation error every time it fired. The hook now emits `{}` and delegates capture work to a detached worker that reads the pre-compaction transcript and asks the librarian's already-warm `gemma4:e2b` (via the existing ollama-client) to extract atomic notes into `0-inbox/`. Opt-in via `LEARNING_LOOP_PRECOMPACT_SPIKE=1`.
- **ingest-profile:** `tests/ingest-profile.test.mjs` and `scripts/ingest-profile.mjs:gitInfo()` now strip `GIT_*` env vars before shelling out to git. Without this, the inner `git commit` (in the test) and the origin-lookup (in the script) inherited `GIT_DIR`/`GIT_WORK_TREE` from a parent pre-commit hook, landing commits in the wrong repo and returning the wrong origin URL. The recursive-lefthook flake that created phantom `init` commits in worktrees is closed.

### Internal

- **Test harness reaps watch daemons on cleanup.** `tests/helpers/hook-runner.mjs` `cleanup()` now reads pidfiles from both legacy and new locations, SIGTERMs each pid (with a 200ms grace and SIGKILL fallback), then rms the sandbox. Detached daemons spawned during hook tests are no longer left as zombies.
- **Rust binary no longer writes `watch.version`.** With the JS side now identifying the running daemon by binary mtime fingerprint, the version file is unused. Removed the write from `PidGuard::new`, the matching `Drop` cleanup, and the `version_path` field.

## v1.21.0

### Added

- **`/learning-loop:ingest repo` gains a deep fan-out path.** Beyond a Haiku-gated threshold (or when `--deep` is passed), the coordinator spawns 4 parallel deep-mapper subagents (`ingest-mapper-stack`, `ingest-mapper-arch`, `ingest-mapper-conventions`, `ingest-mapper-domain`) plus 1 ephemeral state sidecar (`ingest-mapper-state`). Each durable mapper writes a structured doc with file:line citations to `<vault>/_ingested-repos/<slug>/`; the state sidecar returns inline JSON. A synthesizer agent (`ingest-synthesizer`, Opus) merges the four docs into `confirmed_insights` JSON consumed by the existing route-output pipeline. Coordinator post-fanout audit (`scripts/ingest-postfanout-audit.mjs`) verifies docs land at expected paths regardless of hook firing. `/learning-loop:ingest repo <path>` continues to use the existing single-pass agent for thin repos; `--deep` overrides the gate.
- **Optional ygrep installer in `/learning-loop:init`.** Offered once during phase 3e.5 (skipped if `ygrep` already on PATH). Used by deep mappers as code-search primitive; mappers fall back to `Grep`+`Glob` when absent.
- **Provenance log `ingest-provenance.jsonl`.** One JSONL line per ingest run records tier (single/parallel), gate reason, mapper acks, synthesizer outcome, audit pass/fail, and ygrep usage. Future-work: `ingest-provenance-report.mjs` for hit-rate and regret analysis.
- **`_ingested-repos/` is a top-level system folder.** `_`-prefixed so existing `VAULT_DIRS` constants (snapshot, autolink, edge-classifier, fleeting-sweep) ignore it. Atomic notes generated by ingest cite the structured docs as `[[../_ingested-repos/<slug>/STACK]]`-style links.

### Internal

- **Layer 1 (frontmatter `tools:` allowlist) + post-fanout audit form the perimeter.** Per the 2026-05-15 PreToolUse-on-subagent probe (indeterminate result, treated as NO per Claude Code issue #34692), Phase 5 hook enforcement was deferred. `scripts/ingest-policy.mjs` writes a session-keyed policy file that is currently a no-op shim, ready for activation if/when subagent hooks become reliable.

## v1.20.6

### Changed

- **`episodic-memory` is now declared a required dependency.** `config.json` flips `required: false` to `true`, matching the gate-mode design the plugin already enforces (no SQLite text-search fallback exists). The README install block adds `obra/superpowers-marketplace` so users can install `episodic-memory` before installing learning-loop. No runtime behaviour change beyond what the session-start hook already did: this commit makes the contract explicit in `config.json` and the README.
- **`check-deps.mjs` distinguishes required vs optional dependencies.** The output's `required` field used to hold the version constraint string (now renamed `versionConstraint`); `required` is now an explicit boolean derived from `config.json`. The session-start hook renders missing required deps under "Missing Required Dependencies" with blocking urgency and missing optional deps under "Missing Optional Dependencies" with informational framing. `depsAllSatisfied` (which gates the episodic-memory step of the retrieval protocol) only flips to false when a _required_ dep is missing or outdated — missing optional deps no longer suppress that step. The `/init` phase 3e and `/health` step 1.5 skill docs also thread the distinction through presentation.

## v1.20.5

### Internal

- **NLI integration tests no longer fork a shell-script stub.** Two test files (`edge-infer-wikilink-removal-integration`, `edge-infer-regex-and-nli-both-fire`) wrote a `/bin/sh` stub to a temp dir and let `runEdgeInfer` fork it through `runNliBatchViaSubprocess`. That call has a 1500ms `execFileSync` timeout; under full-suite parallel load the fork+exec occasionally crept past 1500ms, the timeout fired, the catch block returned `[]`, and the test asserted on a missing NLI row. A flake we caught took 1509ms wallclock — 9ms over the timeout. `edge-infer.mjs` now exposes `__setNliBatchOverrideForTesting(fn)`: when set, `runNliBatch` returns the override's results without touching the daemon or subprocess paths. Production has zero references to it; tests that inject restore `null` in teardown. The four migrated tests dropped from 160–1509ms each to 3–5ms each. The daemon-orchestration test (`edge-infer-nli-daemon`) and the real-binary truncation test (`edge-infer-nli-truncation`) are intentionally untouched — they specifically exercise the fork and binary contract.

## v1.20.4

### Fixed

- **Refinement validator corrupting pre-existing em-dashes.** `stripEmDashes` ran across the entire `proposed_body`, so upstream prose the agent legitimately preserved verbatim (em-dashes included) got rewritten to `, ` with a doubled-space artefact, and `em_dash_violation` fired on text the agent never authored. The validator now runs a line-level LCS between the upstream body and the proposed body and only strips em-dashes from inserted or modified lines; lines that match the upstream verbatim pass through untouched. Contract change: `em_dash_violation` now counts em-dashes the agent _added_, not em-dashes anywhere in the proposed body. Modified lines stay conservative — any edit to a line means the agent owns its em-dashes there.

## v1.20.3

### Added

- **zstd compression on v3 body uploads.** Both `upload_full` and `upload_patchset` now run their body through `sync::compression::zstd_encode` (level 3) before chunking; the v3 envelope's `body_encoding` flips from `"raw"` to `"zstd"`. Compressing whole-body before splitting preserves the zstd dictionary context across chunks (per-chunk compression would cost 10-15% of the ratio). Observed ratios on the live vault: full export 16.87 MB to 7.59 MB on wire (55% reduction, dropping from 5 chunks to 2), single-file-change patchset 86 KB to 6.6 KB on wire (93% reduction). Stacks on top of the Phase 2 delta path, so a per-change ongoing sync now ships ~6.5 KB versus the 16 MB single-frame baseline before any of this work landed (~2,500x reduction). The hub side reads body_encoding off the envelope and applies the matching decompressor with a 500 MiB cap; rollback is a one-line flip back to `body_encoding="raw"` without touching the hub.

### Fixed

- **Subsequent patchsets falling back to full upload.** SQLite `apply_changeset` produces a row-equivalent but not byte-equivalent DB compared to the client's `local-export.db` (page layout differs, free-list ordering rearranges), so after one successful patchset the client's `base-export.sha256` disagreed with the hub's `index.db.sha256` and the next patchset attempt was always rejected with `patchset base mismatch, send full`. The hub now echoes its post-apply content hash in `SyncAck.stored_sha256`; the client persists that as the next base sha. Falls back to the client's locally-computed export hash when the field is absent (older hub or non-v3 path). Without this fix, Phase 2 delta sync was a one-shot win that degraded back to full uploads on every subsequent sync.

## v1.20.2

### Added

- **Patchset upload format.** Sync now diffs the local export against the hub's last-known snapshot and uploads only changed rows when the bases match, falling back to a full upload otherwise. This is the "Phase 2 delta path" that v1.20.3 builds on with zstd compression.

### Fixed

- **NLI advisory edges were absent from non-CI builds.** `nli` was a non-default Cargo feature on `ll-search`, so any `cargo build` without `--features nli` produced a binary without the `nli-check` / `nli-batch` subcommands and without the UDS daemon module. The hook's daemon path returned `socket-error` (no socket), the subprocess path returned `unrecognized subcommand`, and `edges.db` accumulated zero `source_graph='nli'` rows — `_system/nli-conflicts.md` rendered "Total: 0" and `_system/viz/cycles.canvas` only carried regex `challenges_*` edges. CI was unaffected (`build-native.yml` already passes `--features nli`), but any developer or platform reaching for a plain `cargo build` got a silently NLI-stripped binary. `default = ["nli"]` now; opt-out is `--no-default-features`.

## v1.20.1

### Added

- **v3 chunked sync protocol for vault uploads.** When negotiated with a sync-hub advertising `protocol_version >= 3`, the client splits the index DB into chunks (default 4 MiB, capped at 8 MiB) and uploads each as a separate `ChunkedFrame` after the JSON envelope. Wire layout is `seq | total | body_size | body_sha256` (44-byte header, big-endian u32s). Per-chunk sha256 is verified on decode; a flat manifest root (`sha256(c0_hash || c1_hash || ... || cN-1_hash)` in seq order) verifies the assembled body matches what the envelope promised. Out-of-order delivery is permitted; the hub reorders by seq. New `auth::create_envelope_v3` builder, `protocol::ChunkedFrame`, `protocol::manifest_root`, plus `PROTOCOL_VERSION_CHUNKED = 3` and `PROTOCOL_VERSION_LATEST = 3` constants. SyncHello now advertises `PROTOCOL_VERSION_LATEST`; the hub negotiates `min(client, server)` so v2 and v1 hubs still get their respective single-frame paths with no code-path regression.

### Fixed

- **Sync failure above 16 MiB vault size.** Single-frame uploads were dying with `Broken pipe (os error 32)` after `Authenticated` because tokio-tungstenite's 16 MiB `max_frame_size` default rejected the body before axum's `WebSocketUpgrade::max_message_size(50 * 1024 * 1024)` could see it. The v1.19.0 envelope framing was correct for the protocol but didn't account for the underlying tungstenite frame ceiling. The v3 chunked path keeps every frame under 8 MiB so the ceiling stops mattering.
- **`tests/stop-nudge.test.js` isolates `TMPDIR` per-run** so dedup-cache writes from concurrent test runs don't collide. Surfaces under `release.sh`'s test gate on machines with parallel test runners.

## v1.20.0

### Added

- **NLI advisory edges.** Every Write/Edit on a vault note runs the autolink top-3 neighbours through an embedded NLI model (`MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` via Xenova int8 ONNX, ~233 MB embedded via `include_bytes!`). Two edge types land in `edges.db` with `source_graph='nli'`, `confidence='low'`: `challenges_rebuttal` when `p(contradiction) > LL_NLI_THRESHOLD` (default `0.90`) and `nli_supports` when `p(entailment) > LL_NLI_ENTAIL_THRESHOLD` (default `0.75`). Regex `challenges_*` to the same target suppresses the NLI contradiction (regex wins); regex `supports`/`evidence_for` suppresses the NLI entailment. Regex `supports` does NOT block NLI contradiction (intentional — epistemic-tension signal worth surfacing). Spike eval: 86% precision @ p>0.90 on the 180-pair test set vs the previous `Xenova/nli-deberta-v3-small`'s 51%.
- **`ll-search watch` hosts an NLI daemon over Unix domain socket.** New `nli_server` module (unix-only, gated on `feature="nli"`) listens at `<plugin-data>/nli.sock` and serves line-delimited JSON requests wrapped in a `{schema_version: 1, results: [...]}` envelope. Model loads lazily on first request and stays warm. Measured warm round-trip ~10 ms vs cold subprocess ~400 ms (40× speedup). Stale-socket probe with 500 ms timeout; in-flight handler drain on shutdown via `JoinSet`; 1 MiB cap per request; socket perms 0700. Hook auto-detects socket presence and falls back to the subprocess path when the daemon isn't running or on non-unix platforms. Schema-mismatch from the daemon suppresses NLI for the session (warn-once stderr message) rather than reloading the 233 MB model per write through subprocess fallback.
- **Viz layer for NLI surfaces.** New `/learning-loop:viz` skill regenerates three idempotent artifacts from `edges.db`. (1) Frontmatter sync: writes `nli-contradicts:` / `has-contradiction:` (challenges_rebuttal rows ≥ 0.95) and `nli-supports:` / `has-entailment:` (nli_supports rows ≥ 0.95) to each source note's frontmatter, with Obsidian Graph View `colorGroups` snippet support for visual highlighting. (2) Heatmap: writes `_system/nli-conflicts.md` (with `aliases: ["NLI advisory edges", "NLI conflicts"]`) listing all NLI edges. (3) Cycles canvas: writes `_system/viz/cycles.canvas` (Obsidian Canvas JSON) from DFS cycle detection bounded by `maxDepth=4` and `maxCycles=50` soft cap with a `+N more` truncation notice. Three different thresholds across phases are documented and intentional. `/reflect` and `/ingest` piggyback the viz regen at the end (skip via `--no-viz`).
- **`nli_supports` and entailment surfaces.** New edge type in `VALID_TYPES`. Frontmatter, heatmap, and `/health --nli-edges` all handle both edge types. Cycle detection treats `nli_supports` as a NON-contradiction edge — entailment-only loops (tautologies) no longer render red on the cycles canvas alongside actual disputes.
- **`/learning-loop:clear-nli` skill** (new). Rollback helper for the NLI viz layer: strips all four NLI frontmatter keys vault-wide, `.bak`-renames `_system/nli-conflicts.md` and `_system/viz/cycles.canvas` (cross-platform: explicit unlink-first before rename), clears the `nli_frontmatter_tags` index, resets `BOOTSTRAP_KEY`. Does NOT touch `edges.db` rows themselves — next hook write re-derives state cleanly.
- **`/health --nli-edges` mode** for tuning. Confidence histogram across the 0.90–1.00 range filtered to `source_graph='nli'`, schema-mismatch and daemon-error tag surfacing for hook log triage, random 10-edge sample, threshold readouts for both contradiction and entailment.
- **Pre-filter NLI hint in `correction-analyser`** Phase 2.5 (hint mode — LLM always runs, NLI just biases). Reads both `challenges_rebuttal` and `nli_supports` rows with their `confidence_score`, tags candidates with `[NLI hint: contradiction p=0.93]` annotations so the LLM can weight clear-cut signals over borderline ones.

### Changed

- **`build.rs` pins both NLI model and tokenizer by SHA-256.** Downloads land at `.tmp` paths with size-floor pre-check, hashed against constants, and `fs::rename` atomically into place on match. Cached files are re-hashed on every build (~400 ms for the 233 MB model — acceptable cost). Mismatch panics loudly and points users at the upgrade procedure in the file's leading comment block. Catches corrupted partial downloads, CDN tampering, accidental upstream re-quants that change behavior, and stale cached files left over from a prior URL.
- **`edges.db` schema gains `confidence_score REAL`** column. Migration runs at every `openEdgeDb` call via `PRAGMA table_info(edges)` + `cols.includes` check (idempotent, version-resilient — does not depend on SQLite error-message wording). Existing rows get NULL; new NLI writes populate it.
- **`getDownstream` and `getDownstreamSymmetric` CTEs exclude `source_graph IN ('archived', 'nli')`** in both the anchor and recursive subqueries. NLI advisory edges cannot leak transitively into downstream queries used by `/rewrite` and the correction-analyser. `getSoleJustificationDependents{,Symmetric}` add `source_graph != 'nli'` as defense in depth — the `edge_type IN ('evidence_for', 'supports')` whitelist already excludes `nli_supports`, but the redundant guard survives a future edge-type rename.
- **`stripMarkdownForNli` in `edge-infer.mjs`** preprocesses premise + hypothesis before tokenization. Drops wikilinks (keeping inner text), tags, headers, emphasis, code fences, list markers, blockquotes; collapses whitespace. Code-fence stripping runs BEFORE markdown-link extraction so backtick-wrapped content isn't mangled. Without this preprocessing the DeBERTa-MNLI model would score raw markdown syntax it wasn't trained on, making the 0.90 threshold unreliable.
- **`Mutex<Session>` in `nli.rs` switched from `std::sync` to `parking_lot`.** A panic inside `session.run()` with `std::sync::Mutex` would poison the lock forever — daemon stays up but returns error sentinels for every subsequent request. `parking_lot` has no poison semantics; the lock releases cleanly so subsequent requests recover.
- **`LL_NLI_THRESHOLD` and `LL_NLI_ENTAIL_THRESHOLD` are validated at module load.** `parseFloat('junk')` returns `NaN`; without validation, every threshold check would be `r.contradiction > NaN` (always false), silently disabling NLI with no diagnostic. Invalid values now fall back to the default with a one-time stderr warning.

### Fixed

- **Wikilink-removal NLI-only branch preserves prior regex edges.** When a note's wikilinks are removed (regex pass returns `[]`) but autolink still produces NLI candidates, `removeOutgoingNliEdges` (not `removeOutgoingEdges`) runs — so the note's previously-classified regex edges survive.
- **`regenerate-viz.mjs` `saveDb` runs in a `finally` block.** Previously a throw mid-phase (e.g., disk full during heatmap write) would leave the in-memory tagged-notes index unflushed; the next viz run would re-bootstrap from scratch. Pinned by a test that forces `_system` to be a regular file so `mkdirSync` throws, then re-opens the DB and asserts `viz_meta` writes from the frontmatter phase persisted.
- **`getEdgesForCycleDetection` is now `ORDER BY id`.** Previously cycle-canvas node IDs were stable only because SQLite happened to return rows in insertion order — any future change that re-inserts edges (vacuum, bulk import, classifier re-run) would silently re-shuffle canvas IDs. Now structural.

## v1.19.1

### Changed

- **Relicensed to Apache-2.0** from All Rights Reserved. The plugin is now free to use, modify, and redistribute under the [Apache License 2.0](LICENSE). A new [NOTICE](NOTICE) file carries attribution to omit.nz and must be preserved in derivative works per the license terms. `.claude-plugin/plugin.json` `license` is now `Apache-2.0` and `author.url` points to `https://omit.nz`.

### Fixed

- **`scripts/release.sh` no longer bumps `ll-core`** with the plugin version. ll-core tracks its own crates.io semver line (currently `0.1.4`); the previous `for cargo_toml in native/crates/*/Cargo.toml` loop unconditionally bumped every crate, causing the repo Cargo.toml to drift to `1.19.0` while crates.io stayed at `0.1.4`. The loop now skips `ll-core` via a `case` guard. As part of this release, `native/crates/ll-core/Cargo.toml` is reset to `0.1.4` to match crates.io reality. `ll-search` continues to track the plugin version.

## v1.19.0

### Added

- **Envelope framing for federation sync.** When negotiated with a sync-hub advertising `protocol_version >= 2`, client-to-hub uploads and hub-to-client peer downloads carry a length-prefixed binary frame: `size (u32 big-endian, 4 bytes) + sha256 (32 bytes) + body`. The receiver validates total length and SHA256 before allocating the body, so a malicious or buggy size declaration cannot trigger a 4 GB `Vec::with_capacity`. Wire format is co-authored with the sync-hub side and lives at `crates/ll-search/src/sync/protocol.rs::Envelope`. Caps: `MAX_ENVELOPE_SIZE = 200 MB` policy ceiling, `HUB_INBOUND_CAP = 50 MB` axum-enforced ceiling on uploads (the smaller wins). Uploads larger than 50 MB now return `SyncError::EnvelopeOversize { cap }` pre-flight without opening the WebSocket.
- **Protocol-version negotiation on `SyncHello` and `SyncReady`.** `SyncHello` carries a new `protocol_version: Option<u32>` (skipped on the wire when `None` for legacy hubs). `SyncReady` carries `protocol_version: u32` with `#[serde(default = 1)]` so a pre-2J hub that omits the field is read as v1. `PeerInfo` gains `protocol_version: Option<u32>` for per-peer downgrade. The existing `SyncHello.schema_version: u32` (index-DB row schema, value 1) is unchanged and lives in a different namespace from the wire `protocol_version`. A third local namespace, `schema_version: 2` in `index.db.meta` files, captures the on-disk meta-file format. Three nominally-similar fields, three distinct purposes.
- **`LL_SYNC_RECV_TIMEOUT_MS` and `LL_SYNC_SEND_TIMEOUT_MS` env overrides.** Production paths default to 30 s recv / 60 s send; the env vars override per-process and are used by the integration suite to validate the timeout machinery. Malformed values fall back to the constants.
- **In-process mock-hub test fixture.** `tests/common/mod.rs::spawn_hub` builds a `tokio_tungstenite::accept_async` mock that plays the SyncHello → AuthChallenge → AuthResponse → SyncReady → upload → SyncAck → ListPeers sequence. Three behaviours: `SilentAfterHello` (triggers recv timeout), `FullFlow { advertise_protocol_version }` (full handshake with configurable advertised version), and `Churn` (mid-flow disconnect for soak). Used by `tests/sync_recv_timeout.rs`, `tests/sync_protocol_negotiation.rs`, and the `#[ignore]`-gated `tests/sync_soak.rs`.

### Changed

- **Federation sync layer migrated from synchronous `tungstenite` + `std::net::TcpStream` to async `tokio_tungstenite` + `tokio::net::TcpStream`.** `fn main` becomes `#[tokio::main(flavor = "multi_thread")]`; `sync::client::sync_all` renamed to `sync_all_async`; `sync::watch::run_watch` renamed to `run_watch_async`. The watcher debounce now lives in the `notify` callback via `Arc<std::sync::Mutex<DebounceState>>` + `tokio::sync::Notify`, with a `tokio::select!` consumer loop racing shutdown / notified / poll-tick / federation-sync-tick / resync-tick. All SQLite calls invoked from async contexts go through `tokio::task::spawn_blocking`. The `recv_json` path wraps `ws.next()` in `tokio::time::timeout(RECV_TIMEOUT)`; `send_json` and `send_binary` are timeout-guarded too. The synchronous `tungstenite` crate is removed from the dependency tree.
- **Sync error type is now `SyncError` (`sync/error.rs`), with `thiserror` and `From` impls for `tokio_tungstenite::tungstenite::Error`, `std::io::Error`, `serde_json::Error`.** Variants distinguish `RecvTimeout`, `SendTimeout`, `SizeMismatch`, `HashMismatch`, `EnvelopeOversize`, `BadTimestamp`, `ClosedUnexpected`, and `FrameKind`. The public `sync_all_async` return type stays `anyhow::Result<SyncResult>` at the function boundary; internal errors map via `?`.
- **Peer freshness compared as parsed unix seconds instead of by-string equality.** `PeerTimestamp::parse` accepts trailing `Z`, lowercase `z`, fractional seconds, and `±HH:MM` offsets; rejects garbage with `SyncError::BadTimestamp`. Local `index.db.meta` files written by sync now carry `schema_version: 2` alongside both the human-readable `updated_at` and the parsed `updated_at_unix`. Readers fall back to re-parsing the string for v1 meta files on disk.

### Fixed

- **Federation seed handling no longer auto-mints during routine sync.** `auth::load_seed` previously delegated to `seed_store::load_or_create`, which silently generated a fresh seed when none was found and wrote it to the OS keyring under the globally-unique `KEYRING_SERVICE` + `KEYRING_USER`. A dev watcher leaked against a tempdir `config_dir`, or a parallel test that raced its env-unset guard, would stomp the production seed entry; sync auth then broke against the hub with "Verification equation was not satisfied", recoverable only by redeeming a fresh invite and re-registering the pubkey. The fix adds `seed_store::load_only` for read-without-create paths (sync, watch) and reserves `load_or_create` for the commands whose job is identity creation (`Identity`, `MigrateSeed`). Missing seeds now return an explicit "no federation seed found; run /learning-loop:federation to set up an identity" error.
- **Keyring entry namespaced by `config_dir` path.** Writes now go to `signing-seed-v1-<8-hex>` where the hex prefix is sha256 of the canonicalised `config_dir`. Reads first try the namespaced account, then fall back to the legacy un-namespaced `signing-seed-v1` _only if_ the seed there derives a pubkey matching this config_dir's `federation/config.json`. On match, the seed auto-migrates to the namespaced account and the legacy entry is deleted. The pubkey check stops leaked tempdir invocations from claiming the legacy entry. **MIGRATION:** existing v1.18.x installs auto-migrate on first sync after upgrading — no user action required. The auto-migration is one-shot per machine; the canonical install at `~/.claude/plugins/data/learning-loop-learning-loop-marketplace` ends up at `signing-seed-v1-<hash>`, plaintext-legacy installs untouched.
- **`LL_SEED_BACKEND` no longer races across parallel `#[tokio::test]` cases.** Each test module that touches the seed store now sets `LL_SEED_BACKEND=encrypted` exactly once via `std::sync::Once`; the previous per-test `set_var` + `Drop`-guard `remove_var` pattern could race against concurrent `load_or_create`, sending a parallel thread to the keyring branch and stomping production. The Once pattern is the minimum needed correctness fix; further defense in depth comes from the keyring-namespacing change above.
- **`migrated_at` timestamp in `.seed-meta.json` no longer drifts.** The local `chrono_iso_now` helper in `sync/seed_store.rs` used naive 365-day-year + 30-day-month math as a no-extra-deps fallback. By 2026 the accumulated drift was ~14 days; a migration on 2026-05-12 stamped `migrated_at: "2026-05-26T01:47:45Z"`. Replaced with the proper `crate::db::chrono_iso_now` helper that uses Gregorian conversion. The buggy local fallback is deleted.

## v1.18.1

### Fixed

- **GitHub Actions Linux jobs now install `libdbus-1-dev` + `pkg-config`** before invoking cargo. The `keyring = "=3.6.3"` dep added in v1.18.0 (federation seed storage) enables the `sync-secret-service` feature, which transitively pulls `libdbus-sys` and fails to compile on a stock `ubuntu-latest` runner without DBus development headers. Both the `Test` workflow (cargo job) and the `Build ll-search` workflow (Linux matrix entry) install the package as a new first step. v1.18.0 shipped no release artifact because of this; v1.18.1 is the first installable build of the v1.18 line. macOS and Windows builds were not affected (Keychain + Credential Manager use OS-native crypto, no system deps).

## v1.18.0

### Added

- **Librarian pauses on battery power (macOS).** A continuously running `gemma4:e2b` classifier kept the GPU warm and drained battery on unplugged laptops. The main loop now polls `pmset -g batt` at the top of each iteration; on `'Battery Power'` it logs once and sleeps `battery_poll_seconds` (default 60) until AC is restored, then logs and resumes. Two new config keys under `librarian`: `pause_on_battery` (default `true`) and `battery_poll_seconds` (default `60`). Non-macOS platforms always treat the system as plugged in. Ollama itself stays resident: this gates inference, not the daemon.
- **`ll-search migrate-seed` command.** Moves an existing plaintext federation signing seed into the new secure backend (OS keyring or encrypted-at-rest fallback). Fail-closed: refuses to delete the plaintext file until the new backend has been written and round-trip verified. `--rollback` reverses a completed migration, restoring the plaintext seed from the secure backend. Records a `.seed-meta.json` sidecar capturing the migration timestamp and target backend.
- **`LL_SEED_BACKEND` env override** for the federation signing seed. Accepts `keyring`, `encrypted`, or `mock` (empty string is treated as a no-op). Useful in CI and tests; production should leave it unset so the runtime picks the best available backend.

### Changed

- **Federation signing seed now stored in the OS keyring** with an encrypted-at-rest fallback for headless installs. macOS uses Keychain via `keyring = "=3.6.3"` (pinned to 3.x because the 4.0.0 release on crates.io carries a "do not depend on this crate" notice and the ecosystem is mid-split into `keyring-core` + per-provider crates). Linux uses Secret Service when a DBus session is available; otherwise an encrypted file (chacha20poly1305 AEAD with HKDF-SHA256 derived from `machine-uid`). The plaintext `.seed` file is removed after migration. The `Identity` JSON output adds a `"backend"` field (`"keyring"` | `"encrypted"` | `"plaintext-legacy"`) and drops the now-irrelevant `"seed_path"` field. Threat model: the machine-id-derived encrypted backend protects against backup leak and laptop theft but NOT root-on-host. **MIGRATION:** existing installs continue to work against the plaintext seed file until you run `ll-search migrate-seed [--config-dir ...]`. Backend detection on every launch tries keyring first, falls back to encrypted, then falls back to plaintext-legacy. No automatic migration; the user runs the migrate command explicitly.
- **Rerank failures now surface on stderr.** The `Commands::Rerank` handler and the two reflective-scan paths in `search/reflect.rs` migrated from the legacy `rerank()` to `rerank_with_report()`. Documents that fail to score (model unavailable, payload too large, decoder error) emit one stderr line per call (`rerank (scope): N of M documents failed to score (first: path=... reason=...)`) instead of being silently dropped from results. JSON wire format on stdout is unchanged; downstream consumers see the same `Vec<RerankResult>` shape as before.

### Security

- **Plaintext federation seed eliminated post-migration.** Prior to this release the Ed25519 signing seed sat as a plain 32-byte file at `<config-dir>/federation/.seed` with 0600 perms. Backup tooling, accidental commits, and laptop forensics could expose it. After running `ll-search migrate-seed`, the seed lives only in the OS keyring (macOS Keychain or Linux Secret Service) or, on headless installs, in an encrypted file sealed with a machine-derived key. The plaintext file is deleted in the same fail-closed transaction.

## v1.17.3

### Fixed

- **`ll-watch` dispatcher silently spawned watchers on unknown subcommands.** `ll-watch --help`, `ll-watch help`, and any typo previously fell through the `if`-chain in `scripts/watch.mjs` to the "start watcher" default. The dispatcher now prints usage and exits non-zero on unknown input; `--help` / `-h` / `help` all print the usage block and exit 0. New `tests/watch-dispatch.test.mjs` pins the regression.
- **`ll-watch` lied about start success when the binary failed.** The wrapper printed `started (pid …)` immediately after `spawn()` even when the Rust binary exited 1 on pid-file conflict, because `stdio: 'ignore'` dropped the binary's stderr. The wrapper now (a) refuses to spawn when an alive watcher already holds the pid file, (b) redirects the detached binary's stdout/stderr to `<plugin-data>/watch.log`, and (c) waits 300 ms after spawn to verify the child survived, surfacing the log tail if it didn't.
- **Vault keyword search switched from `mgrep` CLI to the built-in `Grep` tool.** `agents/_skills/overlap-check.md`, `agents/discovery-vault-scout.md`, `hooks/session-start.js`, `skills/refresh/SKILL.md`, `skills/verify/SKILL.md`, and `agents/discovery-researcher.md` no longer hard-require `mgrep` for keyword search; `Grep` works out of the box across all sessions and doesn't depend on the external `mgrep` install. `discovery-researcher` still accepts `mgrep --web --answer` as an optional shortcut for the web-search synthesis when available.
- **`discovery-researcher` hard-failed on `/tmp` writes in subagent sessions.** The agent told subagents to `Write` search results to `<tmpdir>/ll-result-<session>-N.txt` and then `Bash` `convergence-check.mjs` against that path. Subagents can't be interactively prompted for permission, so any session whose `additionalDirectories` didn't cover the real `os.tmpdir()` (on macOS, `/var/folders/.../T/`, not `/tmp`) hard-failed and silently fell back to manual convergence assessment — no mechanical scores, no `convergence-check.mjs` run. Fix collapses the three-step Write + check + cleanup flow into one Bash heredoc piped to `convergence-check.mjs check ... -`, which reads result text from stdin. `STATE_DIR` for `convergence-check.mjs` moves from `tmpdir()/ll-convergence` to `<plugin-data>/convergence` so the script never touches `/tmp` either. Only `Bash(node:*)` permission is needed; no `Write` tool calls, no `/tmp` access, no per-user permission setup. New test in `tests/convergence-check-keys.test.mjs` covers the stdin mode.

## v1.17.2

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

## v1.16.8

### Added

- **Phase 2 delta path: incremental sync.** Sync now uploads only changed notes since the last successful sync, using a base-export-db diff. Full uploads remain as the fallback when the bases diverge.

## v1.16.7

### Added

- **`ll-watch` CLI** -- a single command to start, stop, and check the vault watcher. Replaces the multi-argument `ll-search watch` invocation. Install via `node scripts/watch.mjs --install`. The shim resolves the latest plugin cache version at runtime, so it survives plugin updates.

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
