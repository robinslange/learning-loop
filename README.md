# learning-loop

A Claude Code plugin that builds a self-improving knowledge loop across sessions. Retrieval on start, capture during work, consolidation on close. Everything lives in an Obsidian vault.

## What it does

Every session starts with context: what you know about this topic, what you discussed before, what intentions are pending. During work, insights get captured to the vault automatically. At session end, learnings get routed to the right store. Over time the vault compounds.

The plugin provides 16 skills (slash commands), 13 specialized agents, 18 shared agent skills, a hybrid search engine (BM25 + vector), provenance tracking, and an experimental federation layer for cross-vault knowledge sharing.

## Prerequisites

The episodic-memory plugin (part of the superpowers bundle) is required for cross-session conversation search. Install it first if you don't already have it:

```bash
claude plugin install superpowers@claude-plugins-official
```

## Install

```bash
/plugin marketplace add robinslange/learning-loop
/plugin install learning-loop@learning-loop-marketplace
```

Restart Claude Code, then run `/learning-loop:init` to configure your vault path and persona.

## Setup

`/learning-loop:init` walks you through four phases:

1. **Detect and summarize** -- checks platform, vault, folders, binary, dependencies, federation
2. **Vault setup** -- path, folder structure, persona and capture rules
3. **Binary and dependencies** -- downloads `ll-search` binary (~75MB, includes embedding and reranker models), verifies vendored JS deps, indexes vault
4. **Federation** -- optional peer-to-peer knowledge sharing with provenance consent

Configuration lives in `PLUGIN_DATA` (`~/.claude/plugins/data/learning-loop/`) and persists across plugin updates.

## Skills

| Command | What it does |
|---|---|
| `/init` | First-time setup or reconfiguration |
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
| `/help` | Show all commands |

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

Notes flow inbox -> fleeting -> permanent as they mature. The promote-gate (6 criteria: depth, sourcing, linking, voice, atomicity, source integrity) determines routing. Source integrity failures block promotion to permanent regardless of other criteria.

## Agents

Agents are specialized subprocesses spawned by skills. They run in parallel where possible.

| Agent | Purpose | Model |
|---|---|---|
| discovery-researcher | Deep web research with source verification | Sonnet |
| discovery-vault-scout | Search vault + episodic memory for existing knowledge | Haiku |
| gap-analyser | Socratic analysis of claim quality and coverage | Sonnet |
| inbox-organiser | Batch triage with clustering, promotion, fleeting sweep | Sonnet |
| literature-capturer | Capture external sources as literature notes | Sonnet |
| note-deepener | Strengthen a single note with scaled research | Sonnet |
| note-scorer | Batch quality assessment | Haiku |
| note-verifier | Source verification and claim checking | Sonnet |
| note-writer | Write atomic notes in persona voice | Sonnet |
| ingest-context | Extract insights from pasted text | Haiku |
| ingest-linear | Pull and extract from Linear tickets | Haiku |
| ingest-repo | Scan repo surface for architecture insights | Haiku |
| diagram-rules | Shared Excalidraw generation spec | (reference) |

Agents share 18 skills in `agents/_skills/` covering promote-gate assessment, cross-validation, source verification, coverage mapping, blindspot detection, and more.

## Search

Hybrid search combining BM25 (full-text) and vector similarity (BGE-small-en-v1.5, quantized int8), with optional cross-encoder reranking (ms-marco-MiniLM-L-6-v2, quantized int8). All search, embedding, and reranking runs in the `ll-search` Rust binary -- zero native Node.js dependencies, all JS deps vendored.

```bash
# Hybrid semantic + keyword search
node scripts/vault-search.mjs query "caffeine tolerance"

# Hybrid search with cross-encoder reranking (better precision, +300ms)
node scripts/vault-search.mjs search "caffeine tolerance" --rerank

# Find similar notes
node scripts/vault-search.mjs similar "path/to/note.md"

# Cluster by similarity
node scripts/vault-search.mjs cluster --threshold 0.72

# Rebuild index
node scripts/vault-search.mjs index [--force] [--watch] [--sync]

# Find confusable note pairs
node scripts/vault-search.mjs discriminate <paths> --threshold 0.85

# Batch search+rerank+discriminate (used by /reflect)
node scripts/vault-search.mjs reflect-scan "query1" "query2" --top 5
```

The `--rerank` flag runs a cross-encoder over the top 20 hybrid candidates and reorders by semantic relevance. Adds ~300ms latency but significantly improves precision for ambiguous and long natural language queries. Search-critical agents (vault-scout, note-verifier, counter-argument linker) use reranking by default. The `reflect-scan` command batches multiple queries into a single process, sharing model init and embedding loads across queries for ~30% faster throughput.

The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. Both the embedding model and reranker model are bundled inside the `ll-search` binary.

## Sync

The ll-search binary handles federation sync directly:

