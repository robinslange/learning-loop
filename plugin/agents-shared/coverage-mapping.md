# Coverage Mapping

Map existing vault notes against a topic's knowledge landscape. Find what's missing.

## Process

1. Take the vault notes on the topic (from vault-scout).
2. Take the research landscape (from researcher).
3. Identify subtopics present in research but absent from the vault.
4. Rank gaps by relevance to the topic.

## Gap Ranking

| Rank | Criteria |
|------|----------|
| **Central** | Core subtopic — the vault's understanding is incomplete without it |
| **Adjacent** | Related subtopic that would strengthen understanding |
| **Peripheral** | Interesting but not essential to the topic |

## Framing Gaps

Beyond missing subtopics, check whether the vault explores only one framing of a multifaceted topic:

- Does the vault only cover mechanism but not outcomes?
- Does it only cover benefits but not risks?
- Does it only cover one school of thought?
- Does it only cover one population or context?

These are perspective absences, not just topic absences.

## Output

```
### Coverage Map: [topic]

**Covered** (N notes):
- [subtopic]: [[note-1]], [[note-2]]
- [subtopic]: [[note-3]]

**Missing — Central**:
- [subtopic]: [why it matters]

**Missing — Adjacent**:
- [subtopic]: [why it matters]

**Framing gaps**:
- [the vault explores X through lens A but never through lens B]
```

## Rules

- Rank honestly. Not every gap is central.
- Framing gaps are often more important than missing subtopics.
- Don't inflate gaps. If the vault has good coverage, say so.
