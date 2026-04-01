# Decision Gates

Explicit checkpoints between research phases. Stop early when the signal says stop. Go deeper when the signal says go. Agents don't just flow through — they decide whether to continue.

## When to Use

Any agent with multi-phase research. Insert gates between phases to avoid wasted effort.

## Gates

### Novelty Gate

**When:** After overlap-check, before committing to research.

| Signal | Decision |
|---|---|
| overlap-check returns **novel** | Pass — proceed with full research |
| overlap-check returns **partial overlap** | Pass — proceed with narrowed scope (skip what's covered) |
| overlap-check returns **redundant** | Fail — stop. Link to existing note. Report why. |
| overlap-check returns **upstream/downstream** | Pass — proceed but cross-link, don't restate |

**On fail:** Don't research. Tell the caller what already exists and suggest linking instead.

### Depth Gate

**When:** After initial research, before scaling up effort.

| Signal | Decision |
|---|---|
| Research found significant gaps in vault coverage | Pass — scale up to fill gaps |
| Research found minor additions to existing coverage | Pause — enough to update, not enough to justify deep dive |
| Research found nothing new beyond vault | Fail — stop. Vault coverage is sufficient. |
| Cross-validation found conflicts | Pass — conflicts need resolution, go deeper |

**On pause:** Present what was found. Ask the caller (or user) whether to continue or write with what's available.

**On fail:** Report that coverage is already strong. Suggest `/gaps` if the user wants to stress-test it.

### Confidence Gate

**When:** After cross-validation, before writing or promoting.

| Signal | Decision |
|---|---|
| Findings are novel or extensions, well-sourced | Pass — write/promote |
| Findings have unresolved conflicts | Conditional pass — write, but flag tensions. Suggest `/gaps` for follow-up |
| Findings are mostly circular reinforcement | Fail — don't write. Flag the circularity. Suggest finding independent sources |
| Sources are weak or unverifiable | Fail — don't promote. Keep in inbox with uncertainty flagged |

**On conditional pass:** Write the note but include a `needs-review` tag or uncertainty markers.

**On fail:** Report why confidence is low. Suggest specific next steps (find independent sources, verify claims, etc.)

## Integration Pattern

Agents reference gates by name at the relevant point in their process:

```
### Step N: [Phase name]
Run [gate-name] gate (decision-gates).
If fail: [specific fail action]. Stop.
If pass: proceed to Step N+1.
```

## Rules

- Gates are checkpoints, not bureaucracy. A gate that always passes is useless — remove it.
- Every fail outcome has a recommended action. "Stop" alone is not enough.
- Pause outcomes exist for depth gate only. The others are binary.
- Gates don't make final decisions about note quality — that's promote-gate's job. Decision gates control research effort, not note routing.
