# learning-loop

A context engineering plugin for Claude Code. It teaches Claude how to work with what you know.

Episodic memory gives Claude recall. Learning-loop gives Claude judgment. It verifies sources before anything lands in your vault. It gates promotion on quality scores. It writes in your voice. It surfaces what you already know before searching the web. The result is a knowledge system that compounds through discipline, not volume.

## Why

Most note-taking systems decay. The vault grows, but old notes go unread, contradictions accumulate, and new sessions repeat work the last session already did. Learning-loop closes that loop. Every session starts by recalling what you already know. Every capture earns its place against quality gates. Every belief that changes gets traced through everything that depends on it.

The outcome is a vault that gets sharper, not heavier. Two layers wire the discipline into the runtime. Nine lifecycle hook handlers across six Claude Code event types fire regardless of what the model decides: retrieval before you ask, a duplicate-and-frontmatter gate before every vault write, and web research routed through a config-selected gateway. The capture agents enforce the rest, verifying citations against academic APIs before a note is written, gating promotion on quality scores, and propagating corrections when a belief changes. The full hook roster lives in [guide/configuration.md](guide/configuration.md).

## Install

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | bash
```

This takes ~3 minutes. It will:

1. Check your platform. This script is bash, so it covers macOS arm64, Linux x86_64, and WSL x86_64. Native Windows x64 is supported too — it has a prebuilt binary and `.cmd` shims — but install it via [Manual install](#manual-install) below. Other platforms need a [source build](guide/cross-platform.md).
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
claude mcp remove episodic-memory          # only if no other plugin uses it — check first: claude mcp list
rm -rf ~/.claude/plugins/data/learning-loop-learning-loop-marketplace/  # purge captured indexes
```

### Disabling parts without uninstalling

To turn off individual hooks, list their names under `hooks.disabled` in
`~/.claude/plugins/data/learning-loop-learning-loop-marketplace/config.json`:

```json
{ "hooks": { "disabled": ["session-label", "post-search-tracking"] } }
```

The names are the hook script basenames in `${CLAUDE_PLUGIN_ROOT}/hooks/`. A
disabled hook exits before reading its input and emits nothing, which every
registered event reads as "no opinion" — a disabled `PreToolUse` hook allows
the tool rather than blocking it. The config lives in plugin data, so it
survives updates; hand-editing `hooks.json` in the plugin cache does not.

To silence hooks from every plugin at once, use `"disableAllHooks": true` in
`~/.claude/settings.json`. That is the blunt instrument — it is not
learning-loop-specific — but it is the mechanism Claude Code itself exposes.
Claude Code's `permissions.deny` array accepts tool-name rules (`Bash(...)`,
`Read(...)`, `WebFetch`, etc.); there is no documented per-hook deny matcher at
this Claude Code version. See the
[permissions documentation](https://docs.anthropic.com/en/docs/claude-code/settings)
for the current syntax if you want finer control.

The per-hook table, with what each one costs to turn off, ships with the plugin
at `${CLAUDE_PLUGIN_ROOT}/README.md` so it is readable without network access.

## Capture surface & trust model

learning-loop persists derived indexes locally. What it reads and writes:

| Location                                                                     | Content                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| your vault path (configured via `/learning-loop:init`, e.g. `~/brain/brain`) | Notes you author; read on retrieval, written by capture skills                                                                               |
| `~/.claude/plugins/data/learning-loop-learning-loop-marketplace/`            | Edges database (backlinks, justification graph, supersession index), provenance logs, retrieval query logs, hook-error logs, session markers |
| `~/.claude/projects/<project>/memory/`                                       | Auto-memory files (preferences, project context) written when you approve a capture                                                          |

The edges database (`edges.db`) stores note-to-note relationships (backlinks, inferred semantic links, supersessions). The `retrieval/` subdirectory holds JSONL logs of every vault and episodic search query. The `provenance/` subdirectory records agent-spawn, skill-invoke, and vault-write events. Hook errors land in `hook-errors-<YYYY-MM>.jsonl` at the plugin data root.

**Trust posture.** Captured artefacts inherit the trust of their source tools. If a secret is pasted into chat or returned by a misbehaving tool, it can land in plugin data or auto-memory. Run `/learning-loop:doctor --redact` to scan for likely secrets. Do not paste credentials into chat.

**Vault as trust boundary.** Retrieved note content is re-emitted into agent context wrapped as untrusted data (Domain 06), so a prompt-injection attempt in a note cannot silently execute. However, operators who let third parties write to their vault inherit prompt-injection risk at the source — the wrapping only contains the blast radius.

### Air-gapped / update-controlled deployment

Set `LL_OFFLINE=1` to suppress every network call the plugin initiates on its own. With it set:

- the SessionStart GitHub update poll (`api.github.com`) does not fire;
- the binary auto-update download (`github.com/<repo>/releases/...`) does not run — including the manual `/init` and `/doctor` fetch paths;
- web-research source fetches (`/verify`, `/research`, `/discovery`, the source-resolver and claim-checker) short-circuit cleanly instead of attempting an external request and timing out.

Localhost is never gated — the Ollama daemon I use for local offload still works, so an air-gapped box keeps its local model. `/doctor` reports an **Offline mode: ON** line so I can confirm the suppression is actually engaged rather than silently skipped.

`LL_OFFLINE` is orthogonal to `LL_REPO` (which only repoints the binary download mirror and matters when *not* offline). One caveat: if I deliberately configure the librarian to use a remote OpenAI-compatible provider (`provider.kind: "openai"` with a `base_url`), that is an explicit opt-in egress and is not gated by `LL_OFFLINE` — the default librarian provider is localhost Ollama, which stays local.

### Hook scope

The `PostToolUse: Write|Edit|Task|Skill` matcher is intentionally broad. For `Write` and `Edit` events the handler runs the full vault-enrichment pipeline (autolink, edge inference, reflect tracking). For `Task` and `Skill` events it runs only lightweight provenance tracking — no vault read, no snapshot load. The matcher breadth is the feature: agent-spawn and skill-invoke events are recorded for auditability, cheaply, by the same dispatcher.

To disable hook tracking entirely without uninstalling, see [Disabling parts without uninstalling](#disabling-parts-without-uninstalling).

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
| `/dream-eval`           | Measure whether a `/dream` pass helps, hurts, or ties                         |
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
| `/uninstall`            | Guided removal of the plugin and its captured indexes                         |

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
- [Agents](guide/agents.md) -- 20 specialized agents and 20 shared skills
- [Federation](guide/federation.md) -- cross-vault knowledge sharing (experimental)
- [Configuration](guide/configuration.md) -- hooks, injection pipeline, provenance, source verification, cache health
- [Resource usage](guide/resource-usage.md) -- token costs, local compute, and what we do to keep it lean
- [Cross-platform support](guide/cross-platform.md) -- macOS / Linux / Windows status and known caveats
- [Troubleshooting](guide/troubleshooting.md) -- common issues and fixes

## About

Built by [omit.nz](https://omit.nz). This plugin is what happens when we codify our own knowledge work. We do the same thing for teams.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
