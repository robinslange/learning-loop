# learning-loop

A context engineering plugin for Claude Code. It teaches Claude how to work with what you know.

Episodic memory gives Claude recall. Learning-loop gives Claude judgment. It verifies sources before anything lands in your vault. It gates promotion on quality scores. It writes in your voice. It surfaces what you already know before searching the web. The result is a knowledge system that compounds through discipline, not volume.

## Why

Claude fabricates sources (~43% of PubMed IDs, ~26% of DOIs). Without mechanical verification, these contaminate your notes and propagate through every session that retrieves them. Learning-loop makes this structurally impossible: eleven lifecycle hooks enforce verification at write time, quality gates block promotion of half-sourced notes, and persona rules keep your vault in your voice.

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

## What it looks like

**Researching a topic you've partially explored.**
You run `/discovery "caffeine tolerance"`. The plugin searches your vault first and finds three existing notes on caffeine mechanisms plus a literature note on CYP1A2. It then searches the web, verifies sources against academic APIs, catches a misattributed author on a real PMID, and writes atomic notes in your voice. You see what you already knew, what's new, and where the gaps are.

**Catching bad sources before they spread.**
After a research session produces 12 new notes, you run `/verify`. It checks every citation mechanically: does the PMID exist, does the DOI resolve, does the author match, does the abstract actually support the claim. One session caught 18 errors across compound profiles because agents had confidently cited papers that didn't say what they claimed.

**Capturing without breaking flow.**
Mid-conversation you realize something worth keeping. `/quick-note "junction tables beat comma-delimited membership for M:N"` drops it in your inbox. No context switch, no manual filing. `/reflect` at end-of-session routes it to the right place.

**Correcting a belief across everything.**
You learn that a claim you've been building on is wrong. `/rewrite "old pattern" "new pattern"` traces every note, auto-memory entry, and episodic record that depends on it, shows you the impact map, and rewrites only what you approve.

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
| `/health --librarian` | Review librarian observations |
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

- [Workflows](guide/workflows.md) -- common patterns, session lifecycle, and chaining skills together
- [Search](guide/search.md) -- five-signal hybrid search, reranking, retrieval instrumentation
- [Agents](guide/agents.md) -- 15 specialized agents and 18 shared skills
- [Federation](guide/federation.md) -- cross-vault knowledge sharing (experimental)
- [Configuration](guide/configuration.md) -- hooks, injection pipeline, provenance, source verification, cache health
- [Resource usage](guide/resource-usage.md) -- token costs, local compute, and what we do to keep it lean
- [Cross-platform support](guide/cross-platform.md) -- macOS / Linux / Windows status and known caveats
- [Troubleshooting](guide/troubleshooting.md) -- common issues and fixes

## License

Proprietary. Copyright (c) 2026 Robin S. Lange. All rights reserved. See [LICENSE](LICENSE).
