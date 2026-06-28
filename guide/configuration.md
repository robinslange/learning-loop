# Configuration

`config.json` in `PLUGIN_DATA` (set by Claude Code via `CLAUDE_PLUGIN_DATA` env var):

```json
{
  "vault_path": "~/path/to/vault",
  "injection_mode": "shadow",
  "injection_threshold": 0.3
}
```

`injection_mode` controls just-in-time context injection on `UserPromptSubmit`. Defaults to `shadow` — the pipeline runs and logs what it _would_ have injected but never mutates the prompt. Flip to `live` after reviewing the shadow log (see Context injection below). The `injection-shadow-gate` health check watches the shadow logs and nudges at session start once the go-live gate is passing; `/learning-loop:doctor` can apply the flip with your approval.

`injection_threshold` is the minimum score the top vault or episodic hit must clear before context is injected. The vault score is a raw RRF fusion sum (each of the five search signals contributes `1/(5+rank)`), **not** a cosine similarity: a hit ranked #1 in one signal scores ~0.17, #1 in two signals ~0.33, and #1 in all five ~0.83. Defaults to `0.3` — just below the two-strong-signals level, calibrated against 18k shadow-injection gate evaluations (see the derivation comment on `INJECTION_THRESHOLD` in `scripts/lib/hook-config.mjs`). Tune by inspecting `scripts/review-shadow.mjs` output. Override per-session with the `LEARNING_LOOP_INJECTION_THRESHOLD` env var.

`filename_style` controls the pre-write filename-convention advisory. Values: `'kebab'` (enforce kebab-case, e.g. `my-note.md`), `'spaces'` (enforce space-separated titles, e.g. `My Note.md`), `'auto'` (detect from the vault population), or absent (same as `'auto'`). In `auto` mode the hook reads up to 200 basenames across `0-inbox/`, `1-fleeting/`, and `3-permanent/` at write time; if >70% lack spaces the convention is kebab, if >70% have spaces the convention is spaces, otherwise the check is skipped. The advisory is non-blocking — it appears as `additionalContext`, never as a deny.

Config persists across plugin updates. If config exists at the old root location (pre-PLUGIN_DATA), the plugin migrates it automatically on first run.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

If set, the `VAULT_PATH` environment variable overrides `config.json`.

Config files are read with UTF-8 BOM stripping so Notepad-saved JSON on Windows parses correctly.

## Hooks

Eight hook handlers across six Claude Code event types enforce process discipline at the lifecycle level. They run regardless of what Claude decides.

| Event                                       | Hook                    | What it enforces                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart                                | session-start.js        | Injects vault context (memory index, recent captures, intention summary, dream gate nudge) and dispatches to subhooks in `hooks/session-start/` for cache cleanup, binary auto-update, health detection, vault snapshot, and watch-daemon spawn                                                   |
| Stop                                        | stop-nudge.js           | Suggests `/reflect` after substantial sessions                                                                                                                                                                                                                                                    |
| UserPromptSubmit                            | session-label.js        | Labels sessions for episodic memory retrieval; runs the just-in-time injection pipeline (shadow or live per `injection_mode`)                                                                                                                                                                     |
| PreToolUse (Write\|Edit)                    | pre-write-check.js      | Warns on near-duplicate similarity (≥0.85) and broken wikilinks; blocks duplicate frontmatter tags and em/en dashes added to note body prose (added-only delta against the note on disk, `Source:`/`Related:` lines exempt)                                                                       |
| PostToolUse (Write\|Edit\|Agent\|Skill)     | post-tool.js            | Coalesced dispatcher. Loads one vault snapshot, then runs the provenance, reflect-track, autolink, and edge-infer modules in fixed order (cheap load-bearing modules first, so a hook timeout only drops enrichment) with per-module timeout isolation. Non-write tool events only run provenance |
| PostToolUse (Read)                          | post-read-retrieval.js  | Tracks vault reads for retrieval instrumentation                                                                                                                                                                                                                                                  |
| PostToolUse (mcp\_\_plugin_episodic-memory) | post-search-tracking.js | Tracks episodic memory searches                                                                                                                                                                                                                                                                   |
| PreCompact                                  | pre-compact.js          | Captures context insights before compression (opt-in: set `LEARNING_LOOP_PRECOMPACT_SPIKE=1` to enable)                                                                                                                                                                                           |

