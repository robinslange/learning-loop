---
name: ingest
description: 'Pull external context into the second brain. Handles any format Claude can read: PDFs, images, code, conversations, docs, or raw text. Usage: /learning-loop:ingest linear ["project"], /learning-loop:ingest repo [path], /learning-loop:ingest context, /learning-loop:ingest (prompts for source).'
---

# Ingest: External Context Import

## Overview

Pulls data from external sources (Linear, repositories, or any content Claude can read), extracts atomic insights, previews them for confirmation, then routes to auto-memory and/or vault notes. The context mode accepts anything: PDFs, images, code files, conversation dumps, documents, or plain text.

## When to Use

- `/ingest linear`: pull my assigned Linear tickets
- `/ingest linear "Project Name"`: pull tickets from a specific project
- `/ingest linear --state "In Progress"`: filter by ticket state
- `/ingest repo ~/path/to/repo`: scan a repository
- `/ingest repo`: prompt for repo path
- `/ingest context`: provide any content (paste text, give a file path, drop an image)
- `/ingest`: ask which source type
- `--refine`: append to any source mode (e.g., `/ingest context --refine`) to enable Step 5.6 upstream refinement after ingest. Off by default; will move to default-on after a few validation runs.

## Process

### Step 0: Parameter Resolution

Parse the source type from the first argument.

**No argument (`/ingest`):**
Use `AskUserQuestion`:

> What would you like to ingest?
>
> - **linear**: Pull Linear tickets (my assigned, or a specific project)
> - **repo**: Scan a repository for architecture and patterns
> - **context**: Provide any content (text, PDF, image, code, doc) to extract insights from

**Source type provided:**
Parse remaining args as source-specific parameters.

### Step 1: Resolve Source Parameters

**Linear:**
- No additional args → scope = "me" (all assigned tickets)
- Quoted string arg → scope = that project name
- `--state "X"` → state filter
- Announce: "Pulling Linear tickets ({scope})..."

**Repo:**
- Path arg → use it
- No path → `AskUserQuestion`: "Which repository? (full path)"
- Verify path exists with `ls`
- Announce: "Scanning {path}..."

**Context:**
- `AskUserQuestion`: "What would you like to ingest? You can paste text, provide a file path (PDF, image, code, doc), or describe what you'd like to import."
- If a file path is given, read it with the Read tool before passing to the agent.
- Announce: "Extracting insights..."

### Step 2: Launch Source Agent

Spawn the appropriate agent in the foreground. In the prompts below, resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch (see `agents/_skills/vault-io.md` → Placeholders). Each bash block re-derives the same paths from `$CLAUDE_CODE_SESSION_ID`; when passing paths into agent prompts or other tools, substitute the resolved literal value.

**Linear:** Spawn a `learning-loop:ingest-linear` agent (the `subagent_type` matches the agent name, so its `model: haiku` and `tools:` allowlist apply). Resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch (see `agents/_skills/vault-io.md` → Placeholders), so the agent can read its shared `_skills/` contracts:

```
Read your agent definition at ${CLAUDE_PLUGIN_ROOT}/agents/ingest-linear.md and follow it exactly.

Scope: {scope}
State filter: {state_filter or "none"}
```

**Context:** Spawn a `learning-loop:ingest-context` agent (`subagent_type` matches the agent name). Resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch:

```
Read your agent definition at ${CLAUDE_PLUGIN_ROOT}/agents/ingest-context.md and follow it exactly.

Source label: {source_label or "pasted text"}
Text:
{pasted_text}
```

**Repo:** Coordinator-driven flow (Steps 2.1-2.4 below). Single-pass behaviour from earlier ships moves under Step 2.4a; deep fan-out is Step 2.4b.

#### Step 2.1: Profile (no LLM call)

Generate a structured profile of the repo via cheap Bash. The output drives the depth gate in Step 2.3.

```bash
PROFILE_JSON=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest-profile.mjs" "{repo_path}")
PROFILE_PATH="${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-profile.json"
echo "$PROFILE_JSON" > "$PROFILE_PATH"
```

#### Step 2.2: ygrep index (best-effort)

```bash
if command -v ygrep >/dev/null 2>&1; then
  ygrep index "{repo_path}" >/dev/null 2>&1 || true
  SMOKE=$(ygrep "function" -C "{repo_path}" --json --limit 1 2>/dev/null | head -c 50)
  if [ -z "$SMOKE" ]; then
    rm -rf "$HOME/Library/Application Support/ygrep/indexes/"* 2>/dev/null || true
    ygrep index "{repo_path}" >/dev/null 2>&1 || true
  fi
  YGREP_AVAILABLE=true
else
  YGREP_AVAILABLE=false
fi
```

