# learning-loop

A context engineering plugin for Claude Code. It teaches Claude how to work with what you know.

Episodic memory gives Claude recall. Learning-loop gives Claude judgment. It verifies sources before anything lands in your vault. It gates promotion on quality scores. It writes in your voice. It surfaces what you already know before searching the web. The result is a knowledge system that compounds through discipline, not volume.

## Why

Most note-taking systems decay. The vault grows, but old notes go unread, contradictions accumulate, and new sessions repeat work the last session already did. Learning-loop closes that loop. Every session starts by recalling what you already know. Every capture earns its place against quality gates. Every belief that changes gets traced through everything that depends on it.

The outcome is a vault that gets sharper, not heavier. Eight lifecycle hook handlers across six Claude Code event types wire the discipline into the runtime — retrieval fires before you ask, gates fire before promotion, verification catches fabricated sources at write time, and corrections propagate when beliefs change.

## Install

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | bash
```

This takes ~3 minutes. It will:

1. Check your platform (macOS arm64 / Linux x86_64 / WSL x86_64 — the platforms with prebuilt `ll-search` binaries; others need a [source build](guide/cross-platform.md))
2. Ensure Node.js 22+ is available, using your existing version manager if present (nvm, fnm, volta, asdf, mise, n, brew). If none, offers fnm.
3. Add `~/.local/bin` to PATH (with a versioned marker in your shell rc, so it's safe to re-run)
4. Install Claude Code if missing
5. Add the [superpowers-marketplace](https://github.com/obra/superpowers-marketplace) and [learning-loop marketplace](https://github.com/robinslange/learning-loop)
6. Install both `episodic-memory` and `learning-loop` plugins

To inspect first: `curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | less`

After it finishes, open Claude Code and run `/learning-loop:init` to configure your vault.

### Manual install

If you'd rather do it yourself or you're on a platform the script doesn't support:

```bash
# 1. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code
# 2. Add marketplaces:
claude plugin marketplace add obra/superpowers-marketplace
claude plugin marketplace add robinslange/learning-loop
# 3. Install plugins:
claude plugin install episodic-memory@superpowers-marketplace
claude plugin install learning-loop@learning-loop-marketplace
# 4. Restart Claude Code, then run /learning-loop:init
```

## Dependencies

- **episodic-memory** (required). Provides semantic recall over past Claude Code conversations, which retrieval, `/discovery`, `/reflect`, and `/refresh` depend on. Install via `/plugin install episodic-memory@superpowers-marketplace` (lives in `obra/superpowers-marketplace`).

## Uninstall

Full removal (or run `/learning-loop:uninstall` for a guided version):

```
/plugin                                    # remove via marketplace UI
claude mcp remove episodic-memory          # remove the dependent MCP
rm -rf ~/.claude/plugins/data/learning-loop-learning-loop-marketplace/  # purge captured indexes
```

### Disabling parts without uninstalling

To keep commands but silence the hooks, use `"disableAllHooks": true` in
`~/.claude/settings.json`. This is a blunt instrument — it disables every
plugin's hooks, not just learning-loop's — but it's the mechanism Claude Code
exposes for hook suppression. Claude Code's `permissions.deny` array accepts
tool-name rules (`Bash(...)`, `Read(...)`, `WebFetch`, etc.); there is no
documented per-hook deny matcher at this Claude Code version. See the
[permissions documentation](https://docs.anthropic.com/en/docs/claude-code/settings)
for the current syntax if you want finer control.

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

| Command                 | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `/discovery "topic"`    | Research with web search and vault context                                    |
| `/research "question"`  | Deep research with the local librarian doing the token-heavy middle           |
| `/doctor`               | Diagnose and fix your learning-loop install (read-mostly, per-fix consent)    |
| `/quick "question"`     | Fast verified answer with auto-capture                                        |
| `/quick-note "insight"` | Capture to inbox without breaking flow                                        |
| `/deepen "note"`        | Strengthen a note with research, sources, links                               |
| `/literature <URL>`     | Capture an external source as a literature note                               |
| `/verify`               | Check note quality and source integrity                                       |
| `/gaps "topic"`         | Surface thin ice, tensions, and blindspots                                    |
| `/inbox`                | Batch triage inbox notes, promote mature ones                                 |
| `/reflect`              | End-of-session consolidation                                                  |
| `/dream`                | Auto-memory consolidation between sessions                                    |
| `/refresh "topic"`      | See what you already know (no web research)                                   |
| `/rewrite "old" "new"`  | Retract a belief across vault, auto-memory, and episodic history              |
| `/health`               | Vault health dashboard                                                        |
| `/health --librarian`   | Review librarian observations                                                 |
| `/ingest`               | Pull from Linear, repos, or any content Claude can read                       |
| `/seed [--for-job]`     | Build a portable starter slice for a fresh instance (new job, second machine) |
| `/harvest [--all]`      | Carry opt-in, IP-scrubbed insights from a work instance back home             |
| `/diagram "concept"`    | Generate Excalidraw diagram                                                   |
| `/init`                 | First-time setup: vault path, persona, binary, optional integrations          |
| `/federation`           | Set up federation: identity, token redeem, peers, visibility, sync            |
| `/help`                 | Show all commands with usage details                                          |

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
- [Agents](guide/agents.md) -- 20 specialized agents and 19 shared skills
- [Federation](guide/federation.md) -- cross-vault knowledge sharing (experimental)
- [Configuration](guide/configuration.md) -- hooks, injection pipeline, provenance, source verification, cache health
- [Resource usage](guide/resource-usage.md) -- token costs, local compute, and what we do to keep it lean
- [Cross-platform support](guide/cross-platform.md) -- macOS / Linux / Windows status and known caveats
- [Troubleshooting](guide/troubleshooting.md) -- common issues and fixes

## About

Built by [omit.nz](https://omit.nz). This plugin is what happens when we codify our own knowledge work. We do the same thing for teams.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