The post-tool modules live under `hooks/modules/`, listed in execution order:

- **provenance** — records every vault read/write for the provenance log
- **reflect-track** — appends each new vault Write/Edit to the `/reflect` new-notes marker while the marker exists (added v1.25.3)
- **autolink** — adds backlinks and semantic links after vault writes
- **edge-infer** — classifies wikilink pairs via regex, writes `challenges_*` typed edges to `edges.db`

These hooks are the core of the plugin's value. Without them, Claude can skip verification, promote unsourced notes, and write in its default voice. With them, these failures are structurally impossible.

## Context injection

The `session-label.js` hook runs a dual-backend search (vault + episodic) on every `UserPromptSubmit` and either emits a real context injection (live mode) or writes a shadow log (shadow mode, the default). A race cap bounds total hook latency; backends that exceed the cap are killed and skipped for the turn.

- shadow log: `PLUGIN_DATA/retrieval/shadow-injection-*.jsonl`
- review: `node scripts/review-shadow.mjs` — stats, latency percentiles, sample draws, go/no-go gate
- flip to live: set `"injection_mode": "live"` in `config.json` once the gate passes — the `injection-shadow-gate` health check surfaces a session-start nudge when the shadow data clears the gate, and `/learning-loop:doctor` applies the edit on approval (never automatically)
- gate threshold: `injection_threshold` in `config.json` (default `0.3`, an RRF fusion-sum cutoff — see above) or `LEARNING_LOOP_INJECTION_THRESHOLD` env var
- dedupe: the session-start hook sweeps a 7-day session-dedupe directory and fires a detached episodic pre-warm to populate the OS page cache before the first query
- continuous reindex: `hooks/session-start/watch-daemon.mjs` spawns `ll-search watch` at SessionStart; it reindexes notes incrementally as they change (fs-watch-driven), so the vector index is always current without any Stop-hook involvement. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full watch-daemon lifecycle.

## Operator tools

- edge backfill: `node scripts/backfill-edges.mjs` — walks the vault and bulk-classifies every note's wikilink edges into `edges.db`. Re-runnable (each pass is idempotent) and never mutates note content — only the post-write hook touches frontmatter.
- flags: `--dry-run` (classify without writing), `--folder <dir>` (restrict to one vault folder), `--limit N` (cap notes processed, handy for spot-checks)
- when to run: after a bulk import so existing notes get edges without waiting for each to be rewritten

## Environment variables

