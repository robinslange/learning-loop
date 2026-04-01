# Counter-Argument Linking

Detects when a note challenges an existing vault claim and creates bidirectional links. Any agent creating notes reads this skill to connect challenges to the notes they challenge.

## When to Use

- **Note-writer:** After generating a note, before writing to disk.
- **Inbox triage:** When assessing notes that may be counter-arguments to existing permanent notes.
- **Deepen/gaps:** When research surfaces contradictions with existing vault content.

## Detection

A note is a counter-argument when its title or body directly challenges a claim in an existing note. Common patterns:

| Pattern | Example |
|---------|---------|
| Negation of existing title | Existing: "theanine-calms-by-X" → New: "theanine-has-excitatory-nmda-actions" |
| "X is not Y" / "X fails" / "X overstates" | "gaba-is-primary-in-anxiety-pharmacology" challenges "anxiety-is-excess-excitation-not-deficient-inhibition" |
| Qualification / boundary condition | "empty-stomach-theanine-is-untested-theory" qualifies "empty-stomach-maximizes-theanine-at-both-gates" |
| Alternative explanation | "glicko2-has-no-opponent-use-irt-instead" challenges "glicko2-cognitive-self-tracking" |

## Process

### Step 1: Check for challenge signal

Scan the note's title and first paragraph for:
- Direct negation of a concept in an existing note title
- Words: "not", "fails", "overstates", "insufficient", "untested", "actually", "instead", "contrary"
- Reference to the same mechanism/compound/concept with opposite conclusion

If no signal, stop. Most notes are not counter-arguments.

### Step 2: Find the target note

Use vault-search to find the note being challenged:

```bash
node {{PLUGIN}}/scripts/vault-search.mjs search "<challenged concept>" --rerank
```

Also try `Glob` for filename matches. The target is usually in `3-permanent/` or `1-fleeting/`.

If no clear target is found, the note is not a counter-argument — it's just a different perspective. Stop.

### Step 3: Add forward link

In the new note, add a link to the target with a challenge framing:

```markdown
Challenges [[target-note-name]] — brief reason why.
```

Place this after the body, before Sources. Use "Challenges", "Qualifies", or "Complicates" depending on the relationship:
- **Challenges:** Direct contradiction
- **Qualifies:** Adds boundary conditions or exceptions
- **Complicates:** Introduces nuance without negating

### Step 4: Add backlink

Edit the target note to add a link back to the new note. Append after existing links:

```markdown
[[new-note-name]] — counter-evidence / qualification.
```

Use the `Edit` tool to append. Do not rewrite the target note's body or change its conclusion — the target note represents the original claim. The link lets the reader find the challenge.

## Rules

- **Never suppress the counter-argument.** If research contradicts a vault claim, the contradiction gets captured. The vault holds knowledge, not confirmation.
- **Don't merge counter-arguments into the note they challenge.** Keep them separate. A counter-argument is its own atomic insight.
- **Tag with the same topic tags** as the target note so they cluster together in search.
- **Don't overdetect.** Two notes about the same topic with different angles are not counter-arguments. Only flag when the new note's conclusion contradicts or materially qualifies the target's conclusion.
