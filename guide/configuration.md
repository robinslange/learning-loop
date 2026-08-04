# Configuration

`config.json` in `PLUGIN_DATA` (set by Claude Code via `CLAUDE_PLUGIN_DATA` env var):

```json
{
  "vault_path": "~/path/to/vault",
  "injection_mode": "live",
  "injection_threshold": 0.34
}
```

`injection_mode` controls just-in-time context injection on `UserPromptSubmit`. The shipped config sets `live`: hits that clear the gate are injected into the prompt. `shadow` runs the same pipeline but only logs what it _would_ have injected, never mutating the prompt; it remains available for calibration (see Context injection below). `off` disables the pipeline. If the key is absent from config, the hook falls back to `shadow`. When running in shadow, the `injection-shadow-gate` health check nudges at session start once the go-live gate is passing, and `/learning-loop:doctor` can apply the flip with your approval.

`injection_threshold` is the minimum score the top vault or episodic hit must clear before context is injected. The vault score is a raw **weighted** RRF fusion sum, **not** a cosine similarity. Each lane contributes `weight/(5+rank)`, and since v1.40.0 the lanes are weighted unequally (vector 1.0, BM25 1.0, PRF 0.5, PPR 0.05, tags 0.05), so the reachable range is:

| Agreement                        | Score    |
| -------------------------------- | -------- |
| vector #1 alone                  | 0.1667   |
| vector #1 + BM25 #1              | 0.3333   |
| vector #1 + BM25 #1 + graph #1   | 0.3500   |
| vector #1 + BM25 #1 + PRF #1     | 0.4167   |
| all five lanes #1 (ceiling)      | 0.4333   |

Defaults to `0.34` — just above the two-strong-lanes floor, so the gate demands corroboration beyond two lone top hits. Cosine-style values (0.7+) are unreachable, and anything above 0.4333 disables injection entirely. This value is derived from achievable-score arithmetic, not from measured relevance: every percentile on record predates the reweighting (see the derivation comment on `INJECTION_THRESHOLD` in `scripts/lib/hook-config.mjs`). Tune by inspecting `scripts/review-shadow.mjs` output, which reports gate reachability against the observed distribution. Override per-session with the `LEARNING_LOOP_INJECTION_THRESHOLD` env var.

`filename_style` controls the pre-write filename-convention advisory. Values: `'kebab'` (enforce kebab-case, e.g. `my-note.md`), `'spaces'` (enforce space-separated titles, e.g. `My Note.md`), `'auto'` (detect from the vault population), or absent (same as `'auto'`). In `auto` mode the hook reads up to 200 basenames across `0-inbox/`, `1-fleeting/`, and `3-permanent/` at write time; if >70% lack spaces the convention is kebab, if >70% have spaces the convention is spaces, otherwise the check is skipped. The advisory is non-blocking — it appears as `additionalContext`, never as a deny.

Config persists across plugin updates. If config exists at the old root location (pre-PLUGIN_DATA), the plugin migrates it automatically on first run.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

If set, the `VAULT_PATH` environment variable overrides `config.json`.

Config files are read with UTF-8 BOM stripping so Notepad-saved JSON on Windows parses correctly.

## Hooks

Nine hook handlers across six Claude Code event types enforce process discipline at the lifecycle level. They run regardless of what Claude decides. This table is the canonical roster.