```bash
ll-search index ~/brain/brain ~/brain/brain/.vault-search/vault-index.db --sync
ll-search sync <db> <vault>
ll-search export <db> <output> <vault>
ll-search watch <vault> <db> --sync-interval 300
ll-search download-binary --version v1.6.0
```

Sync runs automatically: reindex on session start, export+sync on session end (unless watch mode is running). Binary updates download from the federation hub (Ed25519 authenticated) with `gh` CLI fallback.

## Hooks

Five lifecycle hooks fire automatically:

| Event | Hook | What it does |
|---|---|---|
| SessionStart | session-start.js | Injects auto-memory index, recent captures, intention summary (context names + counts), retrieval protocol |
| Stop | stop-nudge.js | Suggests `/reflect` after substantial sessions |
| UserPromptSubmit | session-label.js | Labels sessions for episodic memory |
| PostToolUse | post-tool-provenance.js | Tracks vault reads/writes for provenance |
| PreCompact | pre-compact.js | Preserves context before compression |

## Provenance

Every vault operation (read, write, agent spawn, skill invocation) gets logged to `provenance/events-YYYY-MM.jsonl`. The `/health` command reads these logs to show session activity patterns.

```bash
# Generate provenance report
node scripts/provenance-report.mjs

# Consolidate logs into daily summaries (feeds federation sync)
node scripts/provenance-consolidate.mjs
```

## Source verification

The source-resolver script mechanically verifies citations against PubMed, Semantic Scholar, and CrossRef. LLM-generated PMIDs are wrong ~50% of the time, so this runs on every note before promotion to permanent.

```bash
# Verify all sources in a note
node scripts/source-resolver.mjs verify-note <path>

# Resolve a citation
node scripts/source-resolver.mjs resolve "Author Year Topic"

# Search PubMed with MeSH terms
node scripts/source-resolver.mjs search-pubmed "topic" --mesh
```

## Federation (experimental)

A curated knowledge network for sharing insights across vaults. Federation is invite-only -- a hub admin provisions your network access and registers your identity on the hub. See [interchange.live](https://interchange.live) for more.

### What you get

- **Federated search** -- your vault search results include relevant notes from peers, ranked by reciprocal rank fusion with provenance tracking
- **Visibility control** -- you decide what to share. Three tiers: `public` (full content), `listed` (title + summary only), `private` (not shared). Glob rules + per-note frontmatter overrides
- **Automatic sync** -- session hooks handle reindexing, exporting, and syncing. No manual commands needed
- **Ed25519 identity** -- each peer has a persistent cryptographic identity. All index exchanges are signed and verified

### How it works

Each peer exports a filtered index of their vault (respecting visibility rules) and uploads it to a coordination hub over encrypted WireGuard tunnels. Peers download each other's indexes and search locally. No note content leaves your machine unless you mark it public. The hub only stores indexes, not vault contents.

### Setup

Federation is configured during `/learning-loop:init` (Phase 4):

1. Connect to the network with a pre-auth key (provided by the hub admin)
2. Generate an Ed25519 identity
3. Send your public key to the hub admin for registration (manual step -- there is no self-registration)
4. Configure visibility rules
5. Test sync (re-run `/learning-loop:init` after the admin confirms registration)

### Visibility rules

Default configuration in `PLUGIN_DATA/federation/config.json`:

```json
{
  "visibility": {
    "default": "private",
    "rules": [
      { "pattern": "3-permanent/**", "tier": "public" },
      { "pattern": "1-fleeting/**", "tier": "listed" }
    ]
  }
}
```

Frontmatter `visibility: private` on any note overrides glob rules.

## Configuration

`config.json` in `PLUGIN_DATA` (`~/.claude/plugins/data/learning-loop/`):

```json
{
  "vault_path": "~/path/to/vault"
}
```

Config persists across plugin updates. On first run after upgrade from <1.4, config is auto-migrated from the old plugin root location.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

The `VAULT_PATH` environment variable overrides `config.json` if set.

## Updating

```bash
/plugin marketplace update learning-loop-marketplace
/plugin install learning-loop@learning-loop-marketplace
```

Restart Claude Code. The session-start hook auto-applies config changes on first run after update.

## Project structure

```
learning-loop/
  .claude-plugin/       Plugin manifest
  agents/               Specialized agent definitions
  agents/_skills/       Shared agent skills
  skills/               User-invocable skills (slash commands)
  scripts/              Vault search dispatcher, provenance, binary download
  vendor/               Vendored JS deps (sql.js WASM, ed25519, picomatch)
  hooks/                Lifecycle hooks (session start/stop, provenance)
  native/               Rust ll-search binary (indexing, embedding, search, sync)
  native/src/sync/      Federation sync client, export, watch, auth, download
```

## License

Proprietary. Copyright (c) 2026 Robin S. Lange. All rights reserved. See [LICENSE](LICENSE).
