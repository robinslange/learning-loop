# Research Scaling

Determine how much research effort a topic or note actually needs. Scale effort to maturity, not ambition.

## When to Use

- At the start of any research phase (discovery, deepen, literature context gathering)
- After overlap-check classifies the topic
- When deciding how many searches to run or how deep to go

## Scaling Matrix

| Input Signal | Research Level | Search Effort | Focus |
|---|---|---|---|
| Inbox note, no sources, shallow | **Heavy** | 6-10 searches, primary sources | Fill knowledge gaps from scratch |
| Fleeting note, some sources | **Medium** | 3-5 searches, targeted | Strengthen weak points |
| Permanent note, well-sourced | **Light** | Vault context only | Check for staleness, add connections |
| Topic with zero vault coverage | **Exploratory** | 2-3 landscape searches, then reassess | Orient before committing to depth |
| Overlap-check returned partial | **Targeted** | 3-5 searches on uncovered angle only | Fill the specific gap, skip covered ground |

## Maturity Signals

Read these from the note or topic state:

| Signal | Indicates |
|---|---|
| No sources cited | Shallow — needs heavy research |
| Sources but no URLs | Medium — needs verification and linking |
| Sources with working URLs | Deep — focus on connections and staleness |
| Multiple notes on topic | Check for circular reinforcement before adding more |
| Recent `/gaps` review | Don't re-research what was just challenged |

## Cross-Validation Before Scaling

Before committing to heavy research, check the vault for circular reinforcement:

- If 3 notes all make the same claim from one source, the need isn't "more research confirming the claim" — it's "different sources providing independent evidence."
- If the vault has broad coverage but all from secondary sources, the need is "primary sources" not "more coverage."
- If the vault has deep coverage with strong sources, the need is "connections and tensions" not "more depth."

Adjust the research focus accordingly. Quantity of existing notes ≠ quality of coverage.

## Effort Boundaries

Even at heavy research level, respect practical limits:

| Depth | Max searches | Max iterations |
|---|---|---|
| Heavy | 10 | 2 rounds |
| Medium | 5 | 1 round |
| Light | 0 (vault only) | 1 pass |
| Exploratory | 3 (then reassess) | 1 round + depth gate |
| Targeted | 5 | 1 round |

After hitting the boundary, pass through the depth gate (decision-gates) to determine whether more effort is justified.

## Output

```
Research scaling: [topic/note]
Maturity: [shallow | medium | deep]
Overlap: [novel | partial | redundant]
Research level: [heavy | medium | light | exploratory | targeted]
Focus: [what specifically to research]
Searches allocated: [N]
```

## Rules

- More notes ≠ more mature. Check source quality, not count.
- Circular reinforcement masquerades as depth. Detect it before scaling down.
- Exploratory is not shallow — it's "orient first, commit second." Always followed by a depth gate.
- Never scale up past heavy. If heavy isn't enough, the topic needs `/discovery` not `/deepen`.
- The scaling decision is made once per research phase. Don't re-scale mid-research — use the depth gate instead.