| Variable                              | Purpose                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_PLUGIN_DATA`                  | Plugin data root (set by Claude Code). Holds `config.json`, `bin/`, `retrieval/`, `provenance/`, `federation/` |
| `VAULT_PATH`                          | Overrides `vault_path` from `config.json`                                                                      |
| `LEARNING_LOOP_INJECTION_MODE`        | Per-session override of `injection_mode` (`shadow`, `live`, `off`)                                             |
| `LEARNING_LOOP_INJECTION_THRESHOLD`   | Per-session override of `injection_threshold` (RRF fusion-sum scale, e.g. `0.4`)                               |
| `LEARNING_LOOP_INJECTION_FORCE_ERROR` | Set to `1` to simulate a pipeline failure for testing the error path                                           |
| `LEARNING_LOOP_PRECOMPACT_SPIKE`      | Set to `1` to enable the PreCompact hook (opt-in). Default: hook is dormant.                                   |

## Vault librarian

An optional background agent that uses a local Ollama model to continuously maintain vault hygiene. Disabled by default; enable via `/init` Phase 7 or by setting `librarian.enabled: true` in config.

The model is chosen by **RAM tier** so one resident model serves everything: `gemma3:12b` on ≥32GB (triage **and** local research), `gemma4:e2b` on 16–32GB (triage only), skipped under 16GB. `/init` detects RAM and sets `model` accordingly. The shipped default below is the conservative `gemma4:e2b` tier; `/init` upgrades it to `gemma3:12b` on a 32GB+ machine. See [resource-usage.md](resource-usage.md).

```json
{
  "librarian": {
    "enabled": false,
    "model": "gemma4:e2b",
    "pace_seconds": 2,
    "queue_cap": 200,
    "ollama_url": "http://localhost:11434",
    "keep_alive": "30m",
    "pause_on_battery": true,
    "battery_poll_seconds": 60
  }
}
```

| Key                    | Default                  | Purpose                                                                                                       |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `enabled`              | `false`                  | Opt-in. Set `true` to start the librarian with `ll-watch`.                                                    |
| `model`                | `gemma4:e2b`             | Ollama model for classification. RAM-tiered by `/init` (`gemma3:12b` on 32GB+); research needs the 12b tier. |
| `pace_seconds`         | `2`                      | Delay between note investigations. Higher values reduce resource pressure.                                    |
| `queue_cap`            | `200`                    | Max pending items before the librarian pauses. Items expire after 30 days or when the target note is edited.  |
| `ollama_url`           | `http://localhost:11434` | Ollama API endpoint.                                                                                          |
| `keep_alive`           | `30m`                    | How long ollama keeps the model resident after idle. Set lower to free RAM sooner, higher to avoid reloads.   |
| `pause_on_battery`     | `true`                   | Suspend the librarian while the machine is on battery power (polled).                                         |
| `battery_poll_seconds` | `60`                     | How often to re-check power state when `pause_on_battery` is on.                                              |

### Remote model provider (advanced)

The librarian can route its model calls to an OpenAI-compatible remote instead of local ollama (e.g. GLM, DeepSeek, or Qwen via Fireworks). Add a `provider` block to `librarian`:

```json
{
  "librarian": {
    "enabled": true,
    "provider": {
      "kind": "openai",
      "base_url": "https://api.fireworks.ai/inference",
      "model": "accounts/fireworks/models/...",
      "api_key_ref": "<keyring reference resolved at runtime>"
    }
  }
}
```

With no `provider` block (the default), calls go to local ollama using `model` + `ollama_url`. All model calls (daemon classifiers and the `/research` engine) go through one provider-agnostic client (`scripts/lib/model-client.mjs`), so the same code runs against a local or remote model.