Failure is non-fatal. Mappers fall back to `Grep`+`Glob`.

#### Step 2.3: Depth gate

If `--deep` flag was passed: skip the gate, set `TIER=parallel`, `REASON="--deep override"`.

Else: spawn a `general-purpose` Task subagent with the gate prompt:

```bash
GATE_PROMPT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest-depth-gate.mjs" build-prompt "$PROFILE_JSON")
```

Pass the prompt verbatim, instruct the agent to use Haiku-class reasoning and return only the JSON. Then parse:

```bash
GATE_RESULT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest-depth-gate.mjs" parse-response "<agent text>")
TIER=$(echo "$GATE_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin)['tier'])")
REASON=$(echo "$GATE_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin)['reason'])")
```

#### Step 2.4a: tier=single → existing single-pass flow

Spawn a `learning-loop:ingest-repo` agent (`subagent_type` matches the agent name). Resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch (see `agents/_skills/vault-io.md` → Placeholders), so the agent can read its shared `_skills/` contracts:

```
Read your agent definition at ${CLAUDE_PLUGIN_ROOT}/agents/ingest-repo.md and follow it exactly.

Repo path: {repo_path}
```

The agent returns `confirmed_insights` JSON. Skip to Step 3.

#### Step 2.4b: tier=parallel → fan-out

1. Compute slug:
   ```bash
   ORIGIN_URL=$(git -C "{repo_path}" remote get-url origin 2>/dev/null || echo "")
   SLUG=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest-slug.mjs" "{repo_path}" "$ORIGIN_URL")
   ```

2. Resolve vault root and create staging directory:
   ```bash
   VAULT_ROOT=$(node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs').then(m => console.log(m.getVaultPath()))")
   mkdir -p "${VAULT_ROOT}/_ingested-repos/${SLUG}"
   ```

