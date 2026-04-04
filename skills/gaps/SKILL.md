---
name: gaps
description: 'Challenge vault knowledge through coverage, confidence, and counterpoint analysis. Usage: /learning-loop:gaps "topic" | /learning-loop:gaps (auto-pick) | /learning-loop:gaps --sweep. Scales depth to note maturity. Creates counterpoint notes, offers rewrites.'
---

# Gaps — Epistemic Gap Analysis

## Overview

The vault grows by accumulation. `/gaps` shakes the cage. It surfaces tensions, questions absences, and flags thin ice. The truth doesn't need to defend itself — weak beliefs get questioned, strong beliefs get stress-tested.

## When to Use

- `/gaps "topic"` — focused analysis on a specific topic
- `/gaps` — auto-picks the densest unchallenged cluster in the vault
- `/gaps --sweep` — runs across all major domain clusters

## Parameters

Parse from the invocation. All have defaults.

| Parameter | Options | Default |
|-----------|---------|---------|
| **topic** | any string | auto-pick if absent |
| **depth** | `shallow` / `medium` / `deep` | scales to note maturity |
| **sweep** | flag | off |
| **dry-run** | flag | off |

**Depth auto-scaling:**
- Permanent notes → deep
- Fleeting notes → medium
- Inbox notes → shallow
- Mixed maturity → use the highest

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start (after scope identified):**
```bash
PLUGIN/scripts/provenance-emit.js '{"agent":"gaps","skill":"gaps","action":"session-start","intent":"TOPIC","config":{"depth":"DEPTH"}}'
```

**At session end:**
```bash
PLUGIN/scripts/provenance-emit.js '{"agent":"gaps","skill":"gaps","action":"session-end","notes_analysed":N,"counterpoints_created":N,"rewrites":N,"thin_ice":N,"tensions":N,"blindspots":N}'
```

Per-note tracking is handled automatically by the PostToolUse hook.

## Process

### Step -1: Parameter Resolution

Use `AskUserQuestion` to help users discover and configure parameters when no arguments are provided.

**No arguments (`/gaps`):**
Before auto-picking, ask:

> What would you like to challenge? Options:
>
> - **A topic** — e.g., `/gaps "theanine"` — focused analysis on one domain
> - **Auto-pick** — I'll find the densest unchallenged cluster
> - **Sweep** — analyse all major domain clusters (`--sweep`)
> - **Dry-run** — show what would be analysed without running (`--dry-run`)
>
> Optional: `--depth shallow|medium|deep` (defaults to note maturity)

**Topic provided (`/gaps "topic"`):**
Proceed immediately. Depth auto-scales to note maturity.

**Flags provided (`/gaps --sweep`, `/gaps --dry-run`):**
Proceed immediately.

### Step 0: Select (auto-pick and sweep modes only)

**Auto-pick (`/gaps` with no topic):**
1. Run `node PLUGIN/scripts/vault-search.mjs cluster --threshold 0.7`
2. Find the densest cluster without recent `#gaps-reviewed` tag
3. Tell the user: "Analysing [cluster topic] — [N] notes, last reviewed [date/never]"
4. Proceed to Step 1 with inferred topic

**Sweep (`/gaps --sweep`):**
1. Cluster the entire vault
2. List all clusters with note counts
3. Process each cluster through Steps 1-4 sequentially
4. After all clusters: present cross-cluster summary

**Dry-run (`--dry-run`):**
1. Run selection/clustering as above
2. Show what would be analysed: topic, notes, depth
3. Stop. No research.

### Step 1: Orient

Launch all three subagents in parallel:

1. **Vault Scout** (`discovery-vault-scout`):
   - Pass: topic, vault_path (`{{VAULT}}/`), angle (if any)
   - Returns: existing notes, clusters, gaps, past conversations

