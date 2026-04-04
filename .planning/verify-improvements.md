# Verify Skill Improvements

Based on the 2026-03-30 full vault sweep (1006 notes, 21 Haiku scorers).

## Problem Statement

Three issues surfaced:
1. **Scoring drift**: Haiku agents applied the same rubric inconsistently (82% deep in some batches, 18% in others)
2. **Provenance gap**: Subagent scoring results were invisible to the provenance system (hook already updated to handle scores.jsonl)
3. **Manual cluster detection**: Promotion clusters were identified by hand; could be automated

## Improvement 1: Calibration Anchors in Scorer Prompt

**File**: `agents/note-scorer.md`

**Change**: Add a `## Calibration Examples` section with 3 scored vault notes (one per tier). The scorer reads these before scoring the batch, anchoring what "shallow", "medium", and "deep" look like concretely.

**Implementation**:
- Pick 3 real vault notes as canonical examples (one shallow, one medium, one deep)
- Add them inline in the agent definition so every Haiku instance gets the same calibration
- The examples should cover different domains (one technical, one research, one design) to prevent domain bias

**Candidate anchors** (from the sweep):
- Shallow: `effects-fire-children-first-parents-last.md` (clear claim, decent body, but no sources, minimal links)
- Medium: `apollo-cache-normalizes-via-typename-plus-id-into-flat-refs.md` (good depth, some sourcing, 2 links, solid voice)
- Deep: `via-negativa-runs-through-all-sage-traditions.md` (rich body, specific sources, 3+ links, compressed voice, atomic)

**Expected effect**: Scoring variance across batches drops. The rubric becomes concrete, not interpretive.

## Improvement 2: Main-Thread Score Aggregation for Provenance

**File**: `skills/verify/skill.md` (Step 3 and Step 6)

**Change**: After collecting text results from scorer subagents, the main thread parses them into structured scores and writes to `provenance/scores.jsonl` using the Write tool. The PostToolUse hook (already updated) captures these.

**Implementation**:
- In Step 3, after all scorers return, add: "Parse each agent's TSV/table output into JSON score objects"
- In Step 6 (report), add: "Write all scores to `PLUGIN/provenance/scores.jsonl` using the Write tool"
- Each score line: `{"action":"score","target":"note.md","tier":"deep","depth":3,"sourcing":3,"linking":2,"voice":3,"atomicity":3}`

**The hook handler already exists** (lines 71-84 of post-tool-provenance.js). We just need the verify skill to actually write to it.

## Improvement 3: Auto-Detect Promotion Clusters

**File**: `skills/verify/skill.md` (new Step 7.5 between Fix Plan and Batch Actions)

**Change**: After scoring, group notes by filename prefix (e.g., `zustand-*`, `gemini-*`, `cbc-*`) and tag co-occurrence. For each cluster of 3+ notes where >80% score deep, offer batch promotion.

**Implementation**:
- Extract prefix: split filename on first `-` that follows a word boundary, group by prefix
- Filter: clusters with 3+ notes, >80% deep tier
- Present: "Cluster: zustand (12 notes, 100% deep) -- promote all?"
- On approval, `mv` all files from main thread (provenance captured by hook)

**This replaces** the manual cluster identification from the sweep session.

## Improvement 4: Batch Size Increase for Sweeps

**File**: `skills/verify/skill.md` (Step 3)

**Change**: Current batching is ~10 notes per scorer agent. The sweep used ~50 per agent successfully. For sweep-scale operations (>100 notes), increase batch size to 50.

**Implementation**:
- Add a batching rule: `>= 100 notes: Split into batches of ~50. Launch one note-scorer agent per batch.`
- Keep the ~10 batch size for smaller scopes (inbox, topic)
- Haiku handles 50 notes fine; the bottleneck is Read calls, not reasoning

## Execution Order

1. **Calibration anchors** (note-scorer.md) -- highest impact, smallest change
2. **Score provenance** (verify skill.md Step 3+6) -- closes the observability gap
3. **Auto-detect clusters** (verify skill.md Step 7.5) -- automation convenience
4. **Batch size** (verify skill.md Step 3) -- sweep efficiency

Each is independent. Can be done in any order or parallel.
