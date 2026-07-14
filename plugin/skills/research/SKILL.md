---
name: research
description: 'Deep research with the local librarian doing the token-heavy middle. Scope on Claude, Search+Fetch+Extract on the local Ollama model, adversarial Verify + Synthesize back on Claude. Usage: /learning-loop:research "<question>". Falls back to Claude-native WebSearch when the librarian is unavailable or sub-tier.'
---

# Research: librarian-offloaded deep research

## Overview

Same shape as the built-in `/deep-research` — Scope → Search → Fetch → Extract →
3-vote adversarial Verify → Synthesize — but the **middle three phases run on the
local librarian** (via `bin/source-gateway.mjs research`: Brave search + fetch +
local Gemma claim extraction). Roughly 15 source documents are distilled to one-line
cited claims _before anything reaches Claude_. Scope, Verify, and Synthesize stay
on Claude — Verify is the step most likely to expose a small model's reasoning
gap, and it runs over cheap one-line claims, not prose.

If the librarian can't run (Ollama down, no Brave key, sub-tier model, or it
returns zero claims) the workflow **falls back to the Claude-native WebSearch
path** so the command never hard-breaks.

## When to use

- `/learning-loop:research "<question>"` — a deep, multi-source, fact-checked
  report when you have a research-capable local model (12b+; chosen at `/init`).
- If the question is underspecified (e.g. "what car to buy" with no
  budget/use-case/region), ask 2-3 clarifying questions first, then weave the
  answers into the question you pass.

## Prerequisites (the workflow checks these, but know them)

- Ollama running locally with a research-capable model resident (`gemma3:12b`
  default; the e2b tier is triage-only and will trip the capability gate).
- Brave API key in the macOS Keychain (`service="brave-search-api-key"`,
  `account=$USER`) — same key the Brave MCP uses.
- The model and `keep_alive` come from `librarian.*` config (set at `/init`).
  **Cold start:** the first 12b call adds ~10-40s; `keep_alive` (default 30m)
  keeps it warm after. To avoid a cold first call, warm it first:
  `curl -s localhost:11434/api/generate -d '{"model":"gemma3:12b","prompt":"hi","stream":false,"keep_alive":"30m"}' >/dev/null`

## How to run

**First, resolve the plugin root** — `${CLAUDE_PLUGIN_ROOT}` is set in your main
session but is NOT exported into Workflow subagent shells, so the workflow must be
handed a concrete absolute path. In a Bash block, run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" PLUGIN
```

That prints the absolute plugin root. Then invoke the `Workflow` tool:

```
Workflow({
  scriptPath: "<plugin root>/skills/research/workflow.js",
  args: { "question": "<the question>", "pluginRoot": "<plugin root>" }
})
```

`workflow.js` offloads Search+Fetch+Extract to one shell-out (using `pluginRoot`,
never the env var), normalizes the claims bundle into the shape the verify phase
expects, and keeps the proven Claude-side Verify + Synthesize unchanged. It is
authored verbatim — the offload and the fallback are the point; do not
"simplify" them away.

## Notes

- **Always report which engine ran.** When you present the result, state the
  `gatherMode`/`engine` field to the user up front — `librarian` (offload worked,
  token savings active) vs `claude-fallback` (librarian NOT used + the reason). A
  silent fallback otherwise looks identical to a successful offload; surfacing it
  is the only way the user can tell. A graceful fallback that stays silent about
  having fallen back masks the offload failure it was supposed to recover from.
- **The win is the Gather phase.** In librarian mode, source prose never enters
  Claude's context — only one-line claims with quotes. Scope is one agent call;
  Verify and Synthesize run over claims, not documents.
- **Fallback is automatic.** Sub-tier model (exit 3), Ollama/Brave down (exit 1),
  or an empty claims array → Claude-native WebSearch, same as built-in
  `/deep-research`. The `stats.gatherMode` field records which path ran.
- **Verify is routed by provenance.** A claim with a resolved `sourceId` and a
  positive `verdict` (pass or kill) is settled mechanically, deterministically,
  off-Claude. A `defer` verdict (ambiguous, could be a transient outage) or no
  sourceId falls through to the GLM 3-vote branch, also off-Claude. If GLM is down
  or unconfigured (exit 1 or 3) the whole claim falls back to the original Claude
  3-vote adversarial loop. The GLM branch is all-or-nothing per claim: no partial
  vote survival.
- **The audit is survivor-biased and log-only.** A ~20% sample of the GLM-judged
  claims (weighted toward survivors) is re-run on Claude's 3-vote loop and the two
  verdicts are compared. Disagreements are logged, not acted on: the GLM verdict
  ships. The audit only measures GLM drift; mechanical is deterministic and
  claude-fallback is already Claude.
- **Always report `verifyEngine` like `gatherMode`.** Surface whether verification
  ran on GLM, mechanically, or on Claude, so an off-Claude offload is never
  invisible. Same reason as the engine field above. The tested source of truth
  for the routing table is `scripts/librarian/verify-route.mjs`.
- This is the first skill to offload to the librarian; `scripts/librarian/research/`
  is built to be reused once it earns trust. See
  `scripts/librarian/research/README.md`.