The librarian spawns as a child process of the watcher (started via `ll-watch`). It runs continuously, picking random unvisited notes and dispatching multiple tasks per note. Mechanical: staleness regex. Ollama tool-use loop: link investigation for orphans. Ollama structured-output classifiers: voice gate (topic-style titles in inbox/fleeting notes), tag suggestion (under-tagged notes with vocabulary-bounded picks from the vault's existing tags), duplicate detection (3-way enum against three nearest neighbours with body context). Each task writes its observations to `PLUGIN_DATA/librarian/queue.jsonl` with a distinct `task` field (`link_suggestion`, `voice_flag`, `tag_suggestion`, `duplicate_flag`, `staleness_suspect`). A separate `state.json` tracks visited notes and resets after a full pass.

Review queued observations with `/health --librarian`. The librarian observes; humans and Claude act.

**Requirements:** ollama installed, 16GB+ system RAM, and the tier model pulled (`ollama pull gemma4:e2b` on 16–32GB, `ollama pull gemma3:12b` on 32GB+). Resident footprint is ~7.2GB (e2b) / ~8.9GB (12b). `keep_alive` (default `30m`) controls how long ollama keeps the model loaded after idle.

## Cache health statusline

If you run [oh-my-claude](https://github.com/eric-gaudet/oh-my-claude), `/learning-loop:init` Phase 6 offers to install a `cache-health` plugin from `plugins/omc-cache-health/`. It reads per-turn cache metrics (`cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`) from the statusline payload and persists them to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl`, deduping by `session_id` + token counts so repeated statusline fires inside one turn don't double-count.

The `node scripts/...` commands below run from the plugin root — the installed cache version directory, or `plugin/` in a repo checkout.

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

The source-resolver verifies citations mechanically against 13 APIs: PubMed, PubMed Central (PMC), Europe PMC, arXiv, Semantic Scholar, CrossRef, OpenAlex, bioRxiv/medRxiv, DBLP, Unpaywall, RFC Editor, Open Library, and ChEMBL. The note-writer runs `verify-note` and `check-claims` on every note at write time. It catches author swaps and wrong years, flags impossible journal combinations, and checks that cited studies support the claims made.

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

Restart Claude Code. The session-start hook auto-applies config changes on first run after update. It also re-checks `~/.local/bin/ll-watch` and `~/.local/bin/ll-search`; if either is missing it runs `scripts/install-shims.mjs --install` to write both. The shims resolve their targets at runtime, so they survive cache version changes.

Since v1.25.2, `hooks/session-start/cache-cleanup.mjs` compares the installed `ll-search` binary version against the running plugin version and spawns `download-binary.mjs` detached when they diverge. The current session keeps using whatever binary is on disk; the next session boots with the fresh one. One-session lag, no blocking — the gap where a plugin update bumped marketplace files but the native binary lagged is closed.

## CLI shims

Two shell scripts in `~/.local/bin/` give vault tools a stable name regardless of plugin version:

- `~/.local/bin/ll-search` -- search, indexing, identity, and similarity queries.
- `~/.local/bin/ll-watch` -- vault watcher that runs the librarian and incremental reindex.

The `ll-search` shim resolves `PLUGIN_DATA` from `$CLAUDE_PLUGIN_DATA` if set, otherwise from the marker file at `~/.claude/plugins/data/.ll-data-path` that the SessionStart hook writes, otherwise from the canonical default `~/.claude/plugins/data/learning-loop-learning-loop-marketplace`. It then exec's the binary at `$PLUGIN_DATA/bin/ll-search`, with `ORT_DYLIB_PATH` and `ORT_LIB_LOCATION` pointed at the binary's directory so the ONNX runtime loader finds the bundled `libonnxruntime` next to the binary.

The `ll-watch` shim picks the latest version-named directory under `~/.claude/plugins/cache/learning-loop-marketplace/learning-loop/` and exec's `node ${LATEST}/scripts/watch.mjs`. Filtering to digit-prefixed names skips orphan hash directories the plugin manager leaves behind.

The point of the indirection: each shim resolves its target at runtime. Plugin updates that move the binary inside `PLUGIN_DATA/bin/` or land a new cache version are invisible to the shim, which is why `ll-search` and `ll-watch` continue working after `/plugin install learning-loop@learning-loop-marketplace` without a restart of the shell.

The SessionStart hook auto-installs both shims if either is missing. To install or repair them manually:

```bash
node scripts/install-shims.mjs --install
```

`--check` prints the install status of each shim and exits 0 without writing.

## Project structure

```
learning-loop/
  .claude-plugin/                   Marketplace manifest
  plugin/                           The installed plugin (marketplace source)
    .claude-plugin/                 Plugin manifest
    agents/                         Specialized agent definitions
    agents-shared/                  Shared agent instruction docs (not dispatchable)
    skills/                         User-invocable skills (slash commands)
    scripts/                        Vault search, provenance, source-resolver,
                                    injection review, cache-health, binary download,
                                    librarian agent loop
    scripts/lib/                    Queue, tools, config, binary helpers
    scripts/lib/vendor/             Vendored JS deps (winkNLP for POS-tagged
                                    citation extraction)
    vendor/                         Vendored JS deps (sql.js WASM)
    hooks/                          Lifecycle hooks (enforcement layer)
    hooks/lib/inject.mjs            Shared helpers for the injection pipeline
    plugins/omc-cache-health/       oh-my-claude cache statusline plugin
  native/                           Cargo workspace
  native/crates/ll-core/            Search library: embed, graph, score, rerank, store
  native/crates/ll-search/          CLI binary, sync client, preprocess, model loader
```
