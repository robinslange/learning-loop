# Blindspot Detection

Find what the vault doesn't know it doesn't know. Gaps challenges existing claims. Blindspots find missing territory.

## Input

- **vault_notes**: What the vault covers (from vault-scout)
- **domain_survey**: Comprehensive landscape of the domain (from domain survey researcher)

## Process

1. Extract the domain survey's subtopic structure — every major area, framework, method, debate.
2. For each subtopic, check whether ANY vault note touches it. Partial coverage counts as "partially covered."
3. Classify each missing subtopic using the coverage-mapping ranking (central / adjacent / peripheral).
4. Check for **framing blindspots** — the vault may cover a topic but only through one lens.

## Framing Blindspots

These are more dangerous than missing subtopics because they create false confidence.

| Pattern | Example |
|---------|---------|
| Mechanism-only | Vault explains HOW something works but never WHETHER it works in practice |
| Benefits-only | Vault covers positive effects but never risks, side effects, or failure modes |
| Single-population | Vault assumes healthy adults but the evidence comes from clinical populations |
| Single-method | Vault uses one statistical approach but the field debates several |
| Temporal | Vault covers acute effects but not chronic, or vice versa |
| Scale | Vault covers individual-level but not population-level, or vice versa |

## Output

```
### Blindspots

**Domain territory not in vault — Central:**
- [subtopic]: [what the field covers, why it matters for the vault's goals]

**Domain territory not in vault — Adjacent:**
- [subtopic]: [what the field covers, why it might matter]

**Framing blindspots:**
- The vault covers [topic] through [lens A] but never [lens B]
  [Why this matters — what could be missed]

**Well-covered areas:**
- [subtopic]: [N] notes — no blindspot detected
```

## Rules

- Domain survey quality determines blindspot quality. Garbage survey = garbage blindspots.
- Not every missing subtopic is a blindspot. Only flag what matters for the vault's goals.
- Framing blindspots are often more important than missing subtopics. Prioritize them.
- Don't inflate. If the vault has strong coverage, say so.
- Distinguish "the vault hasn't explored this" from "this doesn't exist in the field." Only the first is a blindspot.