| Event                                       | Hook                    | What it enforces                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart                                | session-start.js        | Injects vault context (memory index, learned patterns, federation status, a recent-captures pointer, intention summary, dream gate nudge) and dispatches to subhooks in `hooks/session-start/` for cache cleanup, binary auto-update, health detection, vault snapshot, and watch-daemon spawn   |
| Stop                                        | stop-nudge.js           | Suggests `/reflect` after substantial sessions                                                                                                                                                                                                                                                    |
| UserPromptSubmit                            | session-label.js        | Labels sessions for episodic memory retrieval; runs the just-in-time injection pipeline (shadow or live per `injection_mode`)                                                                                                                                                                     |
| SubagentStop                                | subagent-stop.js        | Emits an `agent-result` provenance record (session id + transcript path) when a subagent finishes                                                                                                                                                                                                 |
| PreToolUse (Write\|Edit)                    | pre-write-check.js      | Warns on near-duplicate similarity (≥0.85) and broken wikilinks; blocks duplicate frontmatter tags, em/en dashes added to note body prose, and frontmatter-contract violations introduced in `0-inbox`/`1-fleeting`/`2-literature`/`3-permanent` notes (missing or empty `tags`/`date`/`source`, the deprecated `created:`/`updated:`/`source-project:` keys, a non-`YYYY-MM-DD` date, an off-vocabulary `status:`). Both the dash and schema checks are added-only deltas against the note on disk, so pre-existing violations are inherited rather than denied; `Source:`/`Related:` lines are exempt from the dash rule |
| PreToolUse (WebSearch\|WebFetch)            | web-guard.js            | Denies the raw web tools globally (main session included; PreToolUse cannot scope to subagents) and routes web access through the source gateway, `bin/source-gateway.mjs`, so every search, fetch, and research call goes through a config-selected source with a per-session fetch budget       |
| PostToolUse (Write\|Edit\|Task\|Skill)      | post-tool.js            | Coalesced dispatcher. Loads one vault snapshot, then runs the provenance, reflect-track, autolink, and edge-infer modules in fixed order (cheap load-bearing modules first, so a hook timeout only drops enrichment) with per-module timeout isolation. Non-write tool events only run provenance |
| PostToolUse (Read)                          | post-read-retrieval.js  | Tracks vault reads for retrieval instrumentation                                                                                                                                                                                                                                                  |
| PostToolUse (mcp\_\_plugin_episodic-memory) | post-search-tracking.js | Tracks episodic memory searches                                                                                                                                                                                                                                                                   |

The post-tool modules live under `hooks/modules/`, listed in execution order:

- **provenance** — records every vault read/write for the provenance log
- **reflect-track** — appends each new vault Write/Edit to the `/reflect` new-notes marker while the marker exists (added v1.25.3)
- **autolink** — adds backlinks and semantic links after vault writes
- **edge-infer** — classifies wikilink pairs via regex, writes `challenges_*` typed edges to `edges.db`

These hooks are the core of the plugin's value. Without them, Claude can skip verification, promote unsourced notes, and write in its default voice. With them, these failures are structurally impossible.

`hooks.pre_write_fail_mode` (shipped in `config.json`, read by `pre-write-check.js`) controls what happens when the duplicate scan itself fails (missing binary, dead daemon). The default `"open"` lets the write through with the check skipped; `"closed"` blocks vault writes until the scan infrastructure is available again.

```json
{
  "hooks": {
    "pre_write_fail_mode": "open"
  }
}
```

### Web access gateway

`web-guard.js` denies the raw `WebSearch`/`WebFetch` tools; all web access routes through `bin/source-gateway.mjs` instead:

```bash
node bin/source-gateway.mjs search --q "<query>" --json
node bin/source-gateway.mjs fetch --url <url>
node bin/source-gateway.mjs research --q "<question>"
```

Each verb resolves its source from the unified source registry (`scripts/lib/sources/registry.mjs`), so every web call is config-selected. `fetch` enforces a per-session budget (default 10, override with `LL_GATEWAY_FETCH_BUDGET`) backed by a file counter that survives the one-process-per-call pattern. `research` runs the librarian research engine and refuses on a sub-tier model (exit 3). All gateway verbs honor `LL_OFFLINE`.

## Context injection

The `session-label.js` hook runs a vault search (`ll-search query`) on every `UserPromptSubmit` and either emits a real context injection (live mode, the shipped default) or writes a shadow log (shadow mode, for calibration). When the query was padded with prior-message context, a second concurrent vault query runs on the prompt alone, so the hook can tell whether a hit scored on the prompt's own words or only on the borrowed padding. Episodic memory left this path in v1.37.0 (0 of 7,455 gate passes had been carried solely by episodic) — it remains available via SessionStart retrieval and the MCP tool, just not in the per-prompt hook. A race cap bounds total hook latency; queries that exceed the cap are aborted and skipped for the turn.

