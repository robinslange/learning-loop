# Upstream Refinement (4.6.a–4.6.g)

Executed by /reflect Step 4.6 — see SKILL.md for the trigger.

When a new vault note touches a claim already in the vault, the existing claim should be refined to incorporate the new evidence. This step finds those pairs, asks the `refinement-proposer` agent to draft edits, validates them, presents the batch for confirmation, and applies via `Write`. Contradictions route to inline counter-argument linking instead of editing the upstream body.

## 4.6.a: Build candidate pairs

Each refinement.md bash block runs in its own shell (variables do not persist across Bash tool calls), so resolve the paths once at the top of the block with `--sh` — one spawn for all of SESSION_ID/REFLECT_SCRATCH/PLUGIN_DATA, not three:

```bash
eval "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"
LL_TMP_PREFIX="${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect"
if [ -s "${LL_TMP_PREFIX}-new-notes.txt" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/scripts/refinement-candidates.mjs" --stdin --pairs-out "${LL_TMP_PREFIX}-refinement-pairs.json" < "${LL_TMP_PREFIX}-new-notes.txt" > /dev/null
else
  printf '[]' > "${LL_TMP_PREFIX}-refinement-pairs.json"
fi
```

The marker can be missing or empty on a drain-only run (Step 4.6 fired because the deferred queue is non-empty, not because this session wrote notes); start from an empty pairs file and let the deferred merge below supply the pairs.

Then drain the deferred queue left by a capped `/ingest --refine` run (ingest Step 5.6.b writes overflow pairs there as JSONL). Merge queued pairs into the pairs file, dedupe on `(new_note, candidate)`, reassign ids (the validator matches decisions to pairs by `id`; deferred entries carry stale ids from their original run), and truncate the queue:

```bash
eval "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"
LL_TMP_PREFIX="${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect"
DEFERRED="$PLUGIN_DATA/refinement-deferred.jsonl"
if [ -s "$DEFERRED" ]; then
  node -e "
    const fs = require('fs');
    const pairsPath = process.argv[1], defPath = process.argv[2];
    const pairs = JSON.parse(fs.readFileSync(pairsPath, 'utf-8'));
    const seen = new Set(pairs.map(p => p.new_note + '|' + p.candidate));
    let added = 0;
    for (const line of fs.readFileSync(defPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const p = JSON.parse(line);
      const key = p.new_note + '|' + p.candidate;
      if (!seen.has(key)) { seen.add(key); pairs.push(p); added++; }
    }
    pairs.forEach((p, i) => { p.id = i + 1; });
    fs.writeFileSync(pairsPath, JSON.stringify(pairs, null, 2));
    fs.writeFileSync(defPath, '');
    console.log('merged ' + added + ' deferred pair(s)');
  " "${LL_TMP_PREFIX}-refinement-pairs.json" "$DEFERRED"
fi
```

