# Configuration

`config.json` in `PLUGIN_DATA` (`~/.claude/plugins/data/learning-loop/`):

```json
{
  "vault_path": "~/path/to/vault"
}
```

Config persists across plugin updates. On first run after upgrade from <1.4, config is auto-migrated from the old plugin root location.

Persona voice and capture rules live in the vault itself (`_system/persona.md` and `_system/capture-rules.md`), not in config. Agents read them directly.

The `VAULT_PATH` environment variable overrides `config.json` if set.

## Hooks

Eight lifecycle hooks fire automatically:

| Event | Hook | What it does |
|---|---|---|
| SessionStart | session-start.js | Injects auto-memory index, recent captures, intention summary, dream gate check |
| Stop | stop-nudge.js | Suggests `/reflect` after substantial sessions |
| UserPromptSubmit | session-label.js | Labels sessions for episodic memory |
| PreToolUse (Write) | pre-write-check.js | Catches near-duplicate notes before they land in the vault |
| PostToolUse (Write\|Edit\|Agent\|Skill) | post-tool-provenance.js | Tracks vault reads/writes for provenance |
| PostToolUse (Write) | post-write-backlink.js | Adds backlinks to related notes after vault writes |
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

The source-resolver script mechanically verifies citations against PubMed, Semantic Scholar, and CrossRef. The note-writer runs `verify-note` and `check-claims` on every note at write time, catching author swaps, wrong years, and flagging quantitative claims not confirmable from abstracts. Provenance events track pass/fail rates for empirical measurement.

Citation extraction uses POS tagging (vendored winkNLP) to distinguish author names from month names and common words -- the naive regex approach had a ~60% false positive rate on author-year patterns.

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
  scripts/              Vault search dispatcher, provenance, source-resolver, binary download
  scripts/lib/vendor/   Vendored JS deps (winkNLP for POS-tagged citation extraction)
  vendor/               Vendored JS deps (sql.js WASM, ed25519, picomatch)
  hooks/                Lifecycle hooks (session start/stop, provenance)
  native/               Rust ll-search binary (indexing, embedding, search, sync)
  native/src/sync/      Federation sync client, export, watch, auth, download
```