3. Write defense-in-depth policy file (no-op if hooks don't fire on subagents - see plan probe outcome 2026-05-15):
   ```bash
   node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/ingest-policy.mjs').then(m => m.writePolicy(process.env.CLAUDE_PLUGIN_DATA, process.env.CLAUDE_CODE_SESSION_ID, { vault_root: '${VAULT_ROOT}', ingested_repo_slug: '${SLUG}', allowed_bash_prefixes: ['ygrep ', 'ygrep index ', 'git log', 'git rev-parse', 'git status', 'ls ', 'find ', 'grep ', 'wc ', 'cat '], allowed_write_dir_prefix: '_ingested-repos/${SLUG}/', expires_at_seconds: 1800 }))"
   ```

4. Snapshot vault git status (post-fanout audit baseline):
   ```bash
   GIT_BASELINE=$(cd "${VAULT_ROOT}" && git status --porcelain | sort)
   ```

5. Spawn 5 mapper agents in ONE assistant message (single message, 5 concurrent Task tool calls). Each gets `subagent_type` equal to the agent's frontmatter name. Per-mapper prompt template:

   ```
   You are the {focus} mapper for ingest run. Read your agent definition at ${CLAUDE_PLUGIN_ROOT}/agents/ingest-mapper-{focus}.md and follow it exactly.

   Inputs:
   - repo_path: {repo_path}
   - repo_slug: {SLUG}
   - vault_root: {VAULT_ROOT}
   ```

   The 5 `subagent_type` values: `learning-loop:ingest-mapper-stack`, `learning-loop:ingest-mapper-arch`, `learning-loop:ingest-mapper-conventions`, `learning-loop:ingest-mapper-domain`, `learning-loop:ingest-mapper-state`.

6. Collect 5 ack JSONs. Validate each: `focus`, `status` required; the 4 durable mappers also require `doc_path`. The state sidecar's ack IS the inline JSON to pass to synthesizer in step 10 - capture the full sidecar response into `STATE_SIDECAR_JSON` (or set to `null` if status="failed").

6.5. Write partial `METADATA.json` (mapper_acks filled, synthesizer status="pending") so the post-fanout audit's expectation of `METADATA.json` in the staging dir is satisfied. Step 12 below overwrites it with the synthesizer outcome.

7. Run post-fanout audit:
   ```bash
   SUCCESSFUL_FOCUSES_JSON='["stack","arch","conventions","domain"]'  # filter to status=ok
   AUDIT=$(node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/ingest-postfanout-audit.mjs').then(m => console.log(JSON.stringify(m.auditPostFanout('${VAULT_ROOT}', '${SLUG}', $SUCCESSFUL_FOCUSES_JSON))))")
   ```
   Parse `AUDIT.ok`. If false: surface to user, log to provenance.

8. Capture git status diff:
   ```bash
   GIT_AFTER=$(cd "${VAULT_ROOT}" && git status --porcelain | sort)
   GIT_DIFF_OUTSIDE=$(diff <(echo "$GIT_BASELINE") <(echo "$GIT_AFTER") | grep -v "_ingested-repos/${SLUG}/" || true)
   ```
   Files modified outside `_ingested-repos/${SLUG}/` are logged to provenance.

9. Branch on successful-focus count:
   - count=4: spawn synthesizer with all 4 docs, `missing_axes: []`
   - count=3: spawn synthesizer with 3 docs + `missing_axes: ["<focus>"]`
   - count≤2: abort fan-out. Use `AskUserQuestion`: "Only N of 4 mappers succeeded. (a) retry failed mappers, (b) fall through to single-pass with existing surface profile, (c) cancel"

10. Spawn `learning-loop:ingest-synthesizer` (subagent_type matches the agent's frontmatter name):

    ```
    Read your agent definition at ${CLAUDE_PLUGIN_ROOT}/agents/ingest-synthesizer.md and follow it.

    Inputs:
    - vault_root: {VAULT_ROOT}
    - repo_slug: {SLUG}
    - stack_doc_path: {VAULT_ROOT}/_ingested-repos/{SLUG}/STACK.md
    - arch_doc_path: {VAULT_ROOT}/_ingested-repos/{SLUG}/ARCH.md
    - conventions_doc_path: {VAULT_ROOT}/_ingested-repos/{SLUG}/CONVENTIONS.md
    - domain_doc_path: {VAULT_ROOT}/_ingested-repos/{SLUG}/DOMAIN.md
    - state_json: {STATE_SIDECAR_JSON}
    - missing_axes: {ARRAY}

    Return the confirmed_insights JSON.
    ```

11. Parse synthesizer JSON. If `durable_insights.length === 0`:
    > Use `AskUserQuestion`: "Synthesizer produced 0 durable insights from this repo. Reason given: '{synthesizer_note}'. Proceed with project-state only (auto-memory write) or abort?"

12. Write `${VAULT_ROOT}/_ingested-repos/${SLUG}/METADATA.json` with all collected acks + synthesizer outcome (see spec Section "METADATA.json" for shape).

13. Clear policy file:
    ```bash
    node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/ingest-policy.mjs').then(m => m.clearPolicy(process.env.CLAUDE_PLUGIN_DATA, process.env.CLAUDE_CODE_SESSION_ID))"
    ```

14. Pass synthesizer's `confirmed_insights` JSON to Step 3 (existing preview flow).

#### Provenance log

Append a run entry at the start of Step 5.5 — every ingest path reaches that step, including memory-only runs whose vault worklist is `none` (those skip Step 5a entirely) — or on any abort path:

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/ingest-provenance.mjs').then(m => m.appendIngestEvent(process.env.CLAUDE_PLUGIN_DATA, { slug: '${SLUG}', tier: '${TIER}', gate_reason: '${REASON}', override: '${OVERRIDE:-null}', mapper_summary: <ACK_JSONS>, synthesizer: <SYNTH_RESULT>, duration_seconds: <ELAPSED>, ygrep_used: <BOOL>, audit_ok: <BOOL>, git_diff_outside: <ARRAY> }))"
```

### Step 3: Preview

Take the insights JSON returned by the agent.

Read `${CLAUDE_PLUGIN_ROOT}/agents/_skills/preview-format.md` and format the preview accordingly.

Display the preview to the user. Wait for confirmation via `AskUserQuestion`:

> Type numbers to exclude (e.g., "drop vault 2, 4"), or "all" to confirm everything, or "none" to cancel.

### Step 4: Filter

Parse the user's response:
- "all" → keep everything
- "none" → cancel, print "Ingest cancelled." and stop
- "drop vault 2, 4" → remove vault items 2 and 4
- "drop memory 1" → remove memory item 1
- Any other exclusion pattern → parse best-effort

### Step 5: Route

Determine the project name:
- Linear: infer from the most common project in the tickets, or ask
- Repo: derive from the repo directory name
- Context: ask via `AskUserQuestion` if not obvious

Spawn a `general-purpose` agent with prompt (resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch — see `agents/_skills/vault-io.md` → Placeholders):

```
Read the agent skill at ${CLAUDE_PLUGIN_ROOT}/agents/_skills/route-output.md and follow it exactly.

Project name: {project_name}
Vault path: {{VAULT}}/
Memory path: {memory_path}

Confirmed insights:
{confirmed_insights_json}
```

The routing agent writes auto-memory and the project index itself, but it cannot spawn note-writer (subagents cannot spawn subagents). It returns a **Vault worklist**; executing it is this skill's job — same pattern as `/inbox`.

### Step 5a: Execute the Vault Worklist

If the routing agent's `### Vault worklist` is `none`, skip to Step 5.5.

Split the worklist by the `artefact` flag:

**Artefact rows (`artefact: true`)** are project documents (interview prep, client briefs, evidence bundles), not atomic insights — vault voice and promote-gate grading add nothing, so they do NOT go through note-writer. Write each one yourself with the `Write` tool: destination is the row's `4-projects/<slug>/` folder, filename a kebab-case slug of the insight title, content the row's research body under the insight as the `#` title. Main-thread Writes fire the PostToolUse hooks natively — do not include these paths in the hook replay below.

**Insight rows (`artefact: false`)**: for each, spawn a `note-writer` agent (`subagent_type: "learning-loop:note-writer"`) with the row's **insight**, **research**, **destination**, and **related_notes**. Resolve all path placeholders to literal absolute paths (see `agents/_skills/vault-io.md` → Placeholders). Dispatch independent rows in ONE message with multiple Agent tool calls — they run in parallel.

When the fan-out completes, reconcile before replaying: match each insight row to a written path in the note-writer reports. Retry any unmatched row (agent failed, errored, or returned no path) once with a fresh note-writer dispatch. Rows still unwritten after the retry must not be dropped silently — a user-approved insight with no note is a data loss — carry each one's insight title and a one-line body into Step 6 as "failed to write — re-capture manually".

Then replay the PostToolUse hook chain on every path note-writer reported — subagent Writes bypass it (see `skills/_shared/hook-replay.md`, targeted variant). If a row's worklist destination and note-writer's reported path disagree, use the reported path:

```bash
printf '%s\n' "$WRITTEN_PATH_1" "$WRITTEN_PATH_2" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin
```

Surface any `failures` from the JSON summary in Step 6.

### Step 5.5: Post-Batch Sweep

First, for repo parallel-tier runs, append the provenance run entry (see "Provenance log" under Step 2.4b) — it is anchored here, not in Step 5a, so memory-only runs that skipped the worklist still log it.

The routing agent in Step 5 is a subagent whose own Write/Edit calls (auto-memory, project index) bypass PostToolUse, and Step 5a's targeted replay covers only the paths note-writer reported. This sweep is the backfill safety net for anything missed.

Run the unlinked-body sweep from `${CLAUDE_PLUGIN_ROOT}/skills/_shared/hook-replay.md` (read it and execute; seed the candidate list with any subagent-written paths not already replayed in Step 5a — e.g. the routing agent's project-index writes detected via git — then it backfills via the unlinked-body walk and replays the hook chain on each). Idempotent: safe on already-hooked notes.

Report any failures in Step 6. Typical cost: <1s per file, usually 0–5 candidates per batch.

### Step 5.6: Upstream Refinement

**Behind a flag for the first ship.** Skip this step entirely unless the user invoked `/ingest` with `--refine` in the args. Default off because ingest batches can produce many candidates and we want cost visibility before promoting to default-on.

When the Step 5a fan-out writes new vault notes, those notes may sharpen, qualify, or extend existing claims. This step finds those pairs, dispatches the `refinement-proposer` agent, validates the output, and applies edits via `Write`. Same flow as `/reflect` Step 4.6.

#### 5.6.a: Detect new vault notes from this ingest

Step 5a's note-writer agents report their written paths, but the routing subagent's own writes don't return paths. Use `git diff` against HEAD to detect ALL new files in the vault since ingest started:

All temp files in 5.6 use a session-keyed prefix so parallel `/ingest` invocations don't race. Each bash block re-derives the same paths from `$CLAUDE_CODE_SESSION_ID` (stable across the session); when passing paths into agent prompts or other tools, substitute the resolved literal value.

```bash
LL_TMP_PREFIX="${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-ingest"
VAULT_ROOT=$(node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs').then(m => console.log(m.getVaultPath()))")
REPO_ROOT=$(git -C "$VAULT_ROOT" rev-parse --show-toplevel)
VAULT_REL=$(node -e "const p=require('path'); console.log(p.relative(process.argv[1], process.argv[2]))" "$REPO_ROOT" "$VAULT_ROOT")
cd "$REPO_ROOT"
PREFIX="${VAULT_REL:+$VAULT_REL/}"
git diff --name-only --diff-filter=A HEAD -- "${PREFIX}0-inbox/" "${PREFIX}1-fleeting/" "${PREFIX}2-literature/" "${PREFIX}3-permanent/" "${PREFIX}5-maps/" \
  | sed "s|^|$REPO_ROOT/|" \
  > "${LL_TMP_PREFIX}-new-notes.txt"
```

If the file is empty, skip the rest of 5.6 and report `Refinement: 0 new notes from ingest`.

**Caveat**: this assumes the vault was at clean HEAD state when ingest started. If the user had uncommitted vault work, it may include unrelated files. The hard cap on LLM calls (50, below) bounds the worst case.

#### 5.6.b: Build candidate pairs (capped)

```bash
LL_TMP_PREFIX="${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-ingest"
node "${CLAUDE_PLUGIN_ROOT}/scripts/refinement-candidates.mjs" --stdin --pairs-out "${LL_TMP_PREFIX}-refinement-pairs.json" < "${LL_TMP_PREFIX}-new-notes.txt" > /dev/null
```

If the resulting pairs JSON has more than **50** entries, truncate to the first 50 (highest cosine first since the candidate script sorts that way) and append the deferred remainder to `${CLAUDE_PLUGIN_DATA:-$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" PLUGIN_DATA)}/refinement-deferred.jsonl` as one JSON object per line. The deferred queue is drained by the next `/reflect` invocation (which has no batch cap) — see `skills/reflect/steps/refinement.md` 4.6.a.

```bash
LL_TMP_PREFIX="${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-ingest"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" PLUGIN_DATA)}"
mkdir -p "$DATA_DIR"
CLAUDE_PLUGIN_DATA="$DATA_DIR" LL_PAIRS_PATH="${LL_TMP_PREFIX}-refinement-pairs.json" python3 - <<'PY'
import json, os
pairs_path = os.environ["LL_PAIRS_PATH"]
pairs = json.load(open(pairs_path))
keep, defer = pairs[:50], pairs[50:]
json.dump(keep, open(pairs_path, "w"), indent=2)
data_dir = os.environ["CLAUDE_PLUGIN_DATA"]
defer_path = os.path.join(data_dir, "refinement-deferred.jsonl")
if defer:
    with open(defer_path, "a") as f:
        for p in defer: f.write(json.dumps(p) + "\n")
    print(f"deferred {len(defer)} pairs to {defer_path}")
PY
```

#### 5.6.c: Dispatch, validate, present, apply

Same as `${CLAUDE_PLUGIN_ROOT}/skills/reflect/steps/refinement.md` sub-steps 4.6.b through 4.6.f. Spawn `refinement-proposer` with the pairs file, validate via `refinement-validate.mjs`, present preview-format table, apply approved edits via `Write`, route counterpoints via `Edit`, emit provenance events.

The `subagent_type` is `learning-loop:refinement-proposer`. The `pairs_file` is the resolved value of `${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-ingest-refinement-pairs.json` (substitute the literal path before passing to the agent). Likewise for the agent output (`-refinement-agent-output.json`) and validated output (`-refinement-validated.json`). Use `AskUserQuestion` for batch confirmation.

#### 5.6.d: Cleanup

```bash
LL_TMP_PREFIX="${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-ingest"
rm -f "${LL_TMP_PREFIX}-new-notes.txt" "${LL_TMP_PREFIX}-refinement-pairs.json" "${LL_TMP_PREFIX}-refinement-agent-output.json" "${LL_TMP_PREFIX}-refinement-validated.json"
```

Report counts in Step 6.

### Step 6: Summary

Display the routing agent's summary, the Step 5a worklist results (notes written with final paths, artefacts written directly, and any rows that failed both note-writer attempts — list each failed insight's title and body so the user can re-capture it), the sweep results, and the refinement results (if `--refine` was passed). Done.

## Key Principles

- **The skill is the UX layer.** Agents fetch and extract. The skill previews, routes, and runs the note-writer fan-out (subagents cannot spawn subagents).
- **Preview before write.** Never write to memory or vault without user confirmation.
- **Merge, don't overwrite.** Auto-memory files preserve manually-added context.
- **Insight notes go through note-writer.** Voice consistency matters. Artefact rows are the exception: they are project documents, written directly by this skill.
- **One source per invocation.** To ingest from multiple sources, run the skill multiple times.