If the resulting refinement-pairs.json is `[]`, report `Refinement: 0 candidates in band` in Step 5 and skip 4.6.b through 4.6.f. Still run **4.6.g cleanup**: the session wrote notes (the pairs were empty because none matched an upstream claim, not because no notes exist), so their `reflect_sid` stamps must still be stripped and the marker removed. Skipping 4.6.g here would leak `reflect_sid` into the vault permanently and leave the marker for a later same-session /reflect to re-sweep. (On a drain-only run with no marker, 4.6.g's `-f` guard makes the strip a no-op; running it is still safe.)

## 4.6.b: Dispatch refinement-proposer agent

Spawn the `refinement-proposer` agent (dispatch: `skills-shared/dispatch.md`) with the prompt below. The `pairs_file` placeholder must be substituted with the resolved literal path (`${LL_TMP_PREFIX}-refinement-pairs.json` from the block above, i.e. `${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect-refinement-pairs.json`); likewise resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch (see `agents-shared/vault-io.md` → Placeholders):

```
Read the agent definition at ${CLAUDE_PLUGIN_ROOT}/agents/refinement-proposer.md and follow it exactly.

pairs_file: <resolved-pairs-path>
vault_path: {{VAULT}}/

Return the JSON response only, no commentary, no markdown fences.
```

Capture the agent's stdout response. Write it to `${LL_TMP_PREFIX}-refinement-agent-output.json` (i.e. `${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect-refinement-agent-output.json`, resolving the prefix via `resolve-paths.mjs --sh` as in the blocks above).

## 4.6.c: Validate

```bash
eval "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"
LL_TMP_PREFIX="${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect"
node "${CLAUDE_PLUGIN_ROOT}/scripts/refinement-validate.mjs" "${LL_TMP_PREFIX}-refinement-agent-output.json" "${LL_TMP_PREFIX}-refinement-pairs.json" > "${LL_TMP_PREFIX}-refinement-validated.json"
```

The validator strips em-dashes, computes sentence delta, rejects any edit that drops or rewrites an original sentence (`sentences_removed` flag), and tags each decision with status `ok`, `oversized_warning`, or `auto_rejected`. The cleaned proposed bodies replace the agent's originals. Each edit decision also carries `validation.upstream_hash`, the sha256 of the upstream file as the validator read it, which 4.6.e uses as a stale-read guard.

## 4.6.d: Present batch for confirmation

Read the validated JSON at `${LL_TMP_PREFIX}-refinement-validated.json` (i.e. `${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect-refinement-validated.json`). Build a preview-format table from the `decisions` array:

```markdown
## Refinement Proposals (N total)

### Edits ({edit_ok} ok, {edit_oversized} oversized warnings, {edit_auto_rejected} auto-rejected)

| #   | upstream                                   | type      | Δ%  | summary                                   |
| --- | ------------------------------------------ | --------- | --- | ----------------------------------------- |
| 1   | websocket-has-no-built-in-reconnection     | extends   | 12% | Added Vercel/CF/AWS proxy timeout numbers |
| 2   | (warn) digital-signatures-prove-authorship | qualifies | 28% | Added challenge-response gap discussion   |

### Counterpoints ({counterpoint_ok})

| #   | upstream                                   | reason                                                |
| --- | ------------------------------------------ | ----------------------------------------------------- |
| 3   | concept-creep-and-diagnostic-bracket-creep | new note disputes the bracket-vs-vertical distinction |

### Auto-rejected ({edit_auto_rejected})

| #   | upstream | Δ%  | reason                                                |
| --- | -------- | --- | ----------------------------------------------------- |
| 4   | ...      | 73% | exceeded 50% body change ceiling                      |
| 5   | ...      | 4%  | removed 2 original sentences (edits must be additive) |

**Actions**: type `apply all` to apply every ok + oversized item, `apply ok` to apply only `ok` items, `apply N M` for specific IDs, `diff N` to print the unified diff for one item, or `none` to cancel.
```

Use `AskUserQuestion` for the action selection.

If the user types `diff N`, print the unified diff between the upstream's current body and the validated `proposed_body` for decision N, then re-prompt.

## 4.6.e: Apply approved edits

For each decision in the approved set:

- **edit**: three sub-steps, in order:
  1. **Stale-read guard.** Re-read `upstream_path` immediately before applying and compare its hash against the decision's `validation.upstream_hash`:
     ```bash
     node -e "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "<upstream_path>"
     ```
     On mismatch, do NOT Write. The upstream changed between validation and apply — hook-appended backlinks from an earlier apply in this same loop, a parallel session, or a user edit during the 4.6.d approval wait — and the validated `proposed_body` was derived from the stale read, so writing it would silently erase those changes. Skip the decision and report it as `stale — upstream changed since validation; this refinement was dropped (the new note still stands on its own)`. There is no retry: pairs are built from this session's new-notes marker, which 4.6.g consumes, so a later /reflect will not regenerate the pair. Do not re-validate and apply anyway: re-running the validator cannot merge the concurrent change into a stale proposal. (This mirrors /rewrite's read-immediately-before-mutating guard.)
  2. **Provenance stamp.** The agent is forbidden from touching frontmatter or citing itself (refinement-proposer RULE 4); the driver owns provenance because the driver does the Write. Modify the validated `proposed_body` before writing:
     - Merge the new note's `source:` frontmatter entries into the upstream frontmatter's `source:` list: create the key if absent, keep the upstream's existing entries first, skip entries already present.
     - Append ` ([[<new-note-stem>]])` to the end of the paragraph the edit touched (the lines that differ from the upstream), unless the body already wikilinks the new note.
       These additions happen after validation, so they cannot trip the validator's frontmatter or sentence checks. Never re-run `refinement-validate.mjs` on a stamped body — it would flag the driver's own additions as violations.
  3. **Write** the stamped body to `upstream_path` using the `Write` tool. The post-write hook chain re-fires (autolink, edge-infer, provenance).
- **counterpoint**: append `new_note_link_text` to the new note's body via `Edit`, and append `upstream_link_text` to the upstream's body via `Edit`. Do NOT modify the upstream's claim. Both edits should append to the body, not modify existing lines. Skip if a link with the same target already exists in either file.
- **auto_rejected**: never apply. Log only.
- **pass**: never apply. Log only.

## 4.6.f: Emit provenance

For each applied refinement:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"refinement-proposer","skill":"reflect","action":"refinement-applied","target":"<upstream-path>","new_note":"<new-note-path>","subtype":"<edit_subtype>","cosine":<cosine>}'
```

For counterpoints emit `action: "counterpoint-linked"`. For auto-rejected emit `action: "refinement-rejected"` with `reason: "oversized"` or `reason: "sentences_removed"` per the validation flag. For edits skipped by the 4.6.e stale-read guard emit `action: "refinement-skipped"` with `reason: "stale"`.

## 4.6.g: Cleanup

```bash
eval "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"
LL_TMP_PREFIX="${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect"

# Strip the transient reflect_sid stamp from every note this session tracked
# (the marker holds their absolute paths). Removing it here keeps the field
# from leaking into the permanent vault while still having served its Step 4.4
# attribution purpose. strip-reflect-sid.mjs is FRONTMATTER-scoped (a body line
# starting with reflect_sid: is left intact), idempotent, and write-only-if-
# changed; it skips missing paths. One node pass for the whole list.
if [ -f "${LL_TMP_PREFIX}-new-notes.txt" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/scripts/strip-reflect-sid.mjs" --stdin < "${LL_TMP_PREFIX}-new-notes.txt"
fi

rm -f "${LL_TMP_PREFIX}-new-notes.txt" "${LL_TMP_PREFIX}-refinement-pairs.json" "${LL_TMP_PREFIX}-refinement-agent-output.json" "${LL_TMP_PREFIX}-refinement-validated.json"
```

Report counts in Step 5: `Refinement: N edits applied, M counterpoints linked, K passed, J auto-rejected, S skipped stale`.
