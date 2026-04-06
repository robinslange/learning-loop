# Configuration

`config.json` in `PLUGIN_DATA` (`~/.claude/plugins/data/learning-loop/`):

```json
{
  "vault_path": "~/path/to/vault"
}
```

Config persists across plugin updates. On first run after upgrading from <1.4, the plugin migrates config from the old root location.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

If set, the `VAULT_PATH` environment variable overrides `config.json`.

## Hooks

Ten hooks enforce process discipline at the lifecycle level. They run regardless of what Claude decides.

| Event | Hook | What it enforces |
|---|---|---|
| SessionStart | session-start.js | Injects vault context: memory index, recent captures, intention summary, dream gate |
| Stop | stop-nudge.js | Suggests `/reflect` after substantial sessions |
| UserPromptSubmit | session-label.js | Labels sessions for episodic memory retrieval |
| PreToolUse (Write) | pre-write-check.js | Blocks near-duplicate notes before they land |
| PostToolUse (Write\|Edit\|Agent\|Skill) | post-tool-provenance.js | Tracks every vault read/write for provenance |
| PostToolUse (Write\|Edit) | post-write-autolink.js | Adds backlinks and semantic links after vault writes |
| PostToolUse (Read) | post-read-retrieval.js | Tracks vault reads for retrieval instrumentation |
| PostToolUse (episodic-memory) | post-search-tracking.js | Tracks episodic memory searches |
| PreCompact | pre-compact.js | Captures context insights before compression |

These hooks are the core of the plugin's value. Without them, Claude can skip verification, promote unsourced notes, and write in its default voice. With them, these failures are structurally impossible.

## Provenance

Every vault operation (read, write, agent spawn, skill invocation) logs to `provenance/events-YYYY-MM.jsonl`. The `/health` command reads these logs to show session activity patterns.

```bash
# Generate provenance report
node scripts/provenance-report.mjs

# Consolidate logs into daily summaries (feeds federation sync)
node scripts/provenance-consolidate.mjs
```

## Source verification

The source-resolver verifies citations mechanically against PubMed, Semantic Scholar, and CrossRef. The note-writer runs `verify-note` and `check-claims` on every note at write time. It catches author swaps and wrong years, flags impossible journal combinations, and checks that cited studies support the claims made.

Citation extraction uses POS tagging (vendored winkNLP) to distinguish author names from month names and common words. The naive regex approach had a ~60% false positive rate on author-year patterns.

```bash
# Verify all sources in a note
node scripts/source-resolver.mjs verify-note <path>

# Check quantitative claims against source abstracts
node scripts/source-resolver.mjs check-claims <path>

# Resolve a citation
node scripts/source-resolver.mjs resolve "Author Year Topic"

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
  .claude-plugin/       Plugin manifest
  agents/               Specialized agent definitions
  agents/_skills/       Shared agent skills
  skills/               User-invocable skills (slash commands)
  scripts/              Vault search, provenance, source-resolver, binary download
  scripts/lib/vendor/   Vendored JS deps (winkNLP for POS-tagged citation extraction)
  vendor/               Vendored JS deps (sql.js WASM, ed25519, picomatch)
  hooks/                Lifecycle hooks (enforcement layer)
  native/               Rust ll-search binary (indexing, embedding, search, sync)
  native/src/sync/      Federation sync client
```