2. **Adversarial Researcher** (`discovery-researcher`):
   - Pass: topic, depth (scaled to note maturity), angle: "Find counterarguments, methodological criticisms, alternative explanations, and evidence that contradicts the following claims: [list top claims from vault notes if known]"
   - existing_knowledge: empty on first pass (vault scout results aren't available yet)
   - The adversarial angle is critical — the researcher must look for challenges, not confirmations

3. **Domain Survey Researcher** (`discovery-researcher`):
   - Pass: topic, depth (scaled to note maturity), angle: "Comprehensively map the domain of [topic]. What are all the major subtopics, frameworks, debates, methods, and open questions? Survey the full landscape — not just what confirms or challenges existing knowledge, but the complete territory."
   - existing_knowledge: empty on first pass
   - The survey angle finds what's missing entirely, not what's wrong

Determine depth from vault scout results:
- Check which folders the found notes live in
- Apply depth scaling rules

### Step 2: Analyse

Launch the **Gap Analyser** (`gap-analyser`):
- Pass: notes (full content from vault scout), research (from adversarial researcher), domain_survey (from domain survey researcher), scope, depth
- The analyser reads its skills from `PLUGIN/agents/_skills/`
- Returns: structured report with thin ice, tensions, absences, and blindspots

### Step 3: Present

Show the gap analyser's report. Group findings:

1. **Thin ice** (weakest foundations first)
2. **Tensions** (strongest counter-evidence first)
3. **Blindspots** (domain blindspots first, then framing blindspots)
4. **Absences** (central gaps first, then adjacent, then peripheral)
5. **Coverage summary** (counts and overall assessment)

For each finding, offer actions inline:

```
Thin ice: "empty-stomach-maximizes-theanine-at-both-gates"
  — mechanistic inference from transporter competition.
  Direct meal-timing studies?
  → [C] Create counterpoint note  [D] Flag for /deepen  [skip]

Blindspot: The field of n-of-1 methodology covers adaptive randomization designs,
  which the vault has no notes on.
  → [R] Research with /discovery  [C] Create placeholder note  [skip]
```

### Step 4: Act

Based on user choices:

**Create counterpoint note** (free — just inbox):
- Launch `note-writer` with:
  - insight: the counterpoint or question
  - research: the evidence that raised it
  - related_notes: the challenged note(s)
  - destination: `0-inbox/`
- Note gets `#counterpoint` tag in frontmatter
- Note backlinks to the challenged note with context

**Rewrite original note** (ask permission first):
- Show proposed changes before applying
- Launch `note-writer` with existing_note content
- Only proceed with user approval

**Flag for /deepen**:
- Add to a suggested `/deepen` queue shown at the end

**Research blindspot** (via /discovery):
- Add to a suggested `/discovery` queue shown at the end
- These are topics the vault doesn't cover at all — they need research, not counterpoints

**Create placeholder note** (for blindspots):
- Launch `note-writer` with the domain survey's description of the missing territory
- Tags with `#blindspot` and links to the nearest related vault note
- Lands in `0-inbox/` as a stub for later `/deepen`

**Batch actions:**
- "Create all counterpoint notes" — batch launch note-writers
- "Flag all thin ice for /deepen" — add all to queue
- "Create all blindspot placeholders" — batch create stub notes for missing territory
- "Flag all blindspots for /discovery" — add all to research queue

### Step 5: Track

After analysis completes:
- Add `gaps-reviewed: YYYY-MM-DD` to frontmatter of reviewed notes
- This lets auto-pick and sweep skip recently reviewed clusters

### Step 6: Report

```
Gaps: "[topic]"
Depth: [depth] | Notes analysed: [N]
Thin ice: [N] findings
Tensions: [N] findings
Blindspots: [N] (domain: [N], framing: [N])
Absences: [N] (central: [N], adjacent: [N])
Actions taken: [N] counterpoints created, [N] rewrites, [N] flagged for /deepen, [N] blindspot stubs created
```

## Sweep Summary (sweep mode only)

After all clusters are processed:

```
Vault Sweep Complete
Clusters analysed: [N]
Cross-cluster tensions: [list any findings that span domains]
Vault-wide thin ice: [total count]
Vault-wide blindspots: [total count]
Vault-wide absences: [total count]
Most challenged domain: [cluster with most findings]
Strongest domain: [cluster with fewest findings]
```

## Subagent Usage

### discovery-vault-scout
- Launch at Step 1
- Pass topic, vault_path, angle
- Use results to identify which notes to analyse and determine depth

### discovery-researcher (adversarial)
- Launch at Step 1 in parallel with vault-scout and domain survey
- Adversarial angle is mandatory — always search for counter-evidence
- Depth matches note maturity scaling
- Internally verifies its own findings before returning

### discovery-researcher (domain survey)
- Launch at Step 1 in parallel with vault-scout and adversarial researcher
- Survey angle — map the full domain landscape, not challenge claims
- Depth matches note maturity scaling
- Output feeds blindspot detection in the analyser
- Internally verifies its own findings before returning

### gap-analyser
- Launch at Step 2 after both Step 1 agents complete
- Consumes notes + research
- Reads its own skills from `agents/_skills/`
- Returns structured analysis

### note-writer
- Launch at Step 4 for counterpoint notes and rewrites
- Counterpoints get `#counterpoint` tag and backlink to challenged note
- Follows capture-rules: persona voice, atomic, insight title

## Key Principles

- **Lens, not judge.** Surface what a critical thinker needs to see. The human decides what it means.
- **Questions, not verdicts.** "Has this been directly tested?" not "This claim is wrong."
- **Earned scrutiny.** Permanent notes get deep analysis. Inbox notes get a light touch.
- **No fabrication.** Every counterpoint needs a cited source. Speculation is not analysis.
- **Circular reinforcement is the enemy.** The same idea repeated across notes creates false confidence. Flag it.
- **Counterpoints are knowledge.** They land in inbox, get the same lifecycle as any note. They're not second-class.
