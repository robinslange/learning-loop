# Changelog

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
