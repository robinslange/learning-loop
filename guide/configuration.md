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

`injection_threshold` is the minimum score the top vault hit must clear before context is injected. The vault score is a raw **weighted** RRF fusion sum, **not** a cosine similarity. Each lane contributes `weight/(5+rank)`, and since v1.40.0 the lanes are weighted unequally (vector 1.0, BM25 1.0, PRF 0.5, PPR 0.05, tags 0.05), so the reachable range is:

| Agreement                      | Score  |
| ------------------------------ | ------ |
| vector #1 alone                | 0.1667 |
| vector #1 + BM25 #1            | 0.3333 |
| vector #1 + BM25 #1 + graph #1 | 0.3500 |
| vector #1 + BM25 #1 + PRF #1   | 0.4167 |
| all five lanes #1 (ceiling)    | 0.4333 |

Defaults to `0.34` — just above the two-strong-lanes floor, so the gate demands corroboration beyond two lone top hits. Cosine-style values (0.7+) are unreachable, and anything above 0.4333 disables injection entirely. This value is derived from achievable-score arithmetic, not from measured relevance: every percentile on record predates the reweighting (see the derivation comment on `INJECTION_THRESHOLD` in `scripts/lib/hook-config.mjs`). Tune by inspecting `scripts/review-shadow.mjs` output, which reports gate reachability against the observed distribution. Override per-session with the `LEARNING_LOOP_INJECTION_THRESHOLD` env var.

`filename_style` controls the pre-write filename-convention advisory. Values: `'kebab'` (enforce kebab-case, e.g. `my-note.md`), `'spaces'` (enforce space-separated titles, e.g. `My Note.md`), `'auto'` (detect from the vault population), or absent (same as `'auto'`). In `auto` mode the hook reads up to 200 basenames across `0-inbox/`, `1-fleeting/`, and `3-permanent/` at write time; if >70% lack spaces the convention is kebab, if >70% have spaces the convention is spaces, otherwise the check is skipped. The advisory is non-blocking — it appears as `additionalContext`, never as a deny.

### `projects`

Maps a repository directory name to a folder under `4-projects/` when the two differ. The ledger derives the project from the git common directory (worktrees collapse onto their main repo) and looks the basename up here first.

```js
{ "projects": { "registry-frontend-client-sample-app": "registry-frontend-sample-app" } }
```

Related constants in `scripts/lib/hook-config.mjs`: `LEDGER_MIN_PROMPTS` (5), `LEDGER_GIT_TIMEOUT_MS` (300), `LEDGER_GIT_BUDGET_MS` (900), `SESSION_SUMMARY_MIN_INTERVAL_MS` (600000), `LEDGER_TRANSCRIPT_MAX_BYTES` (16MB), `LEDGER_SINCE_FALLBACK_MS` (600000). Disable with `hooks.disabled: ["session-ledger"]`.

`label_topics` extends the session labels written for episodic-memory retrieval with your own topics. The built-in patterns cover generic engineering vocabulary; add domain terms as `{match, label}` pairs, where `match` is a case-insensitive regex source string:

```json
{
  "label_topics": [
    { "match": "\\bkayak\\b", "label": "kayaking" },
    { "match": "\\bresto\\s?druid\\b", "label": "wow" }
  ]
}
```

An entry with an invalid regex is logged and skipped rather than throwing — labels degrade, hooks do not.

Config persists across plugin updates. If config exists at the old root location (pre-PLUGIN_DATA), the plugin migrates it automatically on first run.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

If set, the `VAULT_PATH` environment variable overrides `config.json`.

Config files are read with UTF-8 BOM stripping so Notepad-saved JSON on Windows parses correctly.

The session ledger note is a deliberate privacy choice: it contains transcript text (the first prompt, up to 200 characters; the last assistant message, up to 600; skill args and agent descriptions, up to 80 each), passed through the credential scrubber before it is written, written with `fs` directly so `pre-write-check.js` does not gate it, and pinned `visibility: private` so federation's globs never send it onward. `visibility: private` is a convention honoured by note tooling and federation's globs, not an access control: anything with filesystem access to the vault can still read the note.

