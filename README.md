# learning-loop

Claude Code forgets everything between sessions. This plugin makes it remember.

It connects Claude Code to an Obsidian vault and builds a knowledge system that compounds over time. Every session starts with what you already know. During work, insights get captured automatically. At session end, learnings get routed to the right place. The vault grows sharper, not just larger.

## What a session looks like

```
> /learning-loop:discovery "caffeine tolerance"

Recall: You have 3 notes on caffeine mechanisms, 1 literature note on CYP1A2.

Searching vault... 4 related notes found.
Searching web... 12 sources evaluated, 8 verified.

Here's what you already know and where the gaps are...
```

You steer the research. The plugin searches your vault first, then the web, verifies sources against PubMed and CrossRef, and writes atomic notes in your voice. Notes mature through inbox, fleeting, and permanent tiers based on a quality gate that checks depth, sourcing, linking, and source integrity.

Other things you can do mid-session:

- `/learning-loop:quick "does creatine affect sleep?"` -- fast verified answer
- `/learning-loop:gaps "caffeine"` -- find what your notes get wrong or miss
- `/learning-loop:verify inbox` -- check source integrity across your inbox
- `/learning-loop:reflect` -- consolidate session learnings to the right stores

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

This plugin is not lightweight. It runs local model inference and injects vault context into every session. You should know this before installing.

**Tokens:** Every session gets a context injection with your memory index, recent captures, and active intentions. A fresh vault adds almost nothing. A mature vault with hundreds of memories and notes adds thousands of tokens per session -- and it grows as your vault does. Skills like `/discovery` and `/gaps` spawn multiple parallel agents, each with its own context window. Heavy sweeps can fan out across 6+ agents.

**Local compute:** The `ll-search` binary (~77MB) bundles two quantized models (BGE-small-en-v1.5 for embeddings, ms-marco-MiniLM for reranking) and runs inference on your machine. Reranked searches and index rebuilds use multi-core inference. On an M4 Max, reranked search takes ~0.6s and indexing takes ~1.8s. On lower-spec machines these will be noticeably slower. An Apple Silicon Mac with 16GB+ RAM is the practical minimum for comfortable use.

**What we do to keep costs down:**
- Lightweight agents (vault search, scoring, ingestion) run on Haiku, not Sonnet
- Recent captures are capped at the last 5 notes, not the full inbox
- Intention summaries use compact format (context names and counts, not full content)
- Provenance, backlinks, and session labels write to disk -- they don't inject tokens into your context
- Pre-compact hook triggers note capture before Claude compresses context, so insights aren't lost to compression
- Search batches multiple queries into a single process (reflect-scan), amortizing model init across queries

## Why this instead of rolling your own

You could wire up hooks and note templates yourself. What takes time to build and test:

- **Source verification at write time.** Every note gets checked against PubMed, Semantic Scholar, and CrossRef before it lands. Author swaps, wrong years, and unconfirmable numbers get caught, not shipped. The naive regex approach for citation extraction had a ~60% false positive rate -- POS tagging with vendored winkNLP solved it.
- **Four-signal hybrid search.** BM25 + vector similarity + Personalized PageRank over the wikilink graph + IDF-weighted tag expansion, fused via RRF, with optional cross-encoder reranking. Graph signals surface bridge notes across domains. All in a single Rust binary.
- **Write-time guardrails.** A pre-write hook catches near-duplicates before they land. A post-write hook adds backlinks automatically. A dream gate nudges you to consolidate auto-memory when it's been long enough.
- **13 specialized agents** that run in parallel -- research, verification, gap analysis, note writing, batch triage. They share 18 skills covering promote-gate assessment, cross-validation, blindspot detection, and more.
- **A quality gate that blocks promotion.** Notes flow inbox to fleeting to permanent. Six criteria determine routing. Source integrity failures block promotion regardless of other scores.

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
| `/ingest` | Pull from Linear, repos, or pasted text |
| `/diagram "concept"` | Generate Excalidraw diagram |
| `/init` | First-time setup: vault path, persona, binary, federation |
| `/help` | Show all commands with usage details |

All commands are prefixed with `/learning-loop:` (e.g., `/learning-loop:discovery "caffeine"`). Run `/learning-loop:help` for full usage details.

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
The `ll-search` binary is ~77MB (includes embedding and reranker models). On slow connections, the download can take a few minutes. If it fails, re-run init -- it resumes from where it left off.

**Search returns no results**
Run `node scripts/vault-search.mjs index --force` to rebuild the index. The index lives in `<vault>/.vault-search/` and survives plugin reinstalls.

**Notes not showing up in vault**
Check that `config.json` in `~/.claude/plugins/data/learning-loop/` has the correct `vault_path`. The `VAULT_PATH` environment variable overrides it if set.

**Episodic memory not available**
Install episodic-memory first: `claude plugin install episodic-memory@superpowers-marketplace`. Restart Claude Code.

## License

Proprietary. Copyright (c) 2026 Robin S. Lange. All rights reserved. See [LICENSE](LICENSE).
