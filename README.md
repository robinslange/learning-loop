# learning-loop

A context engineering plugin for Claude Code. It teaches Claude how to work with what you know.

Episodic memory gives Claude recall. Learning-loop gives Claude judgment. It enforces source verification before anything lands in your vault. It gates promotion on quality scores. It writes in your voice, not its own. It surfaces what you already know before searching the web. The result is a knowledge system that compounds through discipline, not volume.

## What it solves

Claude fabricates sources. Measured rates: ~43% of PubMed IDs, ~26% of DOIs. Without mechanical verification, these contaminate your notes and propagate through every future session that retrieves them.

Claude writes like Claude. Without persona enforcement and capture rules, your vault fills with homogeneous LLM prose that sounds the same regardless of topic or domain.

Claude forgets process. It will skip verification, promote half-sourced notes, and synthesize before the evidence supports it. Hooks and quality gates make these failures structurally impossible, not a matter of prompt discipline.

## How it works

**Process enforcement through hooks.** Nine lifecycle hooks fire automatically. A pre-write hook catches near-duplicates before they land. A post-write hook adds backlinks. Source verification runs at write time, not as an afterthought. The quality gate blocks promotion regardless of how good the prose sounds.

**Four-signal hybrid search.** BM25 + vector similarity + Personalized PageRank over your wikilink graph + IDF-weighted tag expansion, fused via RRF. Optional cross-encoder reranking. Graph signals surface bridge notes across domains that no single keyword or embedding would find. All runs in a single Rust binary.

**12 specialized agents.** Research, verification, gap analysis, note writing, and batch triage run in parallel. They share 18 skills covering promotion gating, cross-validation, blindspot detection, and source integrity. Lightweight agents run on Haiku. Research agents run on Sonnet.

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

**Local compute:** The `ll-search` binary (~77MB) bundles two quantized models (BGE-small-en-v1.5 for embeddings, ms-marco-MiniLM for reranking) and runs inference on your machine. On an M4 Max, reranked search takes ~0.6s and indexing ~1.8s. An Apple Silicon Mac with 16GB+ RAM is the practical minimum.

**What we do to keep costs down:**
- Lightweight agents (vault search, scoring, ingestion) run on Haiku
- Recent captures capped at the last 5 notes
- Intention summaries use compact format
- Provenance, backlinks, and session labels write to disk, not into context
- Pre-compact hook captures insights before Claude compresses context
- Search batches multiple queries into a single process

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
| `/health` | Vault health dashboard |
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

- [Search](guide/search.md) -- hybrid search, reranking, retrieval instrumentation
- [Agents](guide/agents.md) -- 12 specialized agents and 18 shared skills
- [Federation](guide/federation.md) -- cross-vault knowledge sharing (experimental)
- [Configuration](guide/configuration.md) -- hooks, provenance, source verification

## Troubleshooting

**`/learning-loop:init` hangs on binary download**
The `ll-search` binary is ~77MB (includes embedding and reranker models). On slow connections, the download can take a few minutes. If it fails, re-run init.

**Search returns no results**
Run `node scripts/vault-search.mjs index --force` to rebuild the index. The index lives in `<vault>/.vault-search/` and survives plugin reinstalls.

**Notes not showing up in vault**
Check that `config.json` in `PLUGIN_DATA` (set by `CLAUDE_PLUGIN_DATA` env var) has the correct `vault_path`. If set, the `VAULT_PATH` environment variable overrides it.

**Episodic memory not available**
Install episodic-memory first: `claude plugin install episodic-memory@superpowers-marketplace`. Restart Claude Code.

## License

Proprietary. Copyright (c) 2026 Robin S. Lange. All rights reserved. See [LICENSE](LICENSE).