## Hooks

Ten hook handlers across seven event types enforce process discipline at the lifecycle level. They run regardless of what the agent decides. This table is the canonical roster.

Claude Code and Codex share `hooks/hooks.json` verbatim: the event names, the nested config shape, the stdin payload, and the JSON output contract are the same on both, and Codex sets `CLAUDE_PLUGIN_ROOT` for compatibility with existing plugin hooks. Matchers therefore name every tool either harness uses, and a tool a harness does not have simply never fires. Two matchers below are Claude Code only, and Codex covers them through `hooks/hooks.codex.json` instead — see [Codex differences](#codex-differences).

| Event                                         | Hook                    | What it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart                                  | session-start.js        | Injects vault context (memory index, learned patterns, federation status, a recent-captures pointer, intention summary, dream gate nudge) and dispatches to subhooks in `hooks/session-start/` for cache cleanup, binary auto-update, health detection, vault snapshot, and watch-daemon spawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Stop                                          | stop-nudge.js           | Suggests `/reflect` after substantial sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Stop, SessionEnd                              | session-ledger.js       | Writes the session ledger: one `4-projects/<project>/ledger/` note per substantial session (branch, commits, files changed, skills, agents, PR URLs, first prompt, last assistant message), overwritten on every Stop and stamped with the end reason on SessionEnd. Emits a numeric-only `session-summary` provenance record, throttled to once per ten minutes plus once at SessionEnd. Advisory: never prints, never blocks. This is a deliberate privacy choice: the note contains transcript text (the first prompt, up to 200 characters; the last assistant message, up to 600; skill args and agent descriptions, up to 80 each), passed through the credential scrubber before it is written, written with `fs` directly so `pre-write-check.js` does not gate it, and pinned `visibility: private` (a convention honoured by note tooling and federation's globs, not an access control) so federation never sends it onward regardless of any visibility glob. |
| UserPromptSubmit                              | session-label.js        | Labels sessions for episodic memory retrieval; runs the just-in-time injection pipeline (shadow or live per `injection_mode`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SubagentStop                                  | subagent-stop.js        | Emits an `agent-result` provenance record (session id + transcript path) when a subagent finishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PreToolUse (Write\|Edit)                      | pre-write-check.js      | Warns on near-duplicate similarity (≥0.85) and broken wikilinks; blocks duplicate frontmatter tags, em/en dashes added to note body prose, and frontmatter-contract violations introduced in `0-inbox`/`1-fleeting`/`2-literature`/`3-permanent` notes (missing or empty `tags`/`date`/`source`, the deprecated `created:`/`updated:`/`source-project:` keys, a non-`YYYY-MM-DD` date, an off-vocabulary `status:`). Both the dash and schema checks are added-only deltas against the note on disk, so pre-existing violations are inherited rather than denied; `Source:`/`Related:` lines are exempt from the dash rule                                                                                                                                                                                                                                                                                                                                                |
| PreToolUse (WebSearch\|WebFetch)              | web-guard.js            | Denies the raw web tools globally (main session included; PreToolUse cannot scope to subagents) and routes web access through the source gateway, `bin/source-gateway.mjs`, so every search, fetch, and research call the guard can see goes through a config-selected source with a per-session fetch budget. On Claude Code that is every web call, because the tools are hookable; on Codex the shell path is advisory only (see Codex differences)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PostToolUse (Write\|Edit\|Task\|Skill\|Agent) | post-tool.js            | Coalesced dispatcher. Loads one vault snapshot, then runs the provenance, reflect-track, autolink, and edge-infer modules in fixed order (cheap load-bearing modules first, so a hook timeout only drops enrichment) with per-module timeout isolation. Non-write tool events only run provenance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PostToolUse (Read)                            | post-read-retrieval.js  | Tracks **auto-memory** file reads (`~/.claude/projects/<project>/memory/*.md`) for retrieval instrumentation. Vault reads are not recorded here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PostToolUse (mcp\_\_plugin_episodic-memory)   | post-search-tracking.js | Tracks episodic memory searches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The post-tool modules live under `hooks/modules/`, listed in execution order:

- **provenance** — records vault writes and edits, plus agent-spawn (`Task`) and skill-invoke (`Skill`) events, to the provenance log. There is no `Read` branch
- **reflect-track** — appends each new vault Write/Edit to the `/reflect` new-notes marker while the marker exists (added v1.25.3)
- **autolink** — adds backlinks and semantic links after vault writes
- **edge-infer** — classifies wikilink pairs via regex into six typed edges — `derived_from`, `evidence_for`, `supports`, and the `challenges_undermining` / `challenges_undercutting` / `challenges_rebuttal` family — and writes them to `edges.db`

These hooks are the core of the plugin's value. Without them, the agent can skip verification, promote unsourced notes, and write in its default voice. With them, the vault-write failures are structurally impossible: `pre-write-check` sees every write on both harnesses and denies before it lands. The web guard is weaker and always was — it is a routing nudge, not a boundary, and on Codex it only ever sees the shell.

### Codex differences

Codex loads `hooks/hooks.json` unchanged, plus `hooks/hooks.codex.json` via the `hooks` array in `.codex-plugin/plugin.json`. Four things differ, and only four:

| Difference                                                                                                           | Consequence                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex performs every file mutation through `apply_patch`, and one call can touch several files                       | `hooks/lib/tool-payload.mjs` normalises a patch into Write/Edit-shaped entries before any module sees it, so `pre-write-check` and every `post-tool` module run once per file, unchanged                                                                                                                                                                   |
| `WebSearch` and `WebFetch` are hosted tools that never reach the local hook path (Codex has no WebFetch tool at all) | `web-guard.js` cannot see them. The Codex-only hooks file wires it to `Bash` instead, where it denies a named fetcher aimed at an explicit remote URL. That is a nudge, not a boundary: a scheme-less `curl example.com`, an absolute `/usr/bin/curl`, a URL in a variable, or any fetcher outside the list all pass. Hosted search is ungoverned outright |
| Codex has no `Read` function tool; reads happen in the shell                                                         | `post-read-retrieval.js` matches `Bash` on Codex and derives candidates from markdown paths in the command. Approximate, and it only ever feeds retrieval telemetry                                                                                                                                                                                        |
| Plugin-bundled hooks are untrusted until reviewed                                                                    | Nothing runs until the user runs `/hooks` inside Codex and trusts the definitions. This cannot be done for them, and it cannot be detected from outside                                                                                                                                                                                                    |
| Codex runs hook commands through a **login** shell (`$SHELL -lc`)                                                    | Anything a login profile prints to stdout is prepended to hook output. `Stop` and `SubagentStop` require valid JSON on stdout, so a chatty `.zprofile` breaks those two hooks on Codex and never on Claude Code                                                                                                                                            |

One asymmetry worth watching once real usage starts: `POST_TOOL_MODULE_TIMEOUT_MS` is per module, and the post-tool chain now runs once per file in a patch. A patch touching many vault notes multiplies the worst case against the 12s `hooks.json` deadline, where a Claude Code write can only ever cost one file's worth.

Subagents are the other asymmetry. Codex loads custom agents from standalone TOML in `~/.codex/agents/` and has no plugin manifest field for them, so `install.sh` generates them from `plugin/agents/*.md` via `scripts/codex/generate-agents.mjs`. The markdown files stay the single source of truth; re-run the generator after any upgrade. Codex also has no typed `subagent_type` parameter — it spawns on a named instruction. `skills-shared/dispatch.md` holds the phrasing for both harnesses, and every skill defers to it rather than naming a dispatch mechanism itself.

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

## OTEL export

Export is off unless BOTH `OTEL_EXPORTER_OTLP_ENDPOINT` is set AND `otel.export_enabled` is `true` in `config.json`. That two-knob gate is a cooperative signal for a LAN, single-operator deployment, not a technical control: anything that can set config.json can set the env var too.

The endpoint is used verbatim, including plain `http://`, since it is meant for a LAN receiver (Grafana Alloy) rather than a public one. `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, if set, overrides the base endpoint for metrics specifically, per the OTLP spec.

Seven reducers re-derive the whole corpus per run and export counts, durations, and closed enum labels: `session_id` is allowlisted as an attribute (no reducer stamps it today), but paths, prompts, note titles, and any other free text never do. Every field is checked against an inclusion allowlist (`otel/schema.mjs`) that fails closed: a field absent from a stream's schema throws rather than shipping.

`OTEL_RESOURCE_ATTRIBUTES` (comma-separated `key=value` pairs) is filtered through the same kind of allowlist: only `service.version`, `service.namespace`, and `deployment.environment` pass through, each value rejected if it contains a `/`, a `\`, whitespace, or exceeds 64 characters. `service.name` is not in the allowlist at all: it always identifies learning-loop itself and cannot be overridden from the environment. Every dropped key is logged once per process.

Each reducer's cumulative start time is the earliest timestamp still on disk across its monthly files. When retention sweeps away the oldest month, the earliest surviving record becomes the new start time, so a receiver may see one counter reset per rotation rather than a continuously monotonic series.

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
| `LEARNING_LOOP_INJECTION_THRESHOLD`   | Per-session override of `injection_threshold` (weighted-RRF fusion-sum scale, max `0.4333`, e.g. `0.35`)       |
| `LEARNING_LOOP_INJECTION_FORCE_ERROR` | Set to `1` to simulate a pipeline failure for testing the error path                                           |
| `LEARNING_LOOP_INJECTION_MIN_SPECIFICITY` | Per-session override of the minimum prompt specificity (distinct content words) required for injection, default `8` |
| `LEARNING_LOOP_INJECTION_RACE_CAP_MS` | Wall-clock cap in milliseconds on the padded-vs-bare-prompt retrieval race in `session-label.js`, default `1500` |
| `LL_HUB_ENDPOINT`                     | Federation hub URL for `ll-search` sync, overriding the value in config; unset means the configured hub or none |
| `LL_MODELS_DIR`                       | Directory `ll-search` loads its ONNX models from at runtime, for air-gapped or pre-staged installs (see `native/README.md`) |
| `LL_MODEL_CACHE_DIR`                  | Build-time only: where `ll-core`'s build script caches downloaded model files |
| `LL_RERANKER`, `LL_RERANKER_MODEL_PATH`, `LL_RERANKER_TOKENIZER_PATH` | Build-time only: point `ll-core`'s build script at a local reranker model and tokenizer instead of downloading them |
| `LEARNING_LOOP_ALWAYS_INJECT_MEMORY`  | Set to `1` to force context injection every turn regardless of the specificity gate                            |
| `LEARNING_LOOP_SYNTHETIC`             | Set to `1` to mark shadow-injection telemetry as synthetic (calibration runs), so review tooling can filter it out |
| `LL_GATEWAY_FETCH_BUDGET`             | Per-session `source-gateway.mjs fetch` budget (default `10`)                                                   |
| `LL_PRE_WRITE_BUDGET_MS`              | Overrides the pre-write duplicate-gate's cold-subprocess wall-clock budget. The supported lever when a host's cold model start exceeds the shipped `hooks.json` deadline; raise the `hooks.json` timeout to match, since it is replaced on every plugin update |
| `LL_DISABLE_DETECTOR`                 | Set to `1` to turn off the session-start health detector line                                                  |
| `LL_HOOK_DEBUG`                       | Set to `1` for verbose hook debug logging                                                                      |
| `LL_HARNESS`                          | Explicit harness name (`codex` or `claude-code`), written by `install.sh` into Codex's shell environment policy; distinguishes the Codex plugin-hook path where `PLUGIN_ROOT`/`PLUGIN_DATA` are otherwise ambiguous |
| `LL_REPO`                             | GitHub `owner/repo` the binary downloader and update checker fetch releases from, default `robinslange/learning-loop` |
| `LL_BENCH_REAL_ONNX`                  | Set to `1` to run the ONNX-dependent bench variants (see `bench/README.md`)                                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | OTLP/HTTP+JSON metrics receiver base URL. See [OTEL export](#otel-export) below.                               |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Metrics-specific endpoint override, takes precedence over the base URL above                                   |
| `OTEL_RESOURCE_ATTRIBUTES`            | Comma-separated `key=value` resource attributes; filtered through the allowlist in [OTEL export](#otel-export) |

`LL_SID`, `LL_REFLECT_SID`, `LL_CHILD_PID_FILE`, `LL_SESSION_TMP_DIR` and `LL_AUTOLINK_ML_TIMEOUT_MS` are internal handshake and test seams between plugin-owned processes; none of them is meant to be set by hand.

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

| Key                    | Default                  | Purpose                                                                                                      |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `enabled`              | `false`                  | Opt-in. Set `true` to start the librarian with `ll-watch`.                                                   |
| `model`                | `gemma4:e2b`             | Ollama model for classification. RAM-tiered by `/init` (`gemma3:12b` on 32GB+); research needs the 12b tier. |
| `pace_seconds`         | `2`                      | Delay between note investigations. Higher values reduce resource pressure.                                   |
| `queue_cap`            | `200`                    | Max pending items before the librarian pauses. Items expire after 30 days or when the target note is edited. |
| `ollama_url`           | `http://localhost:11434` | Ollama API endpoint.                                                                                         |
| `pause_on_battery`     | `true`                   | Suspend the librarian while the machine is on battery power (polled).                                        |
| `battery_poll_seconds` | `60`                     | How often to re-check power state when `pause_on_battery` is on.                                             |

Six override knobs are read by `scripts/librarian/config.mjs` but omitted from the shipped config; set them under `librarian` only when the built-in defaults (defined in that file) need replacing:

| Key                | Purpose                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `link_prompt`      | System prompt for the agentic link investigation on orphan notes.                                                    |
| `voice_prompt`     | Classifier prompt for the voice gate (claim vs topic titles).                                                        |
| `tag_prompt`       | Classifier prompt for tag suggestion (vocabulary-bounded picks).                                                     |
| `duplicate_prompt` | Classifier prompt for duplicate detection (duplicate / same_topic / unrelated).                                      |
| `structural_tags`  | Array of tags the tag suggester never proposes; default `["literature", "counterpoint", "synthesis", "excalidraw"]`. |
| `keep_alive`       | How long ollama keeps the model resident after idle; default `30m`.                                                  |

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

Every vault write, edit, agent spawn and skill invocation logs to `provenance/events-YYYY-MM.jsonl`. Reads are not recorded here — the provenance module has no `Read` branch. The `/health` command reads these logs to show session activity patterns.

Most events do not name the skill that caused them directly (a hook writing a note has no notion of "skill"), so `emitProvenance` derives `skill` when a caller omits it: the PostToolUse hook records the most recently invoked `Skill` tool for the session in a marker, and any later event from that session picks it up if it does not already carry one, including `agent-result`. A dispatched subagent has no notion of skill either, but the session that spawned it does. The marker survives for 8 hours, so a session's last skill remains the best attribution until the next `Skill` call. `session-summary` and `session-start` are hook-owned rather than skill-caused, so they never gain a derived `skill`.

Whatever ends up in `skill`, caller-supplied or derived, is validated by identifier shape (`name` or `plugin:name`, letters/digits/`._-`, at most two segments) rather than against a fixed directory, since the `Skill` tool also invokes other plugins' skills, such as `superpowers:brainstorming` and `ygrep:ygrep`, and those are legitimate values. Learning-loop's own skills, bare (`reflect`) or `learning-loop:`-prefixed, canonicalise to the bare name; other plugins' skills keep their `plugin:name` form, lower-cased. A value that does not match the identifier shape at all becomes `unknown`, and the rejection is logged by the length of the rejected value only, never its contents.

```bash
# Generate provenance report
node scripts/provenance-report.mjs

# Consolidate logs into daily summaries (feeds federation sync)
node scripts/provenance-consolidate.mjs
```

## Source verification

The source-resolver verifies citations mechanically against 13 APIs: PubMed, PubMed Central (PMC), Europe PMC, arXiv, Semantic Scholar, CrossRef, OpenAlex, bioRxiv/medRxiv, DBLP, Unpaywall, RFC Editor, Open Library, and ChEMBL.

Twelve of those need no configuration. **Unpaywall does**: its API requires a contact email, so the adapter returns `null` — silently skipping open-access enrichment — unless `unpaywall_email` is set. Note this one lives in the source-resolver's own config file, `PLUGIN_DATA/data/resolver-config.json`, not in `config.json`:

```json
{ "unpaywall_email": "you@example.com" }
```

It only enriches DOI results with open-access status and a free-full-text URL; leaving it unset costs you `is_oa`/`oa_url`, not verification. The note-writer runs `verify-note` and `check-claims` on every note at write time. It catches author swaps and wrong years, flags impossible journal combinations, and checks that cited studies support the claims made.

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

Open sessions pick the update up without a restart: every hook enters through `hooks/run.mjs`, which runs the handler from the version Claude Code has installed, and skills call scripts through `ll-run`. Skill and agent text and the hook registrations themselves are read once per session, so run `/reload-plugins` when a release changes those. The previous version directory stays on disk for sessions still using it; Claude Code marks it `.orphaned_at` and removes it later. Your `config.json` lives in `PLUGIN_DATA` and is read as-is on the next run -- an update never rewrites it, so edits take effect immediately and nothing is migrated over them. (The one exception is a first-ever run with no `PLUGIN_DATA/config.json`, where the plugin's own `config.json` is copied in to seed it.) The session-start hook compares every shim in `~/.local/bin` against the text the running version renders and rewrites them when any is missing or different.

Since v1.25.2, `hooks/session-start/cache-cleanup.mjs` compares the installed `ll-search` binary version against the running plugin version and spawns `download-binary.mjs` detached when they diverge. The current session keeps using whatever binary is on disk; the next session boots with the fresh one. One-session lag, no blocking — the gap where a plugin update bumped marketplace files but the native binary lagged is closed. If a watch daemon is already running when the download finishes, `download-binary.mjs` restarts it immediately (stop, then start, through `watch.mjs`'s own dispatch), so it does not keep running the old process image and old `--librarian-script` path for the rest of the session.

## CLI shims

Four shims in `~/.local/bin/` give the plugin's tools a stable name regardless of plugin version: `ll-search` (search, indexing, identity, similarity), `ll-watch` (vault watcher and librarian), `ll-paths` (print a resolved path, e.g. `ll-paths VAULT`) and `ll-run` (run a plugin script by name, e.g. `ll-run health-check.mjs`).

`ll-watch`, `ll-paths` and `ll-run` are each one `node -e` line that finds the active install and hands off to its `scripts/shim.mjs`, where their behaviour lives and updates with the plugin. The install is the `learning-loop@learning-loop-marketplace` entry in `~/.claude/plugins/installed_plugins.json`, or, when Claude Code has none, the newest version under `~/.codex/plugins/cache/learning-loop-marketplace/learning-loop/`. `ll-run` looks under `scripts/` then `bin/`. `ll-search` never starts node: it is a shell shim that runs `$PLUGIN_DATA/bin/ll-search` (plugin-data from `$CLAUDE_PLUGIN_DATA`, the `~/.claude/plugins/data/.ll-data-path` marker, or the default location) with the ONNX runtime env, for about 3ms of overhead. The ONNX runtime is not bundled next to the binary; `ll-core`'s `dylib::ensure_dylib()` downloads and SHA-256-verifies `libonnxruntime` on first run (override with `ORT_DYLIB_PATH` or `LL_ORT_DIR`).

The shim text carries no version or machine path, so SessionStart rewrites a shim only when a release actually changes it. To install or repair them manually:

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
