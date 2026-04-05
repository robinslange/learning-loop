# learning-loop

Claude Code forgets everything between sessions. This plugin makes it remember.

It connects Claude Code to an Obsidian vault and builds a knowledge system that compounds over time. Every session starts with what you already know. During work, insights get captured in your voice. At session end, learnings get routed to the right place. The vault grows sharper, not just larger.

## What a session looks like

You're reading about caffeine tolerance. You run:

```
> /learning-loop:discovery "caffeine tolerance"
```

The plugin searches your vault first. You already have three notes on caffeine mechanisms and a literature note on CYP1A2. It searches the web, evaluates a dozen sources against 11 academic APIs (PubMed, Semantic Scholar, CrossRef, OpenAlex, arXiv, Europe PMC, DBLP, Unpaywall, RFC Editor, Open Library, ChEMBL), catches an author misattribution on a real PMID, and writes atomic notes in your voice. It tells you what you already know and where the gaps are.

Later you find an interesting paper. You capture it without breaking flow:

```
> /learning-loop:literature "https://arxiv.org/abs/2307.03172"
```

Before closing the session, you consolidate:

```
> /learning-loop:reflect
```

Learnings route to the right stores. Notes that pass the quality gate get promoted. Notes that don't stay where they are until they're ready.

## What it actually does

**Source verification at write time.** Every note gets checked before it lands. The resolver hits 11 APIs, cross-references author names against fetched metadata, catches year mismatches, flags impossible journal combinations, and verifies that cited studies actually support the claims made. Measured fabrication rates without this: PubMed IDs ~43%, DOIs ~26%. The naive regex approach for citation extraction had a ~60% false positive rate, so we vendored winkNLP for POS tagging.

**Four-signal hybrid search.** BM25 + vector similarity + Personalized PageRank over the wikilink graph + IDF-weighted tag expansion, fused via RRF, with optional cross-encoder reranking. Graph signals surface bridge notes across domains. All in a single Rust binary.

**Write-time guardrails.** A pre-write hook catches near-duplicates. A post-write hook adds backlinks automatically. A convergence checker decides when research has enough coverage to stop.

**13 specialized agents** that run in parallel for research, verification, gap analysis, note writing, and batch triage. They share 18 skills covering promotion gating, cross-validation, blindspot detection, and more.

**A quality gate that blocks promotion.** Notes flow inbox to fleeting to permanent. Six criteria determine routing. Source integrity failures block promotion regardless of other scores.

## Install

Requires the [episodic-memory](https://github.com/anthropics/claude-code) plugin for cross-session conversation search:

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

This plugin is not lightweight. It runs local model inference and injects vault context into every session.

**Tokens:** Every session gets a context injection with your memory index, recent captures, and active intentions. A fresh vault adds almost nothing. A mature vault with hundreds of memories and notes adds thousands of tokens per session, and it grows as your vault does. Skills like `/discovery` and `/gaps` spawn multiple parallel agents, each with its own context window.

**Local compute:** The `ll-search` binary (~77MB) bundles two quantized models (BGE-small-en-v1.5 for embeddings, ms-marco-MiniLM for reranking) and runs inference on your machine. On an M4 Max, reranked search takes ~0.6s and indexing takes ~1.8s. On lower-spec machines these will be noticeably slower. An Apple Silicon Mac with 16GB+ RAM is the practical minimum.

**What we do to keep costs down:**
- Lightweight agents (vault search, scoring, ingestion) run on Haiku
- Recent captures capped at the last 5 notes, not the full inbox
- Intention summaries use compact format (names and counts, not full content)
- Provenance, backlinks, and session labels write to disk, not into your context
- Pre-compact hook captures insights before Claude compresses context
- Search batches multiple queries into a single process, amortizing model init

## Skills

| Command | What it does |
|---|---|
| `/discovery "topic"` | Interactive research with web search and vault context |
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

- [Search](guide/search.md) -- hybrid search commands, reranking, clustering
- [Agents](guide/agents.md) -- all 13 specialized agents and shared skills
- [Federation](guide/federation.md) -- experimental cross-vault knowledge sharing
- [Configuration](guide/configuration.md) -- hooks, provenance, source verification, project structure

## Troubleshooting

**`/learning-loop:init` hangs on binary download**
The `ll-search` binary is ~77MB (includes embedding and reranker models). On slow connections, the download can take a few minutes. If it fails, re-run init.

**Search returns no results**
Run `node scripts/vault-search.mjs index --force` to rebuild the index. The index lives in `<vault>/.vault-search/` and survives plugin reinstalls.

**Notes not showing up in vault**
Check that `config.json` in `~/.claude/plugins/data/learning-loop/` has the correct `vault_path`. The `VAULT_PATH` environment variable overrides it if set.

**Episodic memory not available**
Install episodic-memory first: `claude plugin install episodic-memory@superpowers-marketplace`. Restart Claude Code.

## License

Proprietary. Copyright (c) 2026 Robin S. Lange. All rights reserved. See [LICENSE](LICENSE).
