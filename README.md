# learning-loop

A context engineering plugin for Claude Code. It teaches Claude how to work with what you know.

Episodic memory gives Claude recall. Learning-loop gives Claude judgment. It enforces source verification before anything lands in your vault. It gates promotion on quality scores. It writes in your voice, not its own. It surfaces what you already know before searching the web. The result is a knowledge system that compounds through discipline, not volume.

## What it solves

Claude fabricates sources. Measured rates: ~43% of PubMed IDs, ~26% of DOIs. Without mechanical verification, these contaminate your notes and propagate through every future session that retrieves them.

Claude writes like Claude. Without persona enforcement and capture rules, your vault fills with homogeneous LLM prose that sounds the same regardless of topic or domain.

Claude forgets process. It will skip verification, promote half-sourced notes, and synthesize before the evidence supports it. Hooks and quality gates make these failures structurally impossible, not a matter of prompt discipline.

## How it works

**Process enforcement through hooks.** Eleven lifecycle hooks fire automatically. A pre-write hook catches near-duplicates before they land. A post-write hook adds backlinks. Source verification runs at write time, not as an afterthought. The quality gate blocks promotion regardless of how good the prose sounds. A Stop hook spawns a detached background reindex after each turn so retrieval stays fresh without blocking work.

**Just-in-time context injection.** When you ask a substantive question, a UserPromptSubmit hook searches your vault and past conversations and injects the top matches into Claude's context before it responds. Ships in shadow mode by default — logs what it *would* have injected without touching your prompts. Tune `injection_threshold` (default `0.35`) and flip `injection_mode: "live"` in `config.json` after reviewing the shadow log with `scripts/review-shadow.mjs`.

**Five-signal hybrid search.** BM25 + vector similarity + Personalized PageRank over your wikilink graph + IDF-weighted tag expansion + Rocchio pseudo-relevance feedback, fused via RRF. Optional cross-encoder reranking. Graph signals surface bridge notes across domains that no single keyword or embedding would find. All runs in a single Rust binary backed by the `ll-core` library crate.

**15 specialized agents.** Research, verification, gap analysis, note writing, batch triage, and cross-store correction run in parallel. They share 18 skills covering promotion gating, cross-validation, blindspot detection, and source integrity. Lightweight agents run on Haiku. Research and judgment agents run on Sonnet.

**A background librarian that never sleeps.** An optional local agent (Gemma 4 E2B via ollama) continuously wanders your vault, finding orphan notes that should be linked to their neighbors, flagging topic-style inbox titles, and marking potentially stale claims. It queues observations for Claude to review when you run `/health --librarian`. E2B does what it's good at (classification with evidence); Claude handles the deep investigation. No API calls, completely local.

**A vault that earns its structure.** Notes flow from inbox through fleeting to permanent. Six criteria gate each transition. Source integrity failures block promotion. The vault grows sharper because every note that reaches permanent status survived mechanical scrutiny.

## What a session looks like

You run `/learning-loop:discovery "caffeine tolerance"`. The plugin searches your vault first. You already have three notes on caffeine mechanisms and a literature note on CYP1A2. It searches the web, checks sources against 12 academic APIs, catches a misattributed author on a real PMID, and writes atomic notes in your voice. It tells you what you already know and where the gaps are.

You find a paper. `/learning-loop:literature "https://arxiv.org/abs/2307.03172"` captures it without breaking flow.

Before closing: `/learning-loop:reflect`. Learnings route to the right stores. Notes that pass the quality gate get promoted. Notes that don't stay where they are until they're ready.

## Install

