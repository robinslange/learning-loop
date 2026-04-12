# Configuration

`config.json` in `PLUGIN_DATA` (set by Claude Code via `CLAUDE_PLUGIN_DATA` env var):

```json
{
  "vault_path": "~/path/to/vault",
  "injection_mode": "shadow"
}
```

`injection_mode` controls just-in-time context injection on `UserPromptSubmit`. Defaults to `shadow` — the pipeline runs and logs what it *would* have injected but never mutates the prompt. Flip to `live` after reviewing the shadow log (see Context injection below).

Config persists across plugin updates. If config exists at the old root location (pre-PLUGIN_DATA), the plugin migrates it automatically on first run.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

If set, the `VAULT_PATH` environment variable overrides `config.json`.

## Hooks

Ten hooks enforce process discipline at the lifecycle level. They run regardless of what Claude decides.

| Event | Hook | What it enforces |
|---|---|---|
| SessionStart | session-start.js | Injects vault context: memory index, recent captures, intention summary, dream gate nudge (via `lib/dream-gate.js`) |
| Stop | stop-nudge.js | Suggests `/reflect` after substantial sessions |
| UserPromptSubmit | session-label.js | Labels sessions for episodic memory retrieval; runs the just-in-time injection pipeline (shadow or live per `injection_mode`) |
| PreToolUse (Write) | pre-write-check.js | Blocks near-duplicate notes before they land |
| PostToolUse (Write\|Edit\|Agent\|Skill) | post-tool-provenance.js | Tracks every vault read/write for provenance |
| PostToolUse (Write\|Edit) | post-write-autolink.js | Adds backlinks and semantic links after vault writes |
| PostToolUse (Write\|Edit) | post-write-edge-infer.js | Classifies and stores semantic edges between notes on write |
| PostToolUse (Read) | post-read-retrieval.js | Tracks vault reads for retrieval instrumentation |
| PostToolUse (episodic-memory) | post-search-tracking.js | Tracks episodic memory searches |
| PreCompact | pre-compact.js | Captures context insights before compression |

These hooks are the core of the plugin's value. Without them, Claude can skip verification, promote unsourced notes, and write in its default voice. With them, these failures are structurally impossible.

## Context injection

The `session-label.js` hook runs a dual-backend search (vault + episodic) on every `UserPromptSubmit` and either emits a real context injection (live mode) or writes a shadow log (shadow mode, the default). A race cap bounds total hook latency; backends that exceed the cap are killed and skipped for the turn.

- shadow log: `PLUGIN_DATA/retrieval/shadow-injection-*.jsonl`
- review: `node scripts/review-shadow.mjs` — stats, latency percentiles, sample draws, go/no-go gate
- flip to live: set `"injection_mode": "live"` in `config.json` once the gate passes
- dedupe: the session-start hook sweeps a 7-day session-dedupe directory and fires a detached episodic pre-warm to populate the OS page cache before the first query

## Cache health statusline

If you run [oh-my-claude](https://github.com/eric-gaudet/oh-my-claude), `/learning-loop:init` Phase 6 offers to install a `cache-health` plugin from `plugins/omc-cache-health/`. It reads per-turn cache metrics (`cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`) from the statusline payload and persists them to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl`, deduping by `session_id` + token counts so repeated statusline fires inside one turn don't double-count.

```bash
# Weighted hit rate, p50/p25/p10, per-session breakdown, zero-hit events
node scripts/cache-health-report.mjs [--session <id>] [--month YYYY-MM]

# Idempotent installer — also supports --check (dry-run) and --uninstall
node scripts/install-cache-health.mjs
```

## Provenance

Every vault operation (read, write, agent spawn, skill invocation) logs to `provenance/events-YYYY-MM.jsonl`. The `/health` command reads these logs to show session activity patterns.

```bash
# Generate provenance report
node scripts/provenance-report.mjs

# Consolidate logs into daily summaries (feeds federation sync)
node scripts/provenance-consolidate.mjs
```

## Source verification

The source-resolver verifies citations mechanically against 12 APIs: PubMed, Europe PMC, arXiv, Semantic Scholar, CrossRef, OpenAlex, bioRxiv/medRxiv, DBLP, Unpaywall, RFC Editor, Open Library, and ChEMBL. The note-writer runs `verify-note` and `check-claims` on every note at write time. It catches author swaps and wrong years, flags impossible journal combinations, and checks that cited studies support the claims made.

Citation extraction uses POS tagging (vendored winkNLP) to distinguish author names from month names and common words. The naive regex approach had a ~60% false positive rate on author-year patterns.

```bash
# Verify all sources in a note
node scripts/source-resolver.mjs verify-note <path>

# Check quantitative claims against source abstracts
node scripts/source-resolver.mjs check-claims <path>

# Resolve a citation
node scripts/source-resolver.mjs resolve "Author Year Topic"

# Verify specific identifiers
node scripts/source-resolver.mjs verify-pmid <pmid> "Author" <year>
node scripts/source-resolver.mjs verify-doi <doi> "Author" <year>
node scripts/source-resolver.mjs verify-arxiv <arxiv-id>
node scripts/source-resolver.mjs verify-rfc <rfc-number>
node scripts/source-resolver.mjs verify-isbn <isbn>

# Look up a compound in ChEMBL
node scripts/source-resolver.mjs lookup-compound <name>

# Search PubMed with MeSH terms
node scripts/source-resolver.mjs search-pubmed "topic" --mesh
```

## Updating

```bash
/plugin marketplace update learning-loop-marketplace
/plugin install learning-loop@learning-loop-marketplace
```

Restart Claude Code. The session-start hook auto-applies config changes on first run after update.

## Project structure

```
learning-loop/
  .claude-plugin/            Plugin manifest
  agents/                    Specialized agent definitions
  agents/_skills/            Shared agent skills
  skills/                    User-invocable skills (slash commands)
  scripts/                   Vault search, provenance, source-resolver,
                             injection review, cache-health, binary download
  scripts/lib/vendor/        Vendored JS deps (winkNLP for POS-tagged
                             citation extraction)
  vendor/                    Vendored JS deps (sql.js WASM, ed25519, picomatch)
  hooks/                     Lifecycle hooks (enforcement layer)
  hooks/lib/inject.mjs       Shared helpers for the injection pipeline
  native/                    Cargo workspace
  native/crates/ll-core/     Search library: embed, graph, score, rerank, store
  native/crates/ll-search/   CLI binary, sync client, preprocess, model loader
  plugins/omc-cache-health/  oh-my-claude cache statusline plugin
```
