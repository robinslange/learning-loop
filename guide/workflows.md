# Workflows

How skills chain together in practice. Each pattern below is a real workflow, not a hypothetical.

## Session lifecycle

A typical session has three phases:

1. **Context loads automatically.** The session-start hook injects your memory index, recent captures, and active intentions. The UserPromptSubmit hook searches your vault and past conversations on every prompt, injecting relevant context before Claude responds. You don't invoke anything for this.

2. **You work.** Research, capture, verify. Skills compose freely. Use what fits.

3. **You consolidate.** `/reflect` at end-of-session routes learnings to the right stores, promotes mature notes, and indexes the session for future retrieval.

## Research patterns

### Discovery into gaps into verify

The most thorough pattern for exploring a domain:

```
/discovery "topic"          -- surfaces vault knowledge, then searches the web
/gaps "topic"               -- finds what's thin, contradicted, or missing
/verify                     -- checks every source the agents cited
```

Discovery tells you what you know and what's new. Gaps tells you what you haven't thought about. Verify catches fabrication. Each step catches a distinct error class: overconfidence, blind spots, and hallucinated sources.

Run this cycle twice if the first pass produces many new notes. The second gaps pass operates on a richer vault and finds different weaknesses.

### Quick answer with auto-capture

For questions that don't need a full discovery session:

```
/quick "does melatonin suppress cortisol?"
```

Searches the vault and web, returns a verified answer, and auto-captures any novel findings. Useful when you need an answer now and want to grow the vault as a side effect.

### Literature capture in batch

When you find multiple papers during a research session:

```
/literature "https://arxiv.org/abs/2307.03172"
/literature "https://pubmed.ncbi.nlm.nih.gov/12345678"
```

Each invocation spawns an async agent that fetches the content, extracts core ideas in your voice, finds vault connections, and writes to `2-literature/`. You can fire several in sequence and verify them later.

For richer captures, add context: which vault notes it connects to, which mechanisms it informs, why you're capturing it. The agent uses this to write better cross-links.

## Capture patterns

### Quick-note for mid-flow insights

When something worth keeping surfaces and you don't want to break flow:

```
/quick-note "junction tables beat comma-delimited for M:N relationships"
/quick-note "CYP1A2 slow metabolizers accumulate caffeine 3x longer"
```

Drops an atomic note in `0-inbox/`. No filing, no formatting, no context switch. `/inbox` or `/reflect` handles triage later.

### Ingest for external content

Pull structured knowledge from outside the vault:

```
/ingest repo ~/dev/my-project     -- architecture, stack, patterns
/ingest linear "PROJECT-NAME"     -- tickets, decisions, project state
/ingest context                   -- paste text, images, or docs into the conversation
```

Ingest extracts atomic insights and writes them as inbox notes. Useful for onboarding to a new codebase or capturing meeting notes.

## Maintenance patterns

### Inbox triage

When inbox notes accumulate:

```
/inbox
```

Clusters notes by topic, classifies intention status, auto-promotes notes that pass the quality gate, and surfaces limbo notes (captured but never actioned) for you to close or plan. Also sweeps `1-fleeting/` for stale notes.

### Deepen a shallow note

When a note exists but lacks sources or depth:

```
/deepen "note-name"
```

Assesses the note's maturity, researches gaps scaled to what's missing, rewrites in your voice, verifies sources, and promotes when ready. Good for inbox notes that deserve permanent status but aren't there yet.

### Belief correction

When you discover something you've been building on is wrong:

```
/rewrite "old claim" "new claim" "reason for change"
```

Traces every dependent across vault, auto-memory, and episodic history. Shows an impact map classifying each downstream note by how it's affected. You approve changes before anything is rewritten.

## Consolidation patterns

### End-of-session reflect

```
/reflect
```

Reviews the conversation, extracts learnings, routes them to the correct store (auto-memory for project context, vault for durable knowledge), cross-links related notes, and promotes inbox notes that pass the gate. Run after any substantial work session.

### Between-session dream

```
/dream
```

Consolidates auto-memory only (not the vault). Merges duplicate entries, resolves conflicts, abstracts patterns, compresses verbose entries, prunes stale ones, and rebuilds the memory index. Run periodically to keep auto-memory clean.

### Health check

```
/health              -- counts, file lists, basic stats
/health --deep       -- full quality scoring across notes
/health --librarian  -- review background librarian observations
```

## Chaining skills

Skills are composable. Some useful chains beyond the standard research cycle:

| Chain | When to use |
|---|---|
| `/refresh` then `/discovery` | Check what you know before committing to a full research session |
| `/discovery` then `/diagram` | Research a mechanism, then visualize it |
| `/gaps` then `/deepen` | Find the weakest note on a topic, then strengthen it |
| `/verify` then `/gaps` | Fix sources first, then look for conceptual gaps |
| `/ingest repo` then `/gaps` | Onboard to a codebase, then find what's missing from your understanding |

## Context injection

You don't need to invoke anything for this. On every prompt, the UserPromptSubmit hook runs a dual-backend search (vault + episodic memory) and either injects relevant context (live mode) or logs what it would have injected (shadow mode, the default).

Shadow mode lets you review what the pipeline finds before trusting it. Run `node scripts/review-shadow.mjs` to inspect the shadow log, then flip `injection_mode` to `live` in `config.json` when you're satisfied.