Requires [episodic-memory](https://github.com/anthropics/claude-code) for cross-session conversation search:

```bash
claude plugin install episodic-memory@superpowers-marketplace
```

Then install learning-loop:

```bash
/plugin marketplace add robinslange/learning-loop
/plugin install learning-loop@learning-loop-marketplace
```

Restart Claude Code, then run `/learning-loop:init` to configure your vault path and persona voice.

## Resource usage

This plugin is heavy. It runs local model inference and injects vault context into every session.

**Tokens:** Every session gets a context injection with your memory index, recent captures, and active intentions. A fresh vault adds almost nothing. A mature vault adds thousands of tokens per session, and grows. Skills like `/discovery` and `/gaps` spawn multiple parallel agents, each with its own context window.

**Local compute:** The `ll-search` binary (~77MB) bundles two quantized models (BGE-small-en-v1.5 for embeddings, ms-marco-MiniLM for reranking) and runs inference on your machine. On an M4 Max, reranked search takes ~0.6s and indexing ~1.8s. An Apple Silicon Mac with 16GB+ RAM is the practical minimum. Linux x64 and Windows x64 binaries are CI-built; see [guide/cross-platform.md](guide/cross-platform.md) for per-platform status.

**Librarian (optional):** If enabled via `/init` Phase 7, the vault librarian runs Gemma 4 E2B (~5GB active RAM) via ollama alongside `ll-search watch`. It investigates notes at ~15s each, writing observations to a local queue. No API calls, no cloud costs. Requires ollama installed and 16GB+ system RAM.

**What we do to keep costs down:**
- Lightweight agents (vault search, scoring, ingestion) run on Haiku
- Recent captures capped at the last 5 notes
- Intention summaries use compact format
- Provenance, backlinks, and session labels write to disk, not into context
- Pre-compact hook captures insights before Claude compresses context
- Search batches multiple queries into a single process

**Measuring cache impact.** `/learning-loop:init` Phase 6 offers to install a bundled `cache-health` oh-my-claude statusline plugin (if oh-my-claude is present). It logs per-turn cache hit rates from the statusline payload to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl`. Run `node scripts/cache-health-report.mjs` for weighted hit rate, percentile distribution, and zero-hit events — useful for measuring the cost impact of flipping `injection_mode` from shadow to live.

## Skills

| Command | What it does |
|---|---|
| `/discovery "topic"` | Research with web search and vault context |
| `/quick "question"` | Fast verified answer with auto-capture |
| `/quick-note "insight"` | Capture to inbox without breaking flow |
| `/deepen "note"` | Strengthen a note with research, sources, links |
| `/literature <URL>` | Capture an external source as a literature note |
| `/verify` | Check note quality and source integrity |
| `/gaps "topic"` | Surface thin ice, tensions, and blindspots |
| `/inbox` | Batch triage inbox notes, promote mature ones |
| `/reflect` | End-of-session consolidation |
| `/dream` | Auto-memory consolidation between sessions |
| `/refresh "topic"` | See what you already know (no web research) |
| `/rewrite "old" "new"` | Retract a belief across vault, auto-memory, and episodic history |
| `/health` | Vault health dashboard |
| `/health --librarian` | Review librarian observations: approve links, acknowledge voice flags, investigate staleness |
| `/ingest` | Pull from Linear, repos, or any content Claude can read |
| `/diagram "concept"` | Generate Excalidraw diagram |
| `/init` | First-time setup: vault path, persona, binary, federation |
| `/help` | Show all commands with usage details |

All commands are prefixed with `/learning-loop:` (e.g., `/learning-loop:discovery "caffeine"`).

## Vault structure

```
your-vault/
  0-inbox/          Rough captures, new ideas
  1-fleeting/       Developing notes, partially sourced
  2-literature/     External source captures
  3-permanent/      Complete, sourced, linked, voiced
  4-projects/       Project index notes
  5-maps/           Synthesis and discovery maps
  _system/          Persona and capture rules
  Excalidraw/       Diagrams
```

## Go deeper

- [Search](guide/search.md) -- five-signal hybrid search, reranking, retrieval instrumentation
- [Agents](guide/agents.md) -- 15 specialized agents and 18 shared skills
- [Federation](guide/federation.md) -- cross-vault knowledge sharing (experimental)
- [Configuration](guide/configuration.md) -- hooks, injection pipeline, provenance, source verification, cache health
- [Cross-platform support](guide/cross-platform.md) -- macOS / Linux / Windows status and known caveats

## Troubleshooting

**`/learning-loop:init` hangs on binary download**
The `ll-search` binary is ~77MB (includes embedding and reranker models). On slow connections, the download can take a few minutes. If it fails, re-run init.

**Search returns no results**
Run `node scripts/vault-search.mjs index --force` to rebuild the index. The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. The Stop hook also spawns a detached incremental reindex after each turn, so the index normally stays current without manual intervention.

**Shadow injection log shows 0 passes**
First check that the backends are alive — open a recent shadow record and look at `backends.vault.error` and `backends.episodic.error`. If you see `spawn ... ENOENT`, run `/learning-loop:init` to install the binary. If `episodic-memory` exits with a NODE_MODULE_VERSION mismatch, rebuild with `npm rebuild --prefix ~/.claude/plugins/cache/superpowers-marketplace/episodic-memory/<version>`. If both backends are healthy but the gate never passes, the threshold is too high — lower `injection_threshold` in `config.json` (or set `LEARNING_LOOP_INJECTION_THRESHOLD`).

**Notes not showing up in vault**
Check that `config.json` in `PLUGIN_DATA` (set by `CLAUDE_PLUGIN_DATA` env var) has the correct `vault_path`. If set, the `VAULT_PATH` environment variable overrides it.

**Librarian not starting**
Check that `librarian.enabled` is `true` in your config, ollama is running (`ollama serve`), and Gemma 4 E2B is pulled (`ollama pull gemma4:e2b`). The librarian starts as a child of `ll-search watch`; it won't run standalone without the watcher. Check stderr output for "Waiting for ollama..." or "Librarian disabled in config".

**Episodic memory not available**
Install episodic-memory first: `claude plugin install episodic-memory@superpowers-marketplace`. Restart Claude Code.

## License

Proprietary. Copyright (c) 2026 Robin S. Lange. All rights reserved. See [LICENSE](LICENSE).