- shadow log: `PLUGIN_DATA/retrieval/shadow-injection-*.jsonl`
- review: `node scripts/review-shadow.mjs` — stats, latency percentiles, sample draws, go/no-go gate
- calibrate: set `"injection_mode": "shadow"` in `config.json` to run the pipeline without mutating prompts, review the log, then set it back to `"live"`
- gate threshold: `injection_threshold` in `config.json` (default `0.34`, a weighted-RRF fusion-sum cutoff — see above) or `LEARNING_LOOP_INJECTION_THRESHOLD` env var
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
| `LEARNING_LOOP_INJECTION_THRESHOLD`   | Per-session override of `injection_threshold` (weighted-RRF fusion-sum scale, max `0.4333`, e.g. `0.35`)      |
| `LEARNING_LOOP_INJECTION_FORCE_ERROR` | Set to `1` to simulate a pipeline failure for testing the error path                                           |
| `LL_GATEWAY_FETCH_BUDGET`             | Per-session `source-gateway.mjs fetch` budget (default `10`)                                                   |

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

Five override knobs are read by `scripts/librarian/config.mjs` but omitted from the shipped config; set them under `librarian` only when the built-in defaults (defined in that file) need replacing:

| Key                | Purpose                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `link_prompt`      | System prompt for the agentic link investigation on orphan notes.                                                       |
| `voice_prompt`     | Classifier prompt for the voice gate (claim vs topic titles).                                                            |
| `tag_prompt`       | Classifier prompt for tag suggestion (vocabulary-bounded picks).                                                        |
| `duplicate_prompt` | Classifier prompt for duplicate detection (duplicate / same_topic / unrelated).                                          |
| `structural_tags`  | Array of tags the tag suggester never proposes; default `["literature", "counterpoint", "synthesis", "excalidraw"]`.     |

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

Restart Claude Code. Your `config.json` lives in `PLUGIN_DATA` and is read as-is on the next run — an update never rewrites it, so edits take effect immediately and nothing is migrated over them. (The one exception is a first-ever run with no `PLUGIN_DATA/config.json`, where the plugin's own `config.json` is copied in to seed it.) The session-start hook re-checks `~/.local/bin/ll-watch` and `~/.local/bin/ll-search`; if either is missing it runs `scripts/install-shims.mjs --install` to write both. The shims resolve their targets at runtime, so they survive cache version changes.

Since v1.25.2, `hooks/session-start/cache-cleanup.mjs` compares the installed `ll-search` binary version against the running plugin version and spawns `download-binary.mjs` detached when they diverge. The current session keeps using whatever binary is on disk; the next session boots with the fresh one. One-session lag, no blocking — the gap where a plugin update bumped marketplace files but the native binary lagged is closed.

## CLI shims

Two shell scripts in `~/.local/bin/` give vault tools a stable name regardless of plugin version:

- `~/.local/bin/ll-search` -- search, indexing, identity, and similarity queries.
- `~/.local/bin/ll-watch` -- vault watcher that runs the librarian and incremental reindex.

The `ll-search` shim resolves `PLUGIN_DATA` from `$CLAUDE_PLUGIN_DATA` if set, otherwise from the marker file at `~/.claude/plugins/data/.ll-data-path` that the SessionStart hook writes, otherwise from the canonical default `~/.claude/plugins/data/learning-loop-learning-loop-marketplace`. It then exec's the binary at `$PLUGIN_DATA/bin/ll-search`. The ONNX runtime is not bundled next to the binary; `ll-core`'s `dylib::ensure_dylib()` downloads and SHA-256-verifies `libonnxruntime` on first run and sets `ORT_DYLIB_PATH` so the loader finds it (override the location with `ORT_DYLIB_PATH` or `LL_ORT_DIR`).

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
