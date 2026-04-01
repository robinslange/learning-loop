# Overlap Check

Before investing research effort, determine if existing knowledge already covers this concept — possibly via a different name, path, or framing.

## When to Use

- Before researching a new topic (discovery-researcher, note-deepener)
- Before capturing a new source (literature-capturer)
- Before adding a new entry to any catalog or database (compound seeder, etc.)

## Process

1. **Direct search.** Search vault for the topic by name — semantic (`vault-search.mjs search --rerank`) and keyword (`mgrep`).
2. **Indirect search.** Search for concepts that cover the same ground via a different path. Trace upstream and downstream:
   - What is this a component of?
   - What does this produce or lead to?
   - What other names exist for this concept?
   - What broader category contains it?
3. **Classify** the relationship between the new topic and existing coverage.
4. **Return** the classification, overlapping notes, and what's genuinely new.

## Classification

| Classification | Meaning | Action |
|---|---|---|
| **Novel** | No existing coverage — topic is new to the vault | Proceed with full research |
| **Partial overlap** | Related notes exist but cover a different angle or level | Proceed — focus research on the uncovered angle |
| **Redundant** | Already covered, possibly under a different name | Stop — link to existing note instead |
| **Upstream/downstream** | Existing note covers a parent or child concept | Proceed — but cross-link and avoid restating what's already captured |

## Dependency Tracing

Don't stop at name matches. Ask:

- Does something upstream already address this? (A note on "cholinergic signaling" may already cover "alpha-7 nAChR activation")
- Does something downstream already capture the practical implication? (A note on "morning light exposure improves sleep" may cover "melanopsin sensitivity")
- Is this a different framing of the same insight? (A "spaced repetition beats massed practice" note and a "cramming doesn't work" note are the same claim from opposite directions)

## Output

```
Overlap check: [topic]
Classification: [novel | partial | redundant | upstream/downstream]
Related notes: [[note-1]], [[note-2]]
What's new: [the specific angle or content not yet covered]
Recommendation: [proceed | proceed with focus on X | stop and link]
```

## Rules

- Redundancy is not failure. Catching it early saves wasted research.
- Partial overlap is the most common result. Specify what's already covered so research can skip it.
- When in doubt, classify as partial and let the decision gate sort it out.
